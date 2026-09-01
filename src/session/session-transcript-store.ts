import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const assistantContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("think"), think: z.string() }).strict(),
]);

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    rawArguments: z.string(),
  })
  .strict();

const toolErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  })
  .strict();

const observationSchema = z.discriminatedUnion("status", [
  z
    .object({
      toolCallId: z.string(),
      toolName: z.string(),
      status: z.literal("success"),
      output: z.unknown(),
    })
    .strict(),
  z
    .object({
      toolCallId: z.string(),
      toolName: z.string(),
      status: z.literal("error"),
      error: toolErrorSchema,
    })
    .strict(),
]);

const commonFields = {
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  recordedAt: z.iso.datetime(),
} as const;

const sessionEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...commonFields,
      type: z.literal("session_started"),
      workspaceRoot: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("turn_started"),
      turnId: z.string().regex(SESSION_ID_PATTERN),
      userInput: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("tool_intent"),
      turnId: z.string().regex(SESSION_ID_PATTERN),
      step: z.number().int().positive(),
      operationId: z.string().min(1).max(256),
      call: toolCallSchema,
      replayContent: z.array(assistantContentPartSchema),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("tool_observation"),
      turnId: z.string().regex(SESSION_ID_PATTERN),
      step: z.number().int().positive(),
      operationId: z.string().min(1).max(256),
      observation: observationSchema,
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("turn_finished"),
      turnId: z.string().regex(SESSION_ID_PATTERN),
      steps: z.number().int().nonnegative(),
      outcome: z.enum(["completed", "failed", "cancelled", "max_steps"]),
      answer: z.string().optional(),
      reason: z.string().optional(),
      message: z.string().optional(),
    })
    .strict(),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventInput = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, "schemaVersion" | "sessionId" | "recordedAt">
    : never
  : never;

export interface SessionEventWriter {
  readonly sessionId: string;
  append(event: SessionEventInput): Promise<void>;
}

export interface SessionTranscriptStoreOptions {
  readonly workspaceRoot: string;
  readonly root?: string;
  readonly sessionId?: string;
}

export interface SessionTranscriptOpenOptions {
  readonly workspaceRoot: string;
  readonly root?: string;
  readonly sessionId: string;
}

export class SessionTranscriptConfigurationError extends Error {}
export class SessionTranscriptError extends Error {}
export class SessionTranscriptCorruptError extends SessionTranscriptError {}
export class SessionTranscriptNotFoundError extends SessionTranscriptError {}

/** Append-only private facts for one Agent session. */
export class SessionTranscriptStore implements SessionEventWriter {
  readonly #sessionId: string;
  readonly #workspaceRoot: string;
  readonly #transcriptPath: string;
  #needsRepair = false;

  private constructor(
    sessionId: string,
    workspaceRoot: string,
    transcriptPath: string,
  ) {
    this.#sessionId = sessionId;
    this.#workspaceRoot = workspaceRoot;
    this.#transcriptPath = transcriptPath;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get transcriptPath(): string {
    return this.#transcriptPath;
  }

