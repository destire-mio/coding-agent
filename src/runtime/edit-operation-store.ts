import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

const editIntentSchema = z
  .object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
    expectedVersion: z.string().min(1),
  })
  .strict();

const pendingFields = {
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(256),
  requestFingerprint: z.string().regex(HASH_PATTERN),
  workspaceRoot: z.string().min(1),
  displayPath: z.string().min(1),
  intent: editIntentSchema,
  beforeContentHash: z.string().regex(HASH_PATTERN),
  afterContentHash: z.string().regex(HASH_PATTERN),
  diff: z.string(),
} as const;

const pendingRecordSchema = z
  .object({
    ...pendingFields,
    state: z.literal("pending"),
  })
  .strict();

const appliedRecordSchema = z
  .object({
    ...pendingFields,
    state: z.literal("applied"),
    afterVersion: z.string().min(1),
  })
  .strict();

const conflictRecordSchema = z
  .object({
    ...pendingFields,
    state: z.literal("conflict"),
    reason: z.string().min(1),
  })
  .strict();

const cancelledRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1).max(256),
    requestFingerprint: z.string().regex(HASH_PATTERN),
    workspaceRoot: z.string().min(1),
    path: z.string().min(1),
    state: z.literal("cancelled"),
  })
  .strict();

const editOperationRecordSchema = z.discriminatedUnion("state", [
  pendingRecordSchema,
  appliedRecordSchema,
  conflictRecordSchema,
  cancelledRecordSchema,
]);

export type EditOperationIntent = z.infer<typeof editIntentSchema>;
export type PendingEditOperationRecord = z.infer<typeof pendingRecordSchema>;
export type AppliedEditOperationRecord = z.infer<typeof appliedRecordSchema>;
export type ConflictEditOperationRecord = z.infer<
  typeof conflictRecordSchema
>;
export type CancelledEditOperationRecord = z.infer<
  typeof cancelledRecordSchema
>;
export type EditOperationRecord = z.infer<typeof editOperationRecordSchema>;

export interface EditOperationStoreOptions {
  readonly root?: string;
}

export class EditOperationStoreConfigurationError extends Error {}
export class EditOperationStoreError extends Error {}

/** Private process-restart state for exact Edit operations. */
export class EditOperationStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  get rootPath(): string {
    return this.#root;
  }

  static async create(
    options: EditOperationStoreOptions = {},
  ): Promise<EditOperationStore> {
    const requestedRoot =
      options.root ?? join(homedir(), ".coding-agent", "state", "edit-operations");
    try {
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(requestedRoot);
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        throw new EditOperationStoreConfigurationError(
          "The Edit operation store must be a directory.",
        );
      }
      await chmod(root, 0o700);
      return new EditOperationStore(root);
    } catch (error) {
      if (error instanceof EditOperationStoreConfigurationError) {
        throw error;
      }
      throw new EditOperationStoreConfigurationError(
        "The private Edit operation store could not be initialized.",
      );
    }
  }

  async read(operationId: string): Promise<EditOperationRecord | undefined> {
    validateOperationId(operationId);
    const path = this.#recordPath(operationId);
    try {
      const recordStat = await lstat(path);
      if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
        throw new EditOperationStoreError(
          "The Edit operation record is not a regular file.",
        );
      }
      const parsed = editOperationRecordSchema.safeParse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (!parsed.success || parsed.data.operationId !== operationId) {
        throw new EditOperationStoreError(
          "The Edit operation record is invalid.",
        );
      }
      return parsed.data;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      if (error instanceof EditOperationStoreError) {
        throw error;
      }
      throw new EditOperationStoreError(
        "The Edit operation record could not be read.",
      );
    }
  }

  async write(record: EditOperationRecord): Promise<void> {
    const parsed = editOperationRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new EditOperationStoreError(
        "The Edit operation record is invalid.",
      );
    }
    validateOperationId(record.operationId);

    const targetPath = this.#recordPath(record.operationId);
    const temporaryPath = join(
      this.#root,
      `.edit-operation-${randomBytes(12).toString("base64url")}.tmp`,
    );
    let handle;
    let renamed = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(parsed.data)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      renamed = true;
    } catch {
      throw new EditOperationStoreError(
        "The Edit operation record could not be saved.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
  }

  #recordPath(operationId: string): string {
    const name = createHash("sha256").update(operationId).digest("hex");
    return join(this.#root, `${name}.json`);
  }
}

function validateOperationId(operationId: string): void {
  if (operationId.length < 1 || operationId.length > 256) {
    throw new EditOperationStoreError(
      "The Edit operation identity is invalid.",
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
