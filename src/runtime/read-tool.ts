import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";

import type { RuntimeTool, ToolOutcome } from "./tool.js";
import { toolError } from "./tool.js";

const DEFAULT_MAX_READ_BYTES = 128 * 1024;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_SECRET_BYTES = 32;
const readArgumentsSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe("A path relative to the workspace root, for example README.md."),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .optional()
      .describe(
        "The exact nextCursor returned by a previous Read page for the same file. Omit to start from the beginning.",
      ),
  })
  .strict();
const readInputSchema = z.toJSONSchema(readArgumentsSchema, {
  target: "openapi-3.0",
});

const fileVersionSchema = z
  .object({
    device: z.string(),
    inode: z.string(),
    size: z.string(),
    modifiedNs: z.string(),
    changedNs: z.string(),
  })
  .strict();
const readCursorSchema = z
  .object({
    version: z.literal(1),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    continuedLine: z.boolean(),
    file: fileVersionSchema,
  })
  .strict();

type FileVersion = z.infer<typeof fileVersionSchema>;
type ReadCursor = z.infer<typeof readCursorSchema>;

export interface ReadToolOptions {
  readonly workspaceRoot: string;
  readonly maxReadBytes?: number;
}

export class WorkspaceConfigurationError extends Error {}

export class ReadTool implements RuntimeTool {
  readonly definition = {
    name: "read",
    description:
      "Read one bounded UTF-8 text page inside the workspace. The path must be relative to the workspace root. When complete is false, call Read again with the same path and pass the returned nextCursor value as the cursor argument.",
    inputSchema: readInputSchema,
  } as const;

  readonly #workspaceRoot: string;
  readonly #maxReadBytes: number;
  readonly #cursorSecret: Buffer;

  private constructor(
    workspaceRoot: string,
    maxReadBytes: number,
    cursorSecret: Buffer,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#maxReadBytes = maxReadBytes;
    this.#cursorSecret = cursorSecret;
  }

  static async create(options: ReadToolOptions): Promise<ReadTool> {
    const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1) {
      throw new WorkspaceConfigurationError(
        "maxReadBytes must be a positive safe integer",
      );
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

    return new ReadTool(
      workspaceRoot,
      maxReadBytes,
      randomBytes(CURSOR_SECRET_BYTES),
    );
  }

  async execute(input: unknown): Promise<ToolOutcome> {
    const parsed = readArgumentsSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(
        "invalid_arguments",
        "Read expects a non-empty path and, when continuing, the exact cursor returned by the previous page.",
      );
    }

    const requestedPath = parsed.data.path;
    if (
      requestedPath.includes("\0") ||
      isAbsolute(requestedPath) ||
      win32.isAbsolute(requestedPath)
    ) {
      return toolError(
        "path_outside_workspace",
        "Read only accepts relative paths inside the workspace.",
      );
    }

