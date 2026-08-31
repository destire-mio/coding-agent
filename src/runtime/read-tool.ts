import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";

import type { RuntimeTool, ToolOutcome } from "./tool.js";
import { toolError } from "./tool.js";

const DEFAULT_MAX_READ_BYTES = 128 * 1024;
const readArgumentsSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe("A path relative to the workspace root, for example README.md."),
  })
  .strict();
const readInputSchema = z.toJSONSchema(readArgumentsSchema, {
  target: "openapi-3.0",
});

export interface ReadToolOptions {
  readonly workspaceRoot: string;
  readonly maxReadBytes?: number;
}

export class WorkspaceConfigurationError extends Error {}

export class ReadTool implements RuntimeTool {
  readonly definition = {
    name: "read",
    description:
      "Read one UTF-8 text file inside the workspace. The path must be relative to the workspace root.",
    inputSchema: readInputSchema,
  } as const;

  readonly #workspaceRoot: string;
  readonly #maxReadBytes: number;

  private constructor(workspaceRoot: string, maxReadBytes: number) {
    this.#workspaceRoot = workspaceRoot;
    this.#maxReadBytes = maxReadBytes;
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

    return new ReadTool(workspaceRoot, maxReadBytes);
  }

  async execute(input: unknown): Promise<ToolOutcome> {
    const parsed = readArgumentsSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(
        "invalid_arguments",
        "Read expects exactly one non-empty string argument named path.",
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
      const fileStat = await fileHandle.stat();
      if (!fileStat.isFile()) {
        return toolError("not_regular_file", "Read only supports regular files.");
      }
      if (fileStat.size > this.#maxReadBytes) {
        return toolError(
          "file_too_large",
          `The file exceeds the ${this.#maxReadBytes} byte limit for this milestone.`,
        );
      }

      const bytes = await fileHandle.readFile();
      if (bytes.byteLength > this.#maxReadBytes) {
        return toolError(
          "file_too_large",
          `The file exceeds the ${this.#maxReadBytes} byte limit for this milestone.`,
        );
      }

      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return toolError("invalid_utf8", "Read only supports valid UTF-8 text files.");
      }

      return {
        status: "success",
        output: {
          path: toPortableRelativePath(this.#workspaceRoot, canonicalPath),
          bytes: bytes.byteLength,
          content,
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
