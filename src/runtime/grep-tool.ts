import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import type { ToolExecutionOptions } from "../core/contracts.js";
import { WorkspaceConfigurationError } from "./read-tool.js";
import type { RuntimeTool, ToolOutcome } from "./tool.js";
import { toolError } from "./tool.js";

const DEFAULT_GREP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MATCH_COLUMNS = 500;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_SECRET_BYTES = 32;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 16 * 1024;
const FORCE_KILL_DELAY_MS = 500;
const LONG_LINE_SUFFIX = "[... omitted end of long line]";

const grepArgumentsSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe("A ripgrep regular expression, for example ERROR.*order-\\d+."),
    path: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "A file or directory relative to the workspace root. Omit to search the whole workspace.",
      ),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .optional()
      .describe(
        "The exact nextCursor returned by the previous Grep page for the same pattern and path.",
      ),
  })
  .strict();
const grepInputSchema = z.toJSONSchema(grepArgumentsSchema, {
  target: "openapi-3.0",
});

const grepCursorSchema = z
  .object({
    version: z.literal(1),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

type GrepCursor = z.infer<typeof grepCursorSchema>;

export interface GrepToolOptions {
  readonly workspaceRoot: string;
  readonly rgPath?: string;
  readonly timeoutMs?: number;
  readonly maxMatches?: number;
  readonly maxOutputBytes?: number;
}

interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly truncated: boolean;
}

type StopReason = "cancelled" | "timeout" | "page_limit" | "output_limit";

export class GrepTool implements RuntimeTool {
  readonly definition = {
    name: "grep",
    description:
      "Search workspace files with a ripgrep regular expression. Use Grep to locate unknown content or file locations. Results are bounded and paged; when complete is false, repeat the same pattern and path with the returned nextCursor. Sensitive files are always skipped.",
    inputSchema: grepInputSchema,
  } as const;

  readonly #workspaceRoot: string;
  readonly #rgPath: string;
  readonly #timeoutMs: number;
  readonly #maxMatches: number;
  readonly #maxOutputBytes: number;
  readonly #cursorSecret: Buffer;

  private constructor(
    workspaceRoot: string,
    rgPath: string,
    timeoutMs: number,
    maxMatches: number,
    maxOutputBytes: number,
    cursorSecret: Buffer,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#rgPath = rgPath;
    this.#timeoutMs = timeoutMs;
    this.#maxMatches = maxMatches;
    this.#maxOutputBytes = maxOutputBytes;
    this.#cursorSecret = cursorSecret;
  }

  static async create(options: GrepToolOptions): Promise<GrepTool> {
    const rgPath = options.rgPath?.trim() || "rg";
    const timeoutMs = options.timeoutMs ?? DEFAULT_GREP_TIMEOUT_MS;
    const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
    const maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    for (const [name, value] of [
      ["timeoutMs", timeoutMs],
      ["maxMatches", maxMatches],
      ["maxOutputBytes", maxOutputBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new WorkspaceConfigurationError(
          `${name} must be a positive safe integer`,
        );
      }
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(options.workspaceRoot);
      const workspaceStat = await stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) {
        throw new WorkspaceConfigurationError("The workspace must be a directory.");
      }
    } catch (error) {
      if (error instanceof WorkspaceConfigurationError) {
        throw error;
      }
      throw new WorkspaceConfigurationError(
        "The workspace does not exist or cannot be accessed.",
      );
    }

    return new GrepTool(
      workspaceRoot,
      rgPath,
      timeoutMs,
      maxMatches,
      maxOutputBytes,
      randomBytes(CURSOR_SECRET_BYTES),
    );
  }

  async execute(
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolOutcome> {
    const parsed = grepArgumentsSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(
        "invalid_arguments",
        "Grep expects a non-empty pattern, an optional relative path, and an optional exact continuation cursor.",
      );
    }
    if (parsed.data.pattern.includes("\0")) {
      return toolError("invalid_pattern", "The Grep pattern cannot contain NUL.");
    }
    if (options.signal?.aborted === true) {
      return toolError("cancelled", "Grep was cancelled before it started.");
    }

    const requestedPath = parsed.data.path ?? ".";
    const resolvedPath = await this.#resolveSearchPath(requestedPath);
    if (!("canonicalPath" in resolvedPath)) {
      return resolvedPath;
    }
    if (isSensitivePath(resolvedPath.displayPath)) {
      return toolError(
        "sensitive_path",
        "Grep does not search sensitive files.",
      );
    }

    let offset = 0;
    if (parsed.data.cursor !== undefined) {
      const cursor = decodeCursor(
        parsed.data.cursor,
        parsed.data.pattern,
        resolvedPath.displayPath,
        this.#cursorSecret,
      );
      if (cursor === undefined) {
        return toolError(
          "invalid_cursor",
          "The Grep cursor is invalid or belongs to another search.",
        );
      }
      offset = cursor.offset;
    }

    return this.#runSearch(
      parsed.data.pattern,
      resolvedPath.canonicalPath,
      resolvedPath.displayPath,
      offset,
      options.signal,
    );
  }

  async #resolveSearchPath(
    requestedPath: string,
  ): Promise<
    | {
        readonly status: "success";
        readonly canonicalPath: string;
        readonly displayPath: string;
      }
    | ToolOutcome
  > {
    if (
      requestedPath.includes("\0") ||
      isAbsolute(requestedPath) ||
      win32.isAbsolute(requestedPath)
    ) {
      return toolError(
        "path_outside_workspace",
        "Grep only accepts relative paths inside the workspace.",
      );
    }

    const lexicalPath = resolve(this.#workspaceRoot, requestedPath);
    if (!isWithin(this.#workspaceRoot, lexicalPath)) {
      return toolError(
        "path_outside_workspace",
        "The requested search path is outside the workspace.",
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return toolError("not_found", "The requested search path does not exist.");
      }
      return toolError(
        "search_failed",
        "The requested search path could not be resolved.",
      );
    }
    if (!isWithin(this.#workspaceRoot, canonicalPath)) {
      return toolError(
        "path_outside_workspace",
        "The requested search path resolves outside the workspace.",
      );
    }

    try {
      const searchStat = await stat(canonicalPath);
      if (!searchStat.isFile() && !searchStat.isDirectory()) {
        return toolError(
          "unsupported_path",
          "Grep only supports regular files and directories.",
        );
      }
    } catch {
      return toolError("search_failed", "The search path could not be inspected.");
    }

    const displayPath = toPortableRelativePath(
      this.#workspaceRoot,
      canonicalPath,
    );
    return {
      status: "success",
      canonicalPath,
      displayPath: displayPath === "" ? "." : displayPath,
    };
  }

  async #runSearch(
    pattern: string,
    canonicalSearchPath: string,
    displaySearchPath: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    if (signal?.aborted === true) {
      return toolError("cancelled", "Grep was cancelled before it started.");
    }

    let child;
    try {
      child = spawn(this.#rgPath, buildRipgrepArguments(pattern, canonicalSearchPath), {
        cwd: this.#workspaceRoot,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return spawnFailure(error);
    }

    return new Promise<ToolOutcome>((resolveOutcome) => {
      const decoder = new StringDecoder("utf8");
      const matches: GrepMatch[] = [];
      let pendingOutput = "";
      let outputBytes = 0;
      let visibleMatchesSeen = 0;
      let stderr = "";
      let stderrTruncated = false;
      let spawnError: unknown;
      let stopReason: StopReason | undefined;
      let settled = false;
      let closed = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const requestStop = (reason: StopReason) => {
        if (stopReason !== undefined || closed || child.exitCode !== null) {
          return;
        }
        stopReason = reason;
        child.stdout.pause();
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!closed) {
            child.kill("SIGKILL");
          }
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      };

      const consumeRecord = (record: string) => {
        const parsedRecord = parseRipgrepRecord(
          record,
          this.#workspaceRoot,
        );
        if (parsedRecord === undefined || isSensitivePath(parsedRecord.path)) {
          return;
        }
        if (visibleMatchesSeen < offset) {
          visibleMatchesSeen += 1;
          return;
        }

        const cost = matchByteLength(parsedRecord);
        if (
          matches.length >= this.#maxMatches ||
          outputBytes + cost > this.#maxOutputBytes
        ) {
          if (matches.length === 0) {
            requestStop("output_limit");
          } else {
            requestStop("page_limit");
          }
          return;
        }

        matches.push(parsedRecord);
        outputBytes += cost;
        visibleMatchesSeen += 1;
      };

      const consumePendingRecords = () => {
        while (stopReason === undefined) {
          const separator = pendingOutput.indexOf("\0");
          if (separator < 0) {
            break;
          }
          const end = pendingOutput.indexOf("\n", separator + 1);
          if (end < 0) {
            break;
          }
          const record = pendingOutput.slice(0, end);
          pendingOutput = pendingOutput.slice(end + 1);
          consumeRecord(record);
        }
        if (
          stopReason === undefined &&
          Buffer.byteLength(pendingOutput, "utf8") > MAX_PENDING_OUTPUT_BYTES
        ) {
          requestStop("output_limit");
        }
      };

      const onAbort = () => {
        requestStop("cancelled");
      };
      if (signal?.aborted === true) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }

      const timeoutTimer = setTimeout(() => {
        requestStop("timeout");
      }, this.#timeoutMs);
      timeoutTimer.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        if (stopReason !== undefined) {
          return;
        }
        pendingOutput += decoder.write(chunk);
        consumePendingRecords();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, "utf8") >= MAX_STDERR_BYTES) {
          stderrTruncated = true;
          return;
        }
        const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr, "utf8");
        const text = chunk.toString("utf8");
        stderr += truncateUtf8(text, remaining).text;
        stderrTruncated ||= Buffer.byteLength(text, "utf8") > remaining;
      });

      child.once("error", (error) => {
        spawnError = error;
      });

      child.once("close", (exitCode) => {
        closed = true;
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        signal?.removeEventListener("abort", onAbort);

        if (stopReason === undefined) {
          pendingOutput += decoder.end();
          consumePendingRecords();
        }

        if (stopReason === "cancelled") {
          resolveOutcome(toolError("cancelled", "Grep was cancelled."));
          return;
        }
        if (stopReason === "timeout") {
          resolveOutcome(
            toolError(
              "search_timeout",
              "Grep exceeded its execution time limit. Narrow the path or pattern.",
            ),
          );
          return;
        }
        if (stopReason === "output_limit") {
          resolveOutcome(
            toolError(
              "search_output_limit",
              "One Grep result exceeded the safe output limit.",
            ),
          );
          return;
        }
        if (spawnError !== undefined) {
          resolveOutcome(spawnFailure(spawnError));
          return;
        }
        if (stopReason === "page_limit") {
          resolveOutcome(
            grepSuccess(
              pattern,
              displaySearchPath,
              matches,
              false,
              encodeCursor(
                { version: 1, offset: offset + matches.length },
                pattern,
                displaySearchPath,
                this.#cursorSecret,
              ),
            ),
          );
          return;
        }
        if (exitCode === 0 || exitCode === 1) {
          resolveOutcome(
            grepSuccess(pattern, displaySearchPath, matches, true),
          );
          return;
        }

        const failureMessage = sanitizedStderr(stderr, stderrTruncated);
        if (/regex parse error|error parsing regex|invalid regex/i.test(failureMessage)) {
          resolveOutcome(toolError("invalid_pattern", failureMessage));
          return;
        }
        resolveOutcome(toolError("search_failed", failureMessage));
      });
    });
  }
}

