import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { z } from "zod";

import type {
  ToolDefinition,
  ToolError,
  ToolExecutionOptions,
} from "../core/contracts.js";
import {
  issueFileVersionToken,
  matchesFileVersionToken,
  sameFileVersion,
  toFileVersion,
} from "./file-version.js";
import type {
  RuntimeTool,
  ToolApprovalPreparation,
  ToolOutcome,
} from "./tool.js";
import { toolError } from "./tool.js";

const MAX_VERSION_LENGTH = 256;
const MAX_AMBIGUOUS_MATCHES = 5;
const MAX_MATCH_PREVIEW_CHARS = 240;

const editArgumentsSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe("A path relative to the workspace root."),
    old_string: z
      .string()
      .min(1)
      .describe("The exact existing text to replace. It must match exactly once."),
    new_string: z.string().describe("The exact replacement text."),
    expected_version: z
      .string()
      .trim()
      .min(1)
      .max(MAX_VERSION_LENGTH)
      .describe("The exact version returned by Read for this path."),
  })
  .strict();

export interface EditToolOptions {
  readonly workspaceRoot: string;
  readonly fileVersionSecret: Uint8Array;
}

export interface EditResult {
  readonly path: string;
  readonly replacements: 1;
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly diff: string;
  readonly verified: true;
}

interface PreparedEdit {
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly beforeVersion: string;
  readonly candidate: string;
  readonly diff: string;
  readonly mode: number;
}

type PreparedEditOutcome =
  | { readonly status: "ready"; readonly edit: PreparedEdit }
  | { readonly status: "error"; readonly error: ToolError };

export class EditTool implements RuntimeTool {
  readonly definition: ToolDefinition = {
    name: "edit",
    description:
      "Replace one exact, uniquely matching string in a UTF-8 workspace file after explicit user approval. " +
      "Call Read first and pass its exact version as expected_version. Edit rejects stale versions, missing text, and ambiguous matches. It never replaces all matches and must not be automatically retried after an uncertain failure.",
    inputSchema: z.toJSONSchema(editArgumentsSchema, {
      target: "openapi-3.0",
    }) as Record<string, unknown>,
  };

  readonly #workspaceRoot: string;
  readonly #fileVersionSecret: Buffer;

  private constructor(
    workspaceRoot: string,
    fileVersionSecret: Uint8Array,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#fileVersionSecret = Buffer.from(fileVersionSecret);
  }

