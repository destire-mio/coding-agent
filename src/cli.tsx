#!/usr/bin/env node

import { resolve } from "node:path";
import process from "node:process";
import { render } from "ink";

import { AgentCore } from "./core/agent-core.js";
import { ConfigurationError, loadProviderConfig } from "./provider/config.js";
import { OpenAICompatibleProvider } from "./provider/openai-compatible-provider.js";
import { BashConfigurationError } from "./runtime/bash-tool.js";
import {
  EditOperationStoreConfigurationError,
} from "./runtime/edit-operation-store.js";
import { WorkspaceConfigurationError } from "./runtime/read-tool.js";
import { ToolRuntime } from "./runtime/tool-runtime.js";
import { ToolOutputStoreConfigurationError } from "./runtime/tool-output-store.js";
import {
  SessionTranscriptConfigurationError,
  SessionTranscriptError,
  SessionTranscriptStore,
} from "./session/session-transcript-store.js";
import {
  foldSessionTranscript,
  type ResumableSessionState,
} from "./session/session-transcript-fold.js";
import {
  SessionBusyError,
  type SessionRunLease,
  SessionRunLeaseError,
} from "./session/session-run-lease.js";
import { AgentApp } from "./tui/agent-app.js";

interface CliOptions {
  readonly workspace: string;
  readonly maxSteps: number;
  readonly prompt?: string;
  readonly continueSessionId?: string;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n\n${usage()}`);
    return 2;
  }
  if (
    options.continueSessionId === undefined &&
    options.prompt === undefined &&
    !process.stdin.isTTY
  ) {
    process.stderr.write(
      "Interactive mode requires a terminal. Use --prompt for a new task.\n",
    );
    return 2;
  }

  let lease: SessionRunLease | undefined;
  const configuredSessionRoot = process.env.CODING_AGENT_SESSION_ROOT?.trim();
  const sessionRoot =
    configuredSessionRoot === undefined || configuredSessionRoot.length === 0
      ? undefined
      : resolve(configuredSessionRoot);
  try {
    let providerConfig;
    let runtime: ToolRuntime;
    let session: SessionTranscriptStore | undefined;
    let resumeState: ResumableSessionState | undefined;
    try {
      if (options.continueSessionId !== undefined) {
        const opened = await SessionTranscriptStore.openForRun({
          workspaceRoot: options.workspace,
          sessionId: options.continueSessionId,
          ...(sessionRoot === undefined ? {} : { root: sessionRoot }),
        });
        session = opened.session;
        lease = opened.lease;
        const state = foldSessionTranscript(opened.events);
        if (state.kind === "no_turn") {
          process.stderr.write(
            `Session ${state.sessionId} has no unfinished Turn to resume.\n`,
          );
          return 1;
        }
        if (state.kind === "finished") {
          process.stderr.write(
            `Session ${state.sessionId} is already finished (${state.turn.outcome}).\n`,
          );
          return 1;
        }
        resumeState = state;
      }

      providerConfig = loadProviderConfig();
      runtime = await ToolRuntime.withEdit({ workspaceRoot: options.workspace });
      if (session === undefined) {
        session = await SessionTranscriptStore.create({
          workspaceRoot: options.workspace,
          ...(sessionRoot === undefined ? {} : { root: sessionRoot }),
        });
        lease = await session.acquireRunLease();
      }
    } catch (error) {
      if (error instanceof SessionBusyError) {
        process.stderr.write(`${error.message}\n`);
        return 1;
      }
      if (
        error instanceof ConfigurationError ||
        error instanceof BashConfigurationError ||
        error instanceof EditOperationStoreConfigurationError ||
        error instanceof SessionRunLeaseError ||
        error instanceof SessionTranscriptConfigurationError ||
        error instanceof SessionTranscriptError ||
        error instanceof ToolOutputStoreConfigurationError ||
        error instanceof WorkspaceConfigurationError
      ) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      process.stderr.write("Failed to initialize the coding agent.\n");
      return 2;
    }
    if (session === undefined) {
      process.stderr.write("Failed to initialize the Session.\n");
      return 2;
    }
    const provider = new OpenAICompatibleProvider(providerConfig);
    const core = new AgentCore(provider, runtime, {
      maxSteps: options.maxSteps,
      session,
    });
    let exitCode = 1;

    const app = render(
      <AgentApp
        core={core}
        workspace={options.workspace}
        sessionId={session.sessionId}
        {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
        {...(resumeState === undefined ? {} : { resumeState })}
        onComplete={(result) => {
          exitCode = result.kind === "final_answer" ? 0 : 1;
        }}
      />,
    );
    await app.waitUntilExit();
    return exitCode;
  } finally {
    if (lease !== undefined) {
      await lease.release().catch((error: unknown) => {
        process.stderr.write(`${safeMessage(error)}\n`);
      });
    }
  }
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  let workspace = process.cwd();
  let maxSteps = 8;
  let prompt: string | undefined;
  let continueSessionId: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (argument === "--workspace") {
      workspace = requireValue(arguments_, ++index, "--workspace");
      continue;
    }
    if (argument === "--max-steps") {
      const raw = requireValue(arguments_, ++index, "--max-steps");
      maxSteps = Number(raw);
      if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
        throw new Error("--max-steps must be a positive integer.");
      }
      continue;
    }
    if (argument === "--prompt") {
      prompt = requireValue(arguments_, ++index, "--prompt");
      continue;
    }
    if (argument === "--continue") {
      continueSessionId = requireValue(arguments_, ++index, "--continue");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (prompt !== undefined && continueSessionId !== undefined) {
    throw new Error("--prompt cannot be combined with --continue.");
  }

  return {
    workspace: resolve(workspace),
    maxSteps,
    ...(prompt === undefined ? {} : { prompt }),
    ...(continueSessionId === undefined ? {} : { continueSessionId }),
  };
}

function requireValue(
  arguments_: readonly string[],
  index: number,
  option: string,
): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid command line arguments.";
}

function usage(): string {
  return `Usage: coding-agent [options]\n\nOptions:\n  --workspace <path>   Workspace root (default: current directory)\n  --prompt <text>      Run one new task immediately instead of prompting\n  --continue <id>      Resume one unfinished Session in this workspace\n  --max-steps <count>  Maximum model rounds (default: 8)\n  -h, --help           Show this help\n`;
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