function buildRipgrepArguments(pattern: string, searchPath: string): string[] {
  const arguments_ = [
    "--no-config",
    "--hidden",
    "--no-mmap",
    "--line-buffered",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--line-number",
    "--null",
    "--max-columns",
    String(MAX_MATCH_COLUMNS),
    "--max-columns-preview",
  ];
  for (const excluded of [
    ".git",
    ".svn",
    ".hg",
    ".jj",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    "id_rsa",
    "id_rsa*",
    "id_ed25519",
    "id_ed25519*",
    "id_ecdsa",
    "id_ecdsa*",
  ]) {
    arguments_.push("--glob", `!${excluded}`);
  }
  arguments_.push("--", pattern, searchPath);
  return arguments_;
}

function parseRipgrepRecord(
  record: string,
  workspaceRoot: string,
): GrepMatch | undefined {
  const separator = record.indexOf("\0");
  if (separator < 1) {
    return undefined;
  }
  const rawPath = record.slice(0, separator);
  const payload = record.slice(separator + 1).replace(/\r$/, "");
  const match = /^(\d+):(.*)$/.exec(payload);
  if (match === null) {
    return undefined;
  }
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line) || line < 1) {
    return undefined;
  }

  const absolutePath = resolve(workspaceRoot, rawPath);
  if (!isWithin(workspaceRoot, absolutePath)) {
    return undefined;
  }
  const displayPath = toPortableRelativePath(workspaceRoot, absolutePath);
  let text = match[2] ?? "";
  const truncated = text.endsWith(LONG_LINE_SUFFIX);
  const bounded = truncateUtf8(text, MAX_MATCH_COLUMNS * 4);
  text = bounded.text;
  return {
    path: displayPath,
    line,
    text,
    truncated: truncated || bounded.truncated,
  };
}