  static async create(options: EditToolOptions): Promise<EditTool> {
    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(options.workspaceRoot);
      const workspaceStat = await stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error("The workspace root must be an existing directory.");
    }
    if (options.fileVersionSecret.byteLength < 32) {
      throw new Error("The file version secret must contain at least 32 bytes.");
    }
    return new EditTool(workspaceRoot, options.fileVersionSecret);
  }

  async prepareApproval(input: unknown): Promise<ToolApprovalPreparation> {
    const prepared = await this.#prepare(input);
    if (prepared.status === "error") {
      return prepared;
    }
    return {
      status: "approval_required",
      approval: {
        kind: "file_edit",
        path: prepared.edit.displayPath,
        beforeVersion: prepared.edit.beforeVersion,
        diff: prepared.edit.diff,
      },
    };
  }

  async execute(
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolOutcome> {
    if (isAborted(options.signal)) {
      return toolError("cancelled", "Edit was cancelled before it started.");
    }

    const prepared = await this.#prepare(input);
    if (prepared.status === "error") {
      return prepared;
    }
    if (isAborted(options.signal)) {
      return toolError("cancelled", "Edit was cancelled before it wrote the file.");
    }

    const writeError = await atomicReplace(
      prepared.edit.canonicalPath,
      prepared.edit.candidate,
      prepared.edit.mode,
    );
    if (writeError !== undefined) {
      return { status: "error", error: writeError };
    }

    const verified = await verifyReplacement(
      prepared.edit.canonicalPath,
      prepared.edit.candidate,
    );
    if (verified.status === "error") {
      return verified;
    }

    return {
      status: "success",
      output: {
        path: prepared.edit.displayPath,
        replacements: 1,
        beforeVersion: prepared.edit.beforeVersion,
        afterVersion: issueFileVersionToken(
          prepared.edit.displayPath,
          verified.version,
          this.#fileVersionSecret,
        ),
        diff: prepared.edit.diff,
        verified: true,
      } satisfies EditResult,
    };
  }

  async #prepare(input: unknown): Promise<PreparedEditOutcome> {
    const parsed = editArgumentsSchema.safeParse(input);
    if (!parsed.success) {
      return editError(
        "invalid_arguments",
        "Edit expects path, non-empty old_string, new_string, and the exact expected_version returned by Read.",
      );
    }
    if (parsed.data.old_string === parsed.data.new_string) {
      return editError(
        "invalid_arguments",
        "Edit requires old_string and new_string to be different.",
      );
    }

    const location = await resolveWorkspaceFile(
      this.#workspaceRoot,
      parsed.data.path,
    );
    if (location.status === "error") {
      return location;
    }

    const snapshot = await readSnapshot(location.canonicalPath);
    if (snapshot.status === "error") {
      return snapshot;
    }
    if (
      !matchesFileVersionToken(
        parsed.data.expected_version,
        location.displayPath,
        snapshot.version,
        this.#fileVersionSecret,
      )
    ) {
      return editError(
        "stale_file",
        "The file changed after Read or expected_version does not belong to this path. Read it again before editing.",
        { path: location.displayPath },
      );
    }

    const matchIndexes = findMatchIndexes(
      snapshot.content,
      parsed.data.old_string,
    );
    if (matchIndexes.length === 0) {
      return editError(
        "old_string_not_found",
        "old_string does not occur in the current file. Read it again and provide exact current text.",
        { path: location.displayPath },
      );
    }
    if (matchIndexes.length > 1) {
      return editError(
        "ambiguous_match",
        `old_string matches ${matchIndexes.length} locations. Include more surrounding text so it matches exactly once.`,
        ambiguousMatchDetails(
          location.displayPath,
          snapshot.content,
          matchIndexes,
        ),
      );
    }

    const matchIndex = matchIndexes[0];
    if (matchIndex === undefined) {
      return editError("edit_failed", "Edit could not select the unique match.");
    }
    const candidate =
      snapshot.content.slice(0, matchIndex) +
      parsed.data.new_string +
      snapshot.content.slice(matchIndex + parsed.data.old_string.length);
    return {
      status: "ready",
      edit: {
        canonicalPath: location.canonicalPath,
        displayPath: location.displayPath,
        beforeVersion: parsed.data.expected_version,
        candidate,
        diff: formatDiff(
          location.displayPath,
          snapshot.content,
          matchIndex,
          parsed.data.old_string,
          parsed.data.new_string,
        ),
        mode: snapshot.mode,
      },
    };
  }
}

async function resolveWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<
  | {
      readonly status: "ready";
      readonly canonicalPath: string;
      readonly displayPath: string;
    }
  | { readonly status: "error"; readonly error: ToolError }
> {
  if (
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath)
  ) {
    return editError(
      "path_outside_workspace",
      "Edit only accepts relative paths inside the workspace.",
    );
  }

  const lexicalPath = resolve(workspaceRoot, requestedPath);
  if (!isWithin(workspaceRoot, lexicalPath)) {
    return editError(
      "path_outside_workspace",
      "The requested path is outside the workspace.",
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return editError("not_found", "The requested file does not exist.");
    }
    return editError("edit_failed", "The requested file could not be resolved.");
  }
  if (!isWithin(workspaceRoot, canonicalPath)) {
    return editError(
      "path_outside_workspace",
      "The requested path resolves outside the workspace.",
    );
  }

  return {
    status: "ready",
    canonicalPath,
    displayPath: toPortableRelativePath(workspaceRoot, canonicalPath),
  };
}

async function readSnapshot(
  canonicalPath: string,
): Promise<
  | {
      readonly status: "ready";
      readonly content: string;
      readonly version: ReturnType<typeof toFileVersion>;
      readonly mode: number;
    }
  | { readonly status: "error"; readonly error: ToolError }