  static async create(
    options: SessionTranscriptStoreOptions,
  ): Promise<SessionTranscriptStore> {
    const sessionId = options.sessionId ?? randomUUID();
    validateSessionId(sessionId);

    try {
      const requestedWorkspaceRoot = resolve(options.workspaceRoot);
      const workspaceRoot = await realpath(options.workspaceRoot);
      const workspaceStat = await stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) {
        throw new SessionTranscriptConfigurationError(
          "The Session workspace root must be a directory.",
        );
      }

      const requestedRoot =
        options.root ?? join(homedir(), ".coding-agent", "sessions");
      const resolvedRequestedRoot = resolve(requestedRoot);
      if (
        isPathInside(requestedWorkspaceRoot, resolvedRequestedRoot) ||
        isPathInside(workspaceRoot, resolvedRequestedRoot)
      ) {
        throw new SessionTranscriptConfigurationError(
          "The private Session store must be outside the workspace.",
        );
      }
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(requestedRoot);
      if (isPathInside(workspaceRoot, root)) {
        throw new SessionTranscriptConfigurationError(
          "The private Session store must be outside the workspace.",
        );
      }
      await chmod(root, 0o700);

      const workspaceBucket = `workspace-${createHash("sha256")
        .update(workspaceRoot)
        .digest("hex")
        .slice(0, 16)}`;
      const sessionDirectory = join(root, workspaceBucket, sessionId);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      await chmod(sessionDirectory, 0o700);

      const store = new SessionTranscriptStore(
        sessionId,
        workspaceRoot,
        join(sessionDirectory, "transcript.jsonl"),
      );
      const events = await store.load();
      if (events.length === 0) {
        await store.append({
          type: "session_started",
          workspaceRoot,
        });
      } else {
        const first = events[0];
        if (
          first?.type !== "session_started" ||
          first.workspaceRoot !== workspaceRoot
        ) {
          throw new SessionTranscriptCorruptError(
            "The Session transcript identity is invalid.",
          );
        }
      }
      return store;
    } catch (error) {
      if (
        error instanceof SessionTranscriptConfigurationError ||
        error instanceof SessionTranscriptError
      ) {
        throw error;
      }
      throw new SessionTranscriptConfigurationError(
        "The private Session store could not be initialized.",
      );
    }
  }

  static async open(
    options: SessionTranscriptOpenOptions,
  ): Promise<SessionTranscriptStore> {
    validateSessionId(options.sessionId);

    try {
      const requestedWorkspaceRoot = resolve(options.workspaceRoot);
      const workspaceRoot = await realpath(options.workspaceRoot);
      const workspaceStat = await stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) {
        throw new SessionTranscriptConfigurationError(
          "The Session workspace root must be a directory.",
        );
      }

      const requestedRoot =
        options.root ?? join(homedir(), ".coding-agent", "sessions");
      const resolvedRequestedRoot = resolve(requestedRoot);
      if (
        isPathInside(requestedWorkspaceRoot, resolvedRequestedRoot) ||
        isPathInside(workspaceRoot, resolvedRequestedRoot)
      ) {
        throw new SessionTranscriptConfigurationError(
          "The private Session store must be outside the workspace.",
        );
      }

      let root: string;
      try {
        root = await realpath(requestedRoot);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new SessionTranscriptNotFoundError(
            "The requested Session does not exist.",
          );
        }
        throw error;
      }
      if (isPathInside(workspaceRoot, root)) {
        throw new SessionTranscriptConfigurationError(
          "The private Session store must be outside the workspace.",
        );
      }

      const workspaceBucket = `workspace-${createHash("sha256")
        .update(workspaceRoot)
        .digest("hex")
        .slice(0, 16)}`;
      const transcriptPath = join(
        root,
        workspaceBucket,
        options.sessionId,
        "transcript.jsonl",
      );
      try {
        const transcriptStat = await stat(transcriptPath);
        if (!transcriptStat.isFile()) {
          throw new SessionTranscriptNotFoundError(
            "The requested Session does not exist.",
          );
        }
      } catch (error) {
        if (error instanceof SessionTranscriptNotFoundError) {
          throw error;
        }
        if (isMissingPathError(error)) {
          throw new SessionTranscriptNotFoundError(
            "The requested Session does not exist.",
          );
        }
        throw error;
      }

      const store = new SessionTranscriptStore(
        options.sessionId,
        workspaceRoot,
        transcriptPath,
      );
      const events = await store.load();
      const first = events[0];
      if (
        first?.type !== "session_started" ||
        first.workspaceRoot !== workspaceRoot
      ) {
        throw new SessionTranscriptCorruptError(
          "The Session transcript identity is invalid.",
        );
      }
      return store;
    } catch (error) {
      if (
        error instanceof SessionTranscriptConfigurationError ||
        error instanceof SessionTranscriptError
      ) {
        throw error;
      }
      throw new SessionTranscriptConfigurationError(
        "The private Session store could not be opened.",
      );
    }
  }

  async append(event: SessionEventInput): Promise<void> {
    if (this.#needsRepair) {
      await this.load();
    }

    const record = sessionEventSchema.safeParse({
      ...event,
      schemaVersion: 1,
      sessionId: this.#sessionId,
      recordedAt: new Date().toISOString(),
    });
    if (!record.success) {
      throw new SessionTranscriptError("The Session event is invalid.");
    }

    let handle;
    try {
      handle = await open(
        this.#transcriptPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(record.data)}\n`, "utf8");
      await handle.sync();
      this.#needsRepair = false;
    } catch {
      this.#needsRepair = true;
      throw new SessionTranscriptError(
        "The Session event could not be persisted.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async load(): Promise<readonly SessionEvent[]> {
    let handle;
    try {
      handle = await open(
        this.#transcriptPath,
        constants.O_RDWR | constants.O_CREAT,
        0o600,
      );
      await handle.chmod(0o600);
      const content = await handle.readFile();
      const lastNewline = content.lastIndexOf(0x0a);
      const committedLength = lastNewline < 0 ? 0 : lastNewline + 1;
      if (committedLength !== content.length) {
        await handle.truncate(committedLength);
        await handle.sync();
      }

      const committed = content.subarray(0, committedLength).toString("utf8");
      const lines = committed.length === 0 ? [] : committed.slice(0, -1).split("\n");
      const events = lines.map((line) => parseCommittedLine(line));
      for (const event of events) {
        if (event.sessionId !== this.#sessionId) {
          throw new SessionTranscriptCorruptError(
            "The Session transcript contains another session identity.",
          );
        }
      }
      this.#needsRepair = false;
      return events;
    } catch (error) {
      if (error instanceof SessionTranscriptError) {
        throw error;
      }
      throw new SessionTranscriptError(
        "The Session transcript could not be read.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function parseCommittedLine(line: string): SessionEvent {
  try {
    const parsed = sessionEventSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new SessionTranscriptCorruptError(
        "The Session transcript contains an invalid committed event.",
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SessionTranscriptCorruptError) {
      throw error;
    }
    throw new SessionTranscriptCorruptError(
      "The Session transcript contains invalid JSON before its tail.",
    );
  }
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionTranscriptConfigurationError(
      "The Session identity is invalid.",
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