    const lexicalPath = resolve(this.#workspaceRoot, requestedPath);
    if (!isWithin(this.#workspaceRoot, lexicalPath)) {
      return toolError(
        "path_outside_workspace",
        "The requested path is outside the workspace.",
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return toolError("not_found", "The requested file does not exist.");
      }
      return toolError("read_failed", "The requested file could not be resolved.");
    }

    if (!isWithin(this.#workspaceRoot, canonicalPath)) {
      return toolError(
        "path_outside_workspace",
        "The requested path resolves outside the workspace.",
      );
    }

    let fileHandle;
    try {
      fileHandle = await open(
        canonicalPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const initialStat = await fileHandle.stat({ bigint: true });
      if (!initialStat.isFile()) {
        return toolError("not_regular_file", "Read only supports regular files.");
      }
      if (initialStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        return toolError(
          "file_size_unsupported",
          "The file is too large for safe cursor-based paging.",
        );
      }

      const displayPath = toPortableRelativePath(this.#workspaceRoot, canonicalPath);
      const initialVersion = toFileVersion(initialStat);
      let offset = 0;
      let startLine = 1;
      let continuedFromPreviousLine = false;

      if (parsed.data.cursor !== undefined) {
        const cursor = decodeCursor(
          parsed.data.cursor,
          displayPath,
          this.#cursorSecret,
        );
        if (cursor === undefined) {
          return toolError(
            "invalid_cursor",
            "The Read cursor is invalid or belongs to another file.",
          );
        }
        if (!sameFileVersion(cursor.file, initialVersion)) {
          return toolError(
            "file_changed",
            "The file changed after the previous Read page. Start again without a cursor.",
          );
        }
        offset = cursor.offset;
        startLine = cursor.line;
        continuedFromPreviousLine = cursor.continuedLine;
      }

      const fileBytes = Number(initialStat.size);
      if (offset < 0 || offset >= fileBytes) {
        if (offset !== 0 || fileBytes !== 0) {
          return toolError(
            "invalid_cursor",
            "The Read cursor points outside the current file.",
          );
        }
      }

      const remainingBytes = fileBytes - offset;
      const requestedBytes = Math.min(this.#maxReadBytes, remainingBytes);
      const buffer = Buffer.allocUnsafe(requestedBytes);
      const { bytesRead } =
        requestedBytes === 0
          ? { bytesRead: 0 }
          : await fileHandle.read(buffer, 0, requestedBytes, offset);
      if (bytesRead === 0 && remainingBytes > 0) {
        return toolError("read_failed", "The requested file could not be paged.");
      }

      const candidate = buffer.subarray(0, bytesRead);
      const candidateReachesEnd = offset + bytesRead >= fileBytes;
      const safePrefix = decodeSafeUtf8Prefix(candidate, candidateReachesEnd);
      if (safePrefix === undefined) {
        return toolError("invalid_utf8", "Read only supports valid UTF-8 text files.");
      }
      if (safePrefix.byteLength === 0 && remainingBytes > 0) {
        return toolError(
          "page_limit_too_small",
          "The Read page limit is too small to contain one UTF-8 character.",
        );
      }

      let pageByteLength = safePrefix.byteLength;
      if (offset + pageByteLength < fileBytes) {
        const lastNewline = candidate.lastIndexOf(0x0a, pageByteLength - 1);
        if (lastNewline >= 0) {
          pageByteLength = lastNewline + 1;
        }
      }

      const pageBytes = candidate.subarray(0, pageByteLength);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(pageBytes);
      const endOffset = offset + pageByteLength;
      const complete = endOffset >= fileBytes;
      const newlineCount = countByte(pageBytes, 0x0a);
      const endsWithNewline = pageBytes.at(-1) === 0x0a;
      const continuesOnNextPage = !complete && !endsWithNewline;
      const nextLine = continuesOnNextPage ? startLine : startLine + newlineCount;
      const endLine =
        pageBytes.length === 0
          ? 0
          : startLine + newlineCount - (endsWithNewline ? 1 : 0);

      const finalStat = await fileHandle.stat({ bigint: true });
      if (!sameFileVersion(initialVersion, toFileVersion(finalStat))) {
        return toolError(
          "file_changed",
          "The file changed while Read was producing this page. Start again without a cursor.",
        );
      }

      return {
        status: "success",
        output: {
          path: displayPath,
          bytes: pageBytes.byteLength,
          fileBytes,
          content,
          startLine: pageBytes.length === 0 ? 0 : startLine,
          endLine,
          continuedFromPreviousLine,
          continuesOnNextPage,
          complete,
          ...(complete
            ? {}
            : {
                nextCursor: encodeCursor(
                  {
                    version: 1,
                    offset: endOffset,
                    line: nextLine,
                    continuedLine: continuesOnNextPage,
                    file: initialVersion,
                  },
                  displayPath,
                  this.#cursorSecret,
                ),
              }),
        },
      };
    } catch {
      return toolError("read_failed", "The requested file could not be read.");
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }
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

function toFileVersion(fileStat: BigIntStats): FileVersion {
  return {
    device: fileStat.dev.toString(),
    inode: fileStat.ino.toString(),
    size: fileStat.size.toString(),
    modifiedNs: fileStat.mtimeNs.toString(),
    changedNs: fileStat.ctimeNs.toString(),
  };
}

function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

function encodeCursor(
  cursor: ReadCursor,
  path: string,
  secret: Buffer,
): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  const signature = signCursor(payload, path, secret).toString("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  rawCursor: string,
  path: string,
  secret: Buffer,
): ReadCursor | undefined {
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
    const expectedSignature = signCursor(payload, path, secret);
    if (
      signature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(signature, expectedSignature)
    ) {
      return undefined;
    }

    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    const parsed = readCursorSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function signCursor(payload: string, path: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(payload, "ascii")
    .digest();
}

function decodeSafeUtf8Prefix(
  bytes: Buffer,
  reachesEndOfFile: boolean,
): { readonly byteLength: number } | undefined {
  const maxTrim = reachesEndOfFile ? 0 : Math.min(3, bytes.length);
  for (let trim = 0; trim <= maxTrim; trim += 1) {
    const byteLength = bytes.length - trim;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, byteLength),
      );
      return { byteLength };
    } catch {
      // A page may end in the middle of one UTF-8 code point. Only trim the
      // bounded suffix; invalid bytes inside the page remain a hard failure.
    }
  }
  return undefined;
}

function countByte(bytes: Buffer, target: number): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === target) {
      count += 1;
    }
  }
  return count;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
