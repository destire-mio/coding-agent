import { createHash, randomBytes } from "node:crypto";
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
  type AppliedEditOperationRecord,
  type EditOperationIntent,
  type EditOperationRecord,
  type EditOperationStore,
  type PendingEditOperationRecord,
} from "./edit-operation-store.js";
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
  readonly operationStore: EditOperationStore;
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
  readonly beforeContentHash: string;
  readonly afterContentHash: string;
  readonly diff: string;
  readonly mode: number;
}

type EditInput = z.infer<typeof editArgumentsSchema>;

interface EditOperationContext {
  readonly operationId: string;
  readonly workspaceRoot: string;
  readonly input: EditInput;
  readonly intent: EditOperationIntent;
  readonly requestFingerprint: string;
}

type PreparedEditOutcome =
  | { readonly status: "ready"; readonly edit: PreparedEdit }
  | { readonly status: "error"; readonly error: ToolError };

type PendingResolution =
  | {
      readonly status: "before";
      readonly edit: PreparedEdit;
      readonly pending: PendingEditOperationRecord;
    }
  | {
      readonly status: "after";
      readonly applied: AppliedEditOperationRecord;
    }
  | { readonly status: "error"; readonly error: ToolError };

type ExistingExecutionResolution =
  | {
      readonly status: "ready";
      readonly edit: PreparedEdit;
      readonly pending: PendingEditOperationRecord;
    }
  | ToolOutcome;

interface WorkspaceFileLocation {
  readonly status: "ready";
  readonly canonicalPath: string;
  readonly displayPath: string;
}

