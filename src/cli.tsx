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
import { AgentApp } from "./tui/agent-app.js";

interface CliOptions {
  readonly workspace: string;
  readonly maxSteps: number;
  readonly prompt?: string;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n\n${usage()}`);
    return 2;
  }

  let providerConfig;
  let runtime: ToolRuntime;
  let session: SessionTranscriptStore;
  try {
    providerConfig = loadProviderConfig();
    runtime = await ToolRuntime.withEdit({ workspaceRoot: options.workspace });
    session = await SessionTranscriptStore.create({
      workspaceRoot: options.workspace,
    });
  } catch (error) {
    if (
      error instanceof ConfigurationError ||
      error instanceof BashConfigurationError ||
      error instanceof EditOperationStoreConfigurationError ||
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
      {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
      onComplete={(result) => {
        exitCode = result.kind === "final_answer" ? 0 : 1;
      }}
    />,
  );
  await app.waitUntilExit();
  return exitCode;
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  let workspace = process.cwd();
  let maxSteps = 8;
  let prompt: string | undefined;

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
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    workspace: resolve(workspace),
    maxSteps,
    ...(prompt === undefined ? {} : { prompt }),
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
  return `Usage: coding-agent [options]\n\nOptions:\n  --workspace <path>   Workspace root (default: current directory)\n  --prompt <text>      Run one task immediately instead of prompting\n  --max-steps <count>  Maximum model rounds (default: 8)\n  -h, --help           Show this help\n`;
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
