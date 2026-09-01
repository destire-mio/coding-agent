import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import process from "node:process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import type {
  ToolDefinition,
  ToolExecutionOptions,
} from "../core/contracts.js";
import {
  toolError,
  type RuntimeTool,
  type ToolApprovalPreparation,
  type ToolOutcome,
} from "./tool.js";
import type {
  ToolOutputPair,
  ToolOutputStore,
  ToolOutputWriter,
} from "./tool-output-store.js";

const DEFAULT_SHELL_PATH = "/bin/bash";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_768;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SAFE_ENVIRONMENT_KEYS = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
] as const;

const bashInputSchema = z
  .object({
    command: z
      .string()
      .refine((command) => command.trim().length > 0, "command cannot be empty")
      .refine((command) => !command.includes("\0"), "command cannot contain NUL"),
  })
  .strict();

export interface BashToolOptions {
  readonly workspaceRoot: string;
  readonly outputStore: ToolOutputStore;
  readonly shellPath?: string;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly maxOutputChars?: number;
}

export interface BashResult {
  readonly command: string;
  readonly cwd: string;
  readonly commandStarted: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly processStopped: boolean;
  readonly sideEffectOutcome: "known" | "unknown";
}

export class BashConfigurationError extends Error {}

export class BashTool implements RuntimeTool {
  readonly definition: ToolDefinition = {
    name: "bash",
    description:
      "Run one foreground Bash command in the workspace after explicit user approval. " +
      "Use only when Read or Grep cannot complete the task. The result keeps bounded stdout/stderr previews and separate refs that Read can page for complete output. Background jobs are unsupported.",
    inputSchema: z.toJSONSchema(bashInputSchema, {
      target: "openapi-3.0",
      unrepresentable: "any",
    }) as Record<string, unknown>,
  };

  readonly #workspaceRoot: string;
  readonly #shellPath: string;
  readonly #timeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #maxOutputChars: number;
  readonly #outputStore: ToolOutputStore;

  private constructor(
    workspaceRoot: string,
    shellPath: string,
    timeoutMs: number,
    terminationGraceMs: number,
    maxOutputChars: number,
    outputStore: ToolOutputStore,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#shellPath = shellPath;
    this.#timeoutMs = timeoutMs;
    this.#terminationGraceMs = terminationGraceMs;
    this.#maxOutputChars = maxOutputChars;
    this.#outputStore = outputStore;
  }