interface FileSnapshot {
  readonly status: "ready";
  readonly content: string;
  readonly version: ReturnType<typeof toFileVersion>;
  readonly mode: number;
}

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
  readonly #operationStore: EditOperationStore;

  private constructor(
    workspaceRoot: string,
    fileVersionSecret: Uint8Array,
    operationStore: EditOperationStore,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#fileVersionSecret = Buffer.from(fileVersionSecret);
    this.#operationStore = operationStore;
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
    return new EditTool(
      workspaceRoot,
      options.fileVersionSecret,
      options.operationStore,
    );
  }

  async prepareApproval(
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolApprovalPreparation> {
    const parsed = this.#operationContext(input, options.operationId);
    if (parsed.status === "error") {
      return parsed;
    }
    const loaded = await this.#readOperation(parsed.context.operationId);
    if (loaded.status === "error") {
      return loaded;
    }
    if (loaded.record !== undefined) {
      return this.#resolveExistingForApproval(parsed.context, loaded.record);
    }

    const prepared = await this.#prepare(parsed.context.input);
    return prepared.status === "error" ? prepared : approvalFor(prepared.edit);
  }

  async recordApprovalRejection(
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolError | undefined> {
    const parsed = this.#operationContext(input, options.operationId);
    if (parsed.status === "error") {
      return parsed.error;
    }
    const context = parsed.context;
    const loaded = await this.#readOperation(context.operationId);
    if (loaded.status === "error") {
      return loaded.error;
    }
    if (
      loaded.record !== undefined &&
      !sameOperation(context, loaded.record)
    ) {
      return operationConflictError(context.operationId);
    }
    if (
      loaded.record?.state === "applied" ||
      loaded.record?.state === "cancelled" ||
      loaded.record?.state === "conflict"
    ) {
      return undefined;
    }

    try {
      await this.#operationStore.write({
        schemaVersion: 1,
        operationId: context.operationId,
        requestFingerprint: context.requestFingerprint,
        workspaceRoot: this.#workspaceRoot,
        path: context.input.path,
        state: "cancelled",
      });
      return undefined;
    } catch {
      return operationCheckpointError(
        context.operationId,
        "none",
        "The user rejected Edit, but Runtime could not save its cancelled operation record.",
      );
    }
  }

  async execute(
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolOutcome> {
    if (isAborted(options.signal)) {
      return toolError("cancelled", "Edit was cancelled before it started.");
    }

    const parsed = this.#operationContext(input, options.operationId);
    if (parsed.status === "error") {
      return parsed;
    }
    const context = parsed.context;
    const loaded = await this.#readOperation(context.operationId);
    if (loaded.status === "error") {
      return loaded;
    }

    let pending: PendingEditOperationRecord;
    let prepared: PreparedEdit;
    if (loaded.record === undefined) {
      const preparation = await this.#prepare(context.input);
      if (preparation.status === "error") {
        return preparation;
      }
      prepared = preparation.edit;
      pending = pendingRecord(context, prepared, this.#workspaceRoot);
      try {
        await this.#operationStore.write(pending);
      } catch {
        return {
          status: "error",
          error: operationCheckpointError(
            context.operationId,
            "none",
            "Edit did not write the file because Runtime could not save its pending operation record.",
          ),
        };
      }
    } else {
      const existing = await this.#resolveExistingForExecution(
        context,
        loaded.record,
      );
      if (existing.status !== "ready") {
        return existing;
      }
      pending = existing.pending;
      prepared = existing.edit;
    }

    if (isAborted(options.signal)) {
      const cancellationError = await this.recordApprovalRejection(
        input,
        options,
      );
      if (cancellationError !== undefined) {
        return { status: "error", error: cancellationError };
      }
      return toolError("cancelled", "Edit was cancelled before it wrote the file.");
    }

    const writeError = await atomicReplace(
      prepared.canonicalPath,
      prepared.candidate,
      prepared.mode,
    );
    if (writeError !== undefined) {
      return { status: "error", error: writeError };
    }

    const verified = await verifyReplacement(
      prepared.canonicalPath,
      prepared.candidate,
    );
    if (verified.status === "error") {
      return verified;
    }

    const applied: AppliedEditOperationRecord = {
      ...pending,
      state: "applied",
      afterVersion: issueFileVersionToken(
        prepared.displayPath,
        verified.version,
        this.#fileVersionSecret,
      ),
    };
    try {
      await this.#operationStore.write(applied);
    } catch {
      return {
        status: "error",
        error: operationCheckpointError(
          context.operationId,
          "applied",
          "Edit changed and verified the file, but Runtime could not save its applied operation record.",
        ),
      };
    }
    return { status: "success", output: resultFromApplied(applied) };
  }

  #operationContext(
    input: unknown,
    operationId: string | undefined,
  ):
    | { readonly status: "ready"; readonly context: EditOperationContext }
    | { readonly status: "error"; readonly error: ToolError } {
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
    if (operationId === undefined || operationId.trim().length === 0) {
      return editError(
        "missing_operation_id",
        "Core must assign Edit a stable operation identity before Runtime can execute it.",
      );
    }

    const intent: EditOperationIntent = {
      path: parsed.data.path,
      oldString: parsed.data.old_string,
      newString: parsed.data.new_string,
      expectedVersion: parsed.data.expected_version,
    };
    return {
      status: "ready",
      context: {
        operationId,
        workspaceRoot: this.#workspaceRoot,
        input: parsed.data,
        intent,
        requestFingerprint: operationFingerprint(
          this.#workspaceRoot,
          intent,
        ),
      },
    };
  }

  async #readOperation(
    operationId: string,
  ): Promise<
    | { readonly status: "ready"; readonly record?: EditOperationRecord }
    | { readonly status: "error"; readonly error: ToolError }
  > {
    try {
      const record = await this.#operationStore.read(operationId);
      return {
        status: "ready",
        ...(record === undefined ? {} : { record }),
      };
    } catch {
      return editError(
        "operation_store_failed",
        "Runtime could not read the private Edit operation record. No file was written.",
        { operationId },
      );
    }
  }

  async #resolveExistingForApproval(
    context: EditOperationContext,
    record: EditOperationRecord,
  ): Promise<ToolApprovalPreparation> {
    if (!sameOperation(context, record)) {
      return {
        status: "error",
        error: operationConflictError(context.operationId),
      };
    }
    if (record.state === "applied") {
      return {
        status: "resolved",
        outcome: { status: "success", output: resultFromApplied(record) },
      };
    }
    if (record.state === "cancelled") {
      return editError(
        "operation_cancelled",
        "This Edit operation was previously cancelled and will not be executed.",
        { operationId: context.operationId },
      );
    }
    if (record.state === "conflict") {
      return {
        status: "error",
        error: operationConflictError(context.operationId),
      };
    }

    const resolution = await this.#resolvePending(record);
    if (resolution.status === "error") {
      return resolution;
    }
    if (resolution.status === "after") {
      return {
        status: "resolved",
        outcome: {
          status: "success",
          output: resultFromApplied(resolution.applied),
        },
      };
    }
    return approvalFor(resolution.edit);
  }

  async #resolveExistingForExecution(
    context: EditOperationContext,
    record: EditOperationRecord,
  ): Promise<ExistingExecutionResolution> {
    if (!sameOperation(context, record)) {
      return {
        status: "error",
        error: operationConflictError(context.operationId),
      };
    }
    if (record.state === "applied") {
      return { status: "success", output: resultFromApplied(record) };
    }
    if (record.state === "cancelled") {
      return toolError(
        "operation_cancelled",
        "This Edit operation was previously cancelled and will not be executed.",
        false,
        { operationId: context.operationId },
      );
    }
    if (record.state === "conflict") {
      return {
        status: "error",
        error: operationConflictError(context.operationId),
      };
    }

    const resolution = await this.#resolvePending(record);
    if (resolution.status === "error") {
      return resolution;
    }
    if (resolution.status === "after") {
      return {
        status: "success",
        output: resultFromApplied(resolution.applied),
      };
    }
    return {
      status: "ready",
      edit: resolution.edit,
      pending: resolution.pending,
    };
  }

  async #resolvePending(
    pending: PendingEditOperationRecord,
  ): Promise<PendingResolution> {
    const location = await resolveWorkspaceFile(
      this.#workspaceRoot,
      pending.intent.path,
    );
    if (location.status === "error") {
      return this.#recordConflict(pending, location.error.code);
    }
    const snapshot = await readSnapshot(location.canonicalPath);
    if (snapshot.status === "error") {
      return this.#recordConflict(pending, snapshot.error.code);
    }

    const currentHash = contentHash(snapshot.content);
    if (currentHash === pending.afterContentHash) {
      const applied: AppliedEditOperationRecord = {
        ...pending,
        state: "applied",
        afterVersion: issueFileVersionToken(
          location.displayPath,
          snapshot.version,
          this.#fileVersionSecret,
        ),
      };
      try {
        await this.#operationStore.write(applied);
      } catch {
        return {
          status: "error",
          error: operationCheckpointError(
            pending.operationId,
            "applied",
            "Runtime verified that the Edit already happened, but could not save its applied operation record.",
          ),
        };
      }
      return { status: "after", applied };
    }
    if (currentHash !== pending.beforeContentHash) {
      return this.#recordConflict(pending, "file_content_changed");
    }

    const prepared = prepareFromSnapshot(
      location,
      snapshot,
      pending.intent,
      issueFileVersionToken(
        location.displayPath,
        snapshot.version,
        this.#fileVersionSecret,
      ),
    );
    if (
      prepared.status === "error" ||
      prepared.edit.afterContentHash !== pending.afterContentHash
    ) {
      return this.#recordConflict(pending, "stored_intent_mismatch");
    }
    return { status: "before", edit: prepared.edit, pending };
  }

  async #recordConflict(
    pending: PendingEditOperationRecord,
    reason: string,
  ): Promise<PendingResolution> {
    try {
      await this.#operationStore.write({
        ...pending,
        state: "conflict",
        reason,
      });
    } catch {
      return {
        status: "error",
        error: operationCheckpointError(
          pending.operationId,
          "none",
          "Runtime detected an Edit recovery conflict but could not save that state. No file was written.",
        ),
      };
    }
    return {
      status: "error",
      error: operationConflictError(pending.operationId, pending.displayPath),
    };
  }

  async #prepare(input: EditInput): Promise<PreparedEditOutcome> {
    const location = await resolveWorkspaceFile(this.#workspaceRoot, input.path);
    if (location.status === "error") {
      return location;
    }
    const snapshot = await readSnapshot(location.canonicalPath);
    if (snapshot.status === "error") {
      return snapshot;
    }
    if (
      !matchesFileVersionToken(
        input.expected_version,
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
    return prepareFromSnapshot(
      location,
      snapshot,
      {
        path: input.path,
        oldString: input.old_string,
        newString: input.new_string,
        expectedVersion: input.expected_version,
      },
      input.expected_version,
    );
  }
}

function approvalFor(edit: PreparedEdit): ToolApprovalPreparation {
  return {
    status: "approval_required",
    approval: {
      kind: "file_edit",
      path: edit.displayPath,
      beforeVersion: edit.beforeVersion,
      diff: edit.diff,
    },
  };
}

function prepareFromSnapshot(
  location: WorkspaceFileLocation,
  snapshot: FileSnapshot,
  intent: EditOperationIntent,
  beforeVersion: string,
): PreparedEditOutcome {
  const matchIndexes = findMatchIndexes(snapshot.content, intent.oldString);
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
    intent.newString +
    snapshot.content.slice(matchIndex + intent.oldString.length);
  return {
    status: "ready",
    edit: {
      canonicalPath: location.canonicalPath,
      displayPath: location.displayPath,
      beforeVersion,
      candidate,
      beforeContentHash: contentHash(snapshot.content),
      afterContentHash: contentHash(candidate),
      diff: formatDiff(
        location.displayPath,
        snapshot.content,
        matchIndex,
        intent.oldString,
        intent.newString,
      ),
      mode: snapshot.mode,
    },
  };
}

function pendingRecord(
  context: EditOperationContext,
  edit: PreparedEdit,
  workspaceRoot: string,
): PendingEditOperationRecord {
  return {
    schemaVersion: 1,
    operationId: context.operationId,
    requestFingerprint: context.requestFingerprint,
    workspaceRoot,
    displayPath: edit.displayPath,
    intent: context.intent,
    beforeContentHash: edit.beforeContentHash,
    afterContentHash: edit.afterContentHash,
    diff: edit.diff,
    state: "pending",
  };
}

function resultFromApplied(record: AppliedEditOperationRecord): EditResult {
  return {
    path: record.displayPath,
    replacements: 1,
    beforeVersion: record.intent.expectedVersion,
    afterVersion: record.afterVersion,
    diff: record.diff,
    verified: true,
  };
}

function sameOperation(
  context: EditOperationContext,
  record: EditOperationRecord,
): boolean {
  return (
    context.operationId === record.operationId &&
    context.requestFingerprint === record.requestFingerprint &&
    record.workspaceRoot === context.workspaceRoot
  );
}

function operationFingerprint(
  workspaceRoot: string,
  intent: EditOperationIntent,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        workspaceRoot,
        intent.path,
        intent.oldString,
        intent.newString,
        intent.expectedVersion,
      ]),
    )
    .digest("hex");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function operationConflictError(
  operationId: string,
  path?: string,
): ToolError {
  return {
    code: "operation_conflict",
    message:
      "This Edit operation identity belongs to different arguments or the file is neither the recorded before nor after content. No file was written.",
    retryable: false,
    details: {
      operationId,
      ...(path === undefined ? {} : { path }),
    },
  };
}

function operationCheckpointError(
  operationId: string,
  sideEffectOutcome: "none" | "applied",
  message: string,
): ToolError {
  return {
    code: "operation_checkpoint_failed",
    message,
    retryable: false,
    details: { operationId, sideEffectOutcome },
  };
}

async function resolveWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<
  | WorkspaceFileLocation
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
  | FileSnapshot
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