> {
  let fileHandle;
  try {
    fileHandle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const initialStat = await fileHandle.stat({ bigint: true });
    if (!initialStat.isFile()) {
      return editError("not_regular_file", "Edit only supports regular files.");
    }
    const bytes = await fileHandle.readFile();
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const finalStat = await fileHandle.stat({ bigint: true });
    const initialVersion = toFileVersion(initialStat);
    if (!sameFileVersion(initialVersion, toFileVersion(finalStat))) {
      return editError(
        "stale_file",
        "The file changed while Edit was reading it. Read it again before editing.",
      );
    }
    return {
      status: "ready",
      content,
      version: initialVersion,
      mode: Number(initialStat.mode & 0o777n),
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return editError("invalid_utf8", "Edit only supports valid UTF-8 files.");
    }
    return editError("edit_failed", "The requested file could not be read.");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function atomicReplace(
  canonicalPath: string,
  content: string,
  mode: number,
): Promise<ToolError | undefined> {
  const temporaryPath = join(
    dirname(canonicalPath),
    `.${basename(canonicalPath)}.coding-agent-${randomBytes(12).toString("base64url")}.tmp`,
  );
  let temporaryHandle;
  let renamed = false;
  try {
    temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    await temporaryHandle.writeFile(content, "utf8");
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, canonicalPath);
    renamed = true;
    return undefined;
  } catch {
    return {
      code: "write_failed",
      message:
        "Edit could not atomically replace the file. The original path was not reported as successfully changed.",
      retryable: false,
    };
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function verifyReplacement(
  canonicalPath: string,
  expectedContent: string,
): Promise<
  | {
      readonly status: "ready";
      readonly version: ReturnType<typeof toFileVersion>;
    }
  | { readonly status: "error"; readonly error: ToolError }
> {
  const snapshot = await readSnapshot(canonicalPath);
  if (snapshot.status === "error" || snapshot.content !== expectedContent) {
    return editError(
      "verification_failed",
      "The file replacement may have completed, but Runtime could not verify the final content. Read the file before taking another action.",
      { sideEffectOutcome: "unknown" },
    );
  }
  return { status: "ready", version: snapshot.version };
}

function findMatchIndexes(content: string, oldString: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= content.length - oldString.length) {
    const index = content.indexOf(oldString, offset);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    offset = index + oldString.length;
  }
  return indexes;
}

function ambiguousMatchDetails(
  path: string,
  content: string,
  indexes: readonly number[],
): unknown {
  return {
    path,
    matchCount: indexes.length,
    matches: indexes.slice(0, MAX_AMBIGUOUS_MATCHES).map((index) =>
      matchPreview(content, index)
    ),
    matchesTruncated: indexes.length > MAX_AMBIGUOUS_MATCHES,
  };
}

function matchPreview(
  content: string,
  index: number,
): {
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly previewTruncated: boolean;
} {
  const lineStart = content.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const nextNewline = content.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  const lineContent = content.slice(lineStart, lineEnd);
  const line = countOccurrences(content.slice(0, lineStart), "\n") + 1;
  const column = [...content.slice(lineStart, index)].length + 1;
  if (lineContent.length <= MAX_MATCH_PREVIEW_CHARS) {
    return {
      line,
      column,
      preview: escapeForTerminal(lineContent),
      previewTruncated: false,
    };
  }

  const indexInLine = index - lineStart;
  const start = Math.max(0, indexInLine - Math.floor(MAX_MATCH_PREVIEW_CHARS / 2));
  const end = Math.min(lineContent.length, start + MAX_MATCH_PREVIEW_CHARS);
  return {
    line,
    column,
    preview: `${start > 0 ? "…" : ""}${escapeForTerminal(
      lineContent.slice(start, end),
    )}${end < lineContent.length ? "…" : ""}`,
    previewTruncated: true,
  };
}

function formatDiff(
  path: string,
  content: string,
  matchIndex: number,
  oldString: string,
  newString: string,
): string {
  const line = countOccurrences(content.slice(0, matchIndex), "\n") + 1;
  const removed = oldString
    .split("\n")
    .map((part) => `-${escapeForTerminal(part)}`);
  const added = newString
    .split("\n")
    .map((part) => `+${escapeForTerminal(part)}`);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ line ${line} @@`,
    ...removed,
    ...added,
  ].join("\n");
}

function escapeForTerminal(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function toPortableRelativePath(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/");
}

function editError(
  code: string,
  message: string,
  details?: unknown,
): { readonly status: "error"; readonly error: ToolError } {
  return {
    status: "error",
    error: {
      code,
      message,
      retryable: false,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