  static async create(options: BashToolOptions): Promise<BashTool> {
    if (process.platform === "win32") {
      throw new BashConfigurationError(
        "The foreground Bash milestone currently supports macOS and Linux only.",
      );
    }

    const timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    const terminationGraceMs = positiveInteger(
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      "terminationGraceMs",
    );
    const maxOutputChars = positiveInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      "maxOutputChars",
    );

    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(options.workspaceRoot);
      const workspaceStat = await stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) {
        throw new BashConfigurationError("The workspace root must be a directory.");
      }
    } catch (error) {
      if (error instanceof BashConfigurationError) {
        throw error;
      }
      throw new BashConfigurationError(
        "The workspace root must be an existing readable directory.",
      );
    }

    const requestedShellPath = options.shellPath ?? DEFAULT_SHELL_PATH;
    let shellPath: string;
    try {
      shellPath = await realpath(requestedShellPath);
      await access(shellPath, constants.X_OK);
      const shellStat = await stat(shellPath);
      if (!shellStat.isFile()) {
        throw new BashConfigurationError("The configured Bash path is not a file.");
      }
    } catch (error) {
      if (error instanceof BashConfigurationError) {
        throw error;
      }
      throw new BashConfigurationError(
        "The configured Bash executable is unavailable.",
      );
    }

    return new BashTool(
      workspaceRoot,
      shellPath,
      timeoutMs,
      terminationGraceMs,
      maxOutputChars,
      options.outputStore,
    );
  }

  prepareApproval(input: unknown): ToolApprovalPreparation {
    const parsed = bashInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidArguments();
    }
    return {
      status: "approval_required",
      command: parsed.data.command,
      cwd: this.#workspaceRoot,
    };
  }

  async execute(
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolOutcome> {
    const parsed = bashInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidArguments();
    }
    if (options.signal?.aborted === true) {
      return toolError("cancelled", "Bash was cancelled before it started.");
    }

    return this.#run(parsed.data.command, options.signal);
  }

  async #run(command: string, signal?: AbortSignal): Promise<ToolOutcome> {
    const stdout = new BoundedTextCollector(this.#maxOutputChars);
    const stderr = new BoundedTextCollector(this.#maxOutputChars);
    let logs: ToolOutputPair;
    try {
      logs = await this.#outputStore.createPair();
    } catch {
      return outputStorageStartFailure(command, this.#workspaceRoot);
    }
    let child: ChildProcess;

    try {
      try {
        child = spawn(this.#shellPath, ["-c", command], {
          cwd: this.#workspaceRoot,
          detached: true,
          env: safeChildEnvironment(process.env),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        return startFailure(
          command,
          this.#workspaceRoot,
          error,
          logs.stdout.ref,
          logs.stderr.ref,
        );
      }

      const captures = [
        captureOutput(child.stdout, stdout, logs.stdout),
        captureOutput(child.stderr, stderr, logs.stderr),
      ];
      const exitPromise = waitForChild(child);
      const control = await waitForExitOrStop(
        exitPromise,
        signal,
        this.#timeoutMs,
        firstCaptureFailure(captures),
      );

      if (control.kind === "exit") {
        const captureError = await captureErrorFrom(captures);
        stdout.end();
        stderr.end();
        if (control.error !== undefined) {
          return startFailure(
            command,
            this.#workspaceRoot,
            control.error,
            logs.stdout.ref,
            logs.stderr.ref,
          );
        }
        if (captureError !== undefined) {
          return outputStorageFailure(
            command,
            this.#workspaceRoot,
            control.code,
            control.signal,
            stdout,
            stderr,
            logs,
            true,
          );
        }

        const residualGroup = processGroupExists(child.pid);
        if (residualGroup) {
          const stopped = await terminateProcessGroup(
            child,
            this.#terminationGraceMs,
          );
          const details = bashResult(
            command,
            this.#workspaceRoot,
            control.code,
            control.signal,
            stdout,
            stderr,
            logs,
            stopped,
            "unknown",
          );
          return toolError(
            stopped ? "background_process_not_supported" : "termination_unknown",
            stopped
              ? "The command left a background process, which this milestone does not support."
              : "The command left a process that could not be confirmed stopped.",
            false,
            details,
          );
        }

        const details = bashResult(
          command,
          this.#workspaceRoot,
          control.code,
          control.signal,
          stdout,
          stderr,
          logs,
          true,
          "known",
        );
        if (control.code === 0) {
          return { status: "success", output: details };
        }
        return toolError(
          "command_failed",
          `Bash exited with code ${control.code ?? "unknown"}.`,
          false,
          details,
        );
      }

      const stopped = await terminateProcessGroup(child, this.#terminationGraceMs);
      const exit = await waitForExitAfterTermination(
        exitPromise,
        this.#terminationGraceMs,
      );
      if (!stopped || exit === undefined) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      const captureError = await captureErrorFrom(captures);
      stdout.end();
      stderr.end();

      const details = bashResult(
        command,
        this.#workspaceRoot,
        exit?.code ?? null,
        exit?.signal ?? null,
        stdout,
        stderr,
        logs,
        stopped && exit !== undefined,
        "unknown",
      );
      if (control.kind === "output_storage_failed" || captureError !== undefined) {
        return toolError(
          "output_storage_failed",
          "Bash was stopped because its complete output could not be stored safely.",
          false,
          details,
        );
      }
      if (!details.processStopped) {
        return toolError(
          "termination_unknown",
          "The Bash process group could not be confirmed stopped.",
          false,
          details,
        );
      }
      return toolError(
        control.kind === "cancelled" ? "cancelled" : "command_timeout",
        control.kind === "cancelled"
          ? "Bash was cancelled and its process group was stopped."
          : "Bash exceeded its time limit and its process group was stopped.",
        false,
        details,
      );
    } finally {
      await logs.close();
    }
  }
}

type ChildExit = {
  readonly kind: "exit";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
};

type ProcessControl = ChildExit | {
  readonly kind: "cancelled" | "timeout" | "output_storage_failed";
};

function waitForChild(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolve({ kind: "exit", code: null, signal: null, error });
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ kind: "exit", code, signal });
      }
    });
  });
}

async function captureOutput(
  stream: Readable | null,
  collector: BoundedTextCollector,
  writer: ToolOutputWriter,
): Promise<void> {
  if (stream === null) {
    return;
  }
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    collector.push(bytes);
    await writer.write(bytes);
  }
}