function matchByteLength(match: GrepMatch): number {
  return (
    Buffer.byteLength(match.path, "utf8") +
    Buffer.byteLength(match.text, "utf8") +
    32
  );
}

function grepSuccess(
  pattern: string,
  path: string,
  matches: readonly GrepMatch[],
  complete: boolean,
  nextCursor?: string,
): ToolOutcome {
  return {
    status: "success",
    output: {
      pattern,
      path,
      matches,
      complete,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  };
}

function spawnFailure(error: unknown): ToolOutcome {
  if (isNodeError(error) && error.code === "ENOENT") {
    return toolError(
      "grep_unavailable",
      "The ripgrep executable is not available.",
    );
  }
  return toolError("search_failed", "The Grep process could not be started.");
}

function sanitizedStderr(stderr: string, truncated: boolean): string {
  const message = stderr.trim().split("\n").slice(0, 4).join("\n");
  if (message.length === 0) {
    return "Grep failed while searching the workspace.";
  }
  return `${message}${truncated ? "\n[stderr truncated]" : ""}`;
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  let end = maxBytes;
  while (end > 0) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, end),
      );
      return { text, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

function isSensitivePath(displayPath: string): boolean {
  const parts = displayPath.split("/").filter((part) => part.length > 0);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]?.toLowerCase() ?? "";
    if (
      part === ".git" ||
      part === ".svn" ||
      part === ".hg" ||
      part === ".jj"
    ) {
      return true;
    }
    if (
      (part === ".env" || part.startsWith(".env.")) &&
      part !== ".env.example" &&
      part !== ".env.sample" &&
      part !== ".env.template"
    ) {
      return true;
    }
    if (/^id_(rsa|ed25519|ecdsa)(?:[-_.].*)?$/.test(part)) {
      return true;
    }
    if (
      part === "credentials" &&
      (parts[index - 1]?.toLowerCase() === ".aws" ||
        parts[index - 1]?.toLowerCase() === ".gcp")
    ) {
      return true;
    }
  }
  return false;
}

function encodeCursor(
  cursor: GrepCursor,
  pattern: string,
  path: string,
  secret: Buffer,
): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  const signature = signCursor(payload, pattern, path, secret).toString(
    "base64url",
  );
  return `${payload}.${signature}`;
}

function decodeCursor(
  rawCursor: string,
  pattern: string,
  path: string,
  secret: Buffer,
): GrepCursor | undefined {
  if (
    rawCursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(rawCursor)
  ) {
    return undefined;
  }
  const [payload, encodedSignature] = rawCursor.split(".");
  if (payload === undefined || encodedSignature === undefined) {
    return undefined;
  }
  try {
    const signature = Buffer.from(encodedSignature, "base64url");
    const expected = signCursor(payload, pattern, path, secret);
    if (
      signature.byteLength !== expected.byteLength ||
      !timingSafeEqual(signature, expected)
    ) {
      return undefined;
    }
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    const parsed = grepCursorSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function signCursor(
  payload: string,
  pattern: string,
  path: string,
  secret: Buffer,
): Buffer {
  return createHmac("sha256", secret)
    .update(pattern, "utf8")
    .update("\0", "utf8")
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(payload, "ascii")
    .digest();
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
