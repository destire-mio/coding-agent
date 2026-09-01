import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Observation, ToolCall } from "../src/core/contracts.js";
import {
  BashTool,
  type BashResult,
} from "../src/runtime/bash-tool.js";
import { ToolOutputStore } from "../src/runtime/tool-output-store.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("BashTool", () => {
  it("rejects invalid Bash parameters before requesting approval", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace),
    ]);
    let approvalCount = 0;

    const observation = await runtime.execute(
      {
        id: "call-invalid-bash",
        name: "bash",
        rawArguments: JSON.stringify({ command: "", cwd: "/tmp" }),
      },
      {
        requestApproval: async () => {
          approvalCount += 1;
          return "approved";
        },
      },
    );

    expect(observation.status).toBe("error");
    if (observation.status === "error") {
      expect(observation.error.code).toBe("invalid_arguments");
    }
    expect(approvalCount).toBe(0);
  });

  it("runs an approved command in the workspace without Provider secrets", async () => {
    const workspace = await createWorkspace();
    vi.stubEnv("DEEPSEEK_API_KEY", "MUST_NOT_REACH_CHILD");
    const runtime = new ToolRuntime([
      await createBashTool(workspace),
    ]);

    const observation = await runtime.execute(
      bashCall(
        'printf \'%s|%s\' "$PWD" "${DEEPSEEK_API_KEY-unset}"; printf \'warning\' >&2',
      ),
      { requestApproval: async () => "approved" },
    );

    const result = successResult(observation);
    expect(result).toMatchObject({
      cwd: workspace,
      commandStarted: true,
      exitCode: 0,
      signal: null,
      stdout: `${workspace}|unset`,
      stderr: "warning",
      stdoutTruncated: false,
      stderrTruncated: false,
      processStopped: true,
      sideEffectOutcome: "known",
    });
  });

  it("returns non-zero exits as command_failed with stdout and stderr evidence", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace),
    ]);

    const observation = await runtime.execute(
      bashCall("printf 'before'; printf 'failure' >&2; exit 7"),
      { requestApproval: async () => "approved" },
    );

    const result = errorResult(observation, "command_failed");
    expect(result).toMatchObject({
      commandStarted: true,
      exitCode: 7,
      stdout: "before",
      stderr: "failure",
      processStopped: true,
    });
  });

  it("reports a missing command as a completed Bash failure", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace),
    ]);

    const observation = await runtime.execute(
      bashCall("definitely_missing_coding_agent_command"),
      { requestApproval: async () => "approved" },
    );

    const result = errorResult(observation, "command_failed");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
    expect(result.commandStarted).toBe(true);
  });

  it("bounds captured output while continuing to drain the process", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace, { maxOutputChars: 5 }),
    ]);

    const observation = await runtime.execute(bashCall("printf '123456789'"), {
      requestApproval: async () => "approved",
    });

    const result = successResult(observation);
    expect(result.stdout).toBe("12345");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("times out and terminates the whole process group", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace, {
        timeoutMs: 150,
        terminationGraceMs: 250,
      }),
    ]);

    const observation = await runtime.execute(
      bashCall('sleep 30 & child=$!; printf "%s" "$child"; wait "$child"'),
      { requestApproval: async () => "approved" },
    );

    const result = errorResult(observation, "command_timeout");
    const childPid = Number(result.stdout);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(result).toMatchObject({
      processStopped: true,
      sideEffectOutcome: "unknown",
    });
    await expectProcessGone(childPid);
  });

  it("cancels and terminates the whole process group", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace, {
        timeoutMs: 30_000,
        terminationGraceMs: 250,
      }),
    ]);
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 100);

    const observation = await runtime.execute(
      bashCall('sleep 30 & child=$!; printf "%s" "$child"; wait "$child"'),
      {
        signal: controller.signal,
        requestApproval: async () => "approved",
      },
    );
    clearTimeout(cancellation);

    const result = errorResult(observation, "cancelled");
    const childPid = Number(result.stdout);
    expect(result.processStopped).toBe(true);
    await expectProcessGone(childPid);
  });

  it("cleans up and rejects a detached background command", async () => {
    const workspace = await createWorkspace();
    const runtime = new ToolRuntime([
      await createBashTool(workspace, {
        terminationGraceMs: 250,
      }),
    ]);

    const observation = await runtime.execute(
      bashCall('sleep 30 >/dev/null 2>&1 & printf "%s" "$!"'),
      { requestApproval: async () => "approved" },
    );

    const result = errorResult(observation, "background_process_not_supported");
    const childPid = Number(result.stdout);
    expect(result.processStopped).toBe(true);
    await expectProcessGone(childPid);
  });
});

function bashCall(command: string): ToolCall {
  return {
    id: "call-bash",
    name: "bash",
    rawArguments: JSON.stringify({ command }),
  };
}

function successResult(observation: Observation): BashResult {
  expect(observation.status).toBe("success");
  if (observation.status !== "success") {
    throw new Error("Expected a successful Bash Observation.");
  }
  return observation.output as BashResult;
}

function errorResult(observation: Observation, code: string): BashResult {
  expect(observation.status).toBe("error");
  if (observation.status !== "error") {
    throw new Error("Expected an error Bash Observation.");
  }
  expect(observation.error.code).toBe(code);
  return observation.error.details as BashResult;
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "coding-agent-bash-"));
  temporaryRoots.push(workspace);
  return realpath(workspace);
}

async function createBashTool(
  workspace: string,
  options: {
    readonly timeoutMs?: number;
    readonly terminationGraceMs?: number;
    readonly maxOutputChars?: number;
  } = {},
): Promise<BashTool> {
  const outputRoot = await mkdtemp(join(tmpdir(), "coding-agent-output-"));
  temporaryRoots.push(outputRoot);
  return BashTool.create({
    workspaceRoot: workspace,
    outputStore: await ToolOutputStore.create({ root: outputRoot }),
    ...options,
  });
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} is still alive.`);
}
