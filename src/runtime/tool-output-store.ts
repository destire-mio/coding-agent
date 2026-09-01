import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REF_PREFIX = "tool-output-v1:";
const REF_TOKEN_BYTES = 32;
const REF_PATTERN = /^tool-output-v1:([A-Za-z0-9_-]{43})$/;

export interface ToolOutputStoreOptions {
  readonly root?: string;
}

export interface ToolOutputLocation {
  readonly ref: string;
  readonly path: string;
}

export interface ToolOutputWriter {
  readonly ref: string;
  write(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface ToolOutputPair {
  readonly stdout: ToolOutputWriter;
  readonly stderr: ToolOutputWriter;
  close(): Promise<void>;
}

export class ToolOutputStoreConfigurationError extends Error {}

/**
 * Private, durable storage for complete tool streams.
 *
 * A ref is a 256-bit capability, not an encoded filesystem path. Possessing one
 * ref grants access to exactly one stored output through Runtime's Read tool.
 */
export class ToolOutputStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  get rootPath(): string {
    return this.#root;
  }

  static async create(
    options: ToolOutputStoreOptions = {},
  ): Promise<ToolOutputStore> {
    const requestedRoot = options.root ??
      join(homedir(), ".coding-agent", "tool-output");
    try {
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(requestedRoot);
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        throw new ToolOutputStoreConfigurationError(
          "The tool output store must be a directory.",
        );
      }
      await chmod(root, 0o700);
      return new ToolOutputStore(root);
    } catch (error) {
      if (error instanceof ToolOutputStoreConfigurationError) {
        throw error;
      }
      throw new ToolOutputStoreConfigurationError(
        "The private tool output store could not be initialized.",
      );
    }
  }

  async createPair(): Promise<ToolOutputPair> {
    const stdout = await this.#createWriter();
    try {
      const stderr = await this.#createWriter();
      return {
        stdout,
        stderr,
        async close() {
          await Promise.allSettled([stdout.close(), stderr.close()]);
        },
      };
    } catch (error) {
      await stdout.close().catch(() => undefined);
      await this.#remove(stdout.ref);
      throw error;
    }
  }

  async resolve(ref: string): Promise<ToolOutputLocation | undefined> {
    const token = parseRef(ref);
    if (token === undefined) {
      return undefined;
    }
    const path = join(this.#root, `${token}.log`);
    try {
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        return undefined;
      }
      return { ref, path };
    } catch {
      return undefined;
    }
  }

  async #createWriter(): Promise<StoredOutputWriter> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = randomBytes(REF_TOKEN_BYTES).toString("base64url");
      const ref = `${REF_PREFIX}${token}`;
      const path = join(this.#root, `${token}.log`);
      try {
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        return new StoredOutputWriter(ref, handle);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    throw new Error("Could not allocate a unique tool output reference.");
  }

  async #remove(ref: string): Promise<void> {
    const token = parseRef(ref);
    if (token !== undefined) {
      await unlink(join(this.#root, `${token}.log`)).catch(() => undefined);
    }
  }
}

class StoredOutputWriter implements ToolOutputWriter {
  readonly ref: string;
  readonly #handle: FileHandle;
  #closed = false;

  constructor(ref: string, handle: FileHandle) {
    this.ref = ref;
    this.#handle = handle;
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.#closed) {
      throw new Error("The tool output writer is closed.");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.#handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        null,
      );
      if (bytesWritten < 1) {
        throw new Error("The tool output log could not be written completely.");
      }
      offset += bytesWritten;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close();
  }
}

function parseRef(ref: string): string | undefined {
  return REF_PATTERN.exec(ref)?.[1];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