function firstCaptureFailure(
  captures: readonly Promise<void>[],
): Promise<ProcessControl> {
  return new Promise((resolve) => {
    for (const capture of captures) {
      void capture.catch(() => resolve({ kind: "output_storage_failed" }));
    }
  });
}

async function captureErrorFrom(
  captures: readonly Promise<void>[],
): Promise<unknown | undefined> {
  const results = await Promise.allSettled(captures);
  return results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )?.reason;
}

async function waitForExitOrStop(
  exit: Promise<ChildExit>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  captureFailure: Promise<ProcessControl>,
): Promise<ProcessControl> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<ProcessControl>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (signal !== undefined) {
      onAbort = () => resolve({ kind: "cancelled" });
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });

  try {
    return await Promise.race([exit, stop, captureFailure]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function terminateProcessGroup(
  child: ChildProcess,
  graceMs: number,
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined || !processGroupExists(pid)) {
    return true;
  }

  signalProcessGroup(child, "SIGTERM");
  if (await waitForProcessGroupExit(pid, graceMs)) {
    return true;
  }
  signalProcessGroup(child, "SIGKILL");
  return waitForProcessGroupExit(pid, graceMs);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The caller verifies whether the process group actually stopped.
      }
    }
  }
}

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function waitForExitAfterTermination(
  exit: Promise<ChildExit>,
  timeoutMs: number,
): Promise<ChildExit | undefined> {
  return Promise.race([
    exit,
    delay(timeoutMs).then(() => undefined),
  ]);
}

function safeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? DEFAULT_PATH,
  };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function bashResult(
  command: string,
  cwd: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout: BoundedTextCollector,
  stderr: BoundedTextCollector,
  logs: ToolOutputPair,
  processStopped: boolean,
  sideEffectOutcome: "known" | "unknown",
): BashResult {
  return {
    command,
    cwd,
    commandStarted: true,
    exitCode,
    signal,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutRef: logs.stdout.ref,
    stderrRef: logs.stderr.ref,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    processStopped,
    sideEffectOutcome,
  };
}

function startFailure(
  command: string,
  cwd: string,
  error: unknown,
  stdoutRef: string,
  stderrRef: string,
): ToolOutcome {
  const code = isNodeError(error) ? error.code : undefined;
  return toolError(
    code === "ENOENT" || code === "EACCES"
      ? "shell_unavailable"
      : "command_start_failed",
    "Bash could not be started.",
    false,
    {
      command,
      cwd,
      commandStarted: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutRef,
      stderrRef,
      stdoutTruncated: false,
      stderrTruncated: false,
      processStopped: true,
      sideEffectOutcome: "known",
    },
  );
}

function outputStorageStartFailure(command: string, cwd: string): ToolOutcome {
  return toolError(
    "output_storage_failed",
    "Bash was not started because its private output logs could not be created.",
    false,
    {
      command,
      cwd,
      commandStarted: false,
      processStopped: true,
      sideEffectOutcome: "known",
    },
  );
}

function outputStorageFailure(
  command: string,
  cwd: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout: BoundedTextCollector,
  stderr: BoundedTextCollector,
  logs: ToolOutputPair,
  processStopped: boolean,
): ToolOutcome {
  return toolError(
    "output_storage_failed",
    "Bash completed, but its complete output could not be stored safely.",
    false,
    bashResult(
      command,
      cwd,
      exitCode,
      signal,
      stdout,
      stderr,
      logs,
      processStopped,
      "unknown",
    ),
  );
}

function invalidArguments(): ToolApprovalPreparation & ToolOutcome {
  return {
    status: "error",
    error: {
      code: "invalid_arguments",
      message: "Bash expects exactly one non-empty command without NUL.",
      retryable: false,
    },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BashConfigurationError(`${name} must be a positive integer.`);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BoundedTextCollector {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxChars: number;
  #text = "";
  #truncated = false;

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  get text(): string {
    return this.#text;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  push(chunk: Buffer): void {
    this.#append(this.#decoder.write(chunk));
  }

  end(): void {
    this.#append(this.#decoder.end());
  }

  #append(value: string): void {
    const remaining = this.#maxChars - this.#text.length;
    if (value.length > remaining) {
      this.#text += value.slice(0, Math.max(0, remaining));
      this.#truncated = true;
      return;
    }
    this.#text += value;
  }
}
