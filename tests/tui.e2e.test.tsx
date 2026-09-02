import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunResult,
  ToolExecutor,
} from "../src/core/contracts.js";
import { ProviderError } from "../src/core/provider-error.js";
import { BashTool, type BashResult } from "../src/runtime/bash-tool.js";
import { ToolOutputStore } from "../src/runtime/tool-output-store.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { foldSessionTranscript } from "../src/session/session-transcript-fold.js";
import { SessionTranscriptStore } from "../src/session/session-transcript-store.js";
import type {
  RuntimeTool,
  ToolApprovalPreparation,
  ToolOutcome,
} from "../src/runtime/tool.js";
import { AgentApp } from "../src/tui/agent-app.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("renders the complete Read trajectory and final answer in the TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "TUI_E2E_MARKER\n", "utf8");

  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [
        { type: "think", think: "I need to inspect README.md." },
      ],
      calls: [
        {
          id: "call-tui-read",
          name: "read",
          rawArguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    },
    new ProviderError("rate_limit", "slow down", { retryable: true }),
    {
      kind: "final",
      content: [
        { type: "think", think: "The Read Observation contains the marker." },
        { type: "text", text: "The README contains TUI_E2E_MARKER." },
      ],
    },
  ]);
  const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
  const core = new AgentCore(provider, runtime, {
    providerRetry: {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    },
  });

  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="读取 README.md 并总结"
      onComplete={finish}
    />,
  );

  const result = await completion;
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(result.kind).toBe("final_answer");
  expect(provider.requests).toHaveLength(3);
  expect(view.lastFrame()).toContain("tool call read (call-tui-read)");
  expect(view.lastFrame()).toContain("observation success (call-tui-read)");
  expect(view.lastFrame()).toContain(
    "retry provider attempt 2/3 after rate_limit (0ms)",
  );
  expect(view.lastFrame()).toContain(
    "step 1 thinking › I need to inspect README.md.",
  );
  expect(view.lastFrame()).toContain(
    "step 2 thinking › The Read Observation contains the marker.",
  );
  expect(view.lastFrame()).not.toContain(
    "partial reasoning from failed attempt",
  );
  expect(view.lastFrame()).toContain("The README contains TUI_E2E_MARKER.");
  expect(
    view.frames.some((frame) =>
      frame.includes('draft read (call-tui-read) › {"path":"READ'),
    ),
  ).toBe(true);
  expect(
    view.frames.some((frame) =>
      frame.includes("stream › The README contains TUI_E2E_MARKER."),
    ),
  ).toBe(true);
  expect(
    view.frames.some((frame) =>
      frame.includes("thinking › The Read Observation contains the marker."),
    ),
  ).toBe(true);
  view.unmount();
});

it("accepts a second task in the same interactive Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-multi-turn-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "License: MIT\n", "utf8");
  const session = await SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: join(root, "sessions"),
    sessionId: "interactive-session",
  });

  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [{ type: "think", think: "PRIVATE_TUI_REASONING" }],
      calls: [
        {
          id: "call-tui-first-turn",
          name: "read",
          rawArguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    },
    {
      kind: "final",
      content: [{ type: "text", text: "README inspected." }],
    },
    {
      kind: "final",
      content: [{ type: "text", text: "The license is MIT." }],
    },
  ]);
  const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
  const core = new AgentCore(provider, runtime, { session, maxSteps: 4 });
  const results: RunResult[] = [];
  let finishFirst: () => void = () => undefined;
  let finishSecond: () => void = () => undefined;
  const firstCompletion = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondCompletion = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      sessionId={session.sessionId}
      onComplete={(result) => {
        results.push(result);
        if (results.length === 1) {
          finishFirst();
        } else if (results.length === 2) {
          finishSecond();
        }
      }}
    />,
  );

  await waitForFrame(view, "task ›");
  view.stdin.write("读取 README.md 并总结");
  await renderTurn();
  view.stdin.write("\r");
  await firstCompletion;
  await waitForFrame(view, "task ›");
  expect(view.lastFrame()).toContain("README inspected.");
  expect(view.lastFrame()).toContain("task ›");

  view.stdin.write("它的许可证是什么？");
  await renderTurn();
  view.stdin.write("\r");
  await secondCompletion;
  await waitForFrame(view, "task ›");
  expect(view.lastFrame()).toContain("The license is MIT.");

  expect(results).toHaveLength(2);
  expect(results[1]).toMatchObject({
    kind: "final_answer",
    answer: "The license is MIT.",
  });
  expect(provider.requests).toHaveLength(3);
  expect(JSON.stringify(provider.requests[2])).toContain("License: MIT");
  expect(JSON.stringify(provider.requests[2])).not.toContain(
    "PRIVATE_TUI_REASONING",
  );
  const transcript = await session.load();
  expect(transcript.map((event) => event.type)).toEqual([
    "session_started",
    "turn_started",
    "tool_intent",
    "tool_observation",
    "turn_finished",
    "turn_started",
    "turn_finished",
  ]);
  expect(
    transcript
      .filter((event) => event.type === "turn_started")
      .map((event) => event.turnId),
  ).toHaveLength(2);
  expect(
    new Set(
      transcript
        .filter((event) => event.type === "turn_started")
        .map((event) => event.turnId),
    ).size,
  ).toBe(2);
  expect(view.lastFrame()).toContain("task ›");
  view.unmount();
});

it("opens a finished Session without a model request until the user submits", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-reopen-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: join(root, "sessions"),
    sessionId: "tui-reopen-session",
  });
  await session.append({
    type: "turn_started",
    turnId: "tui-previous-turn",
    userInput: "What is this project?",
  });
  await session.append({
    type: "turn_finished",
    turnId: "tui-previous-turn",
    outcome: "completed",
    answer: "A coding agent.",
    steps: 1,
  });
  const previousEvents = await session.load();
  const initialSession = foldSessionTranscript(previousEvents);
  if (initialSession.kind !== "finished") {
    throw new Error("Expected a finished Session.");
  }
  const provider = new StreamingScriptedProvider([
    { kind: "final", content: [{ type: "text", text: "REOPENED_TUI_ANSWER" }] },
  ]);
  const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
  const core = new AgentCore(provider, runtime, { session, initialSession });
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      sessionId={session.sessionId}
      onComplete={finish}
    />,
  );

  await waitForFrame(view, "task ›");
  await renderTurn(50);
  expect(provider.requests).toHaveLength(0);
  expect(await session.load()).toEqual(previousEvents);
  expect(view.lastFrame()).toContain("session: tui-reopen-session");

  view.stdin.write("Tell me more");
  await renderTurn();
  view.stdin.write("\r");
  expect((await completion).kind).toBe("final_answer");
  await waitForFrame(view, "task ›");
  expect(view.lastFrame()).toContain("REOPENED_TUI_ANSWER");
  expect(provider.requests[0]?.messages).toEqual([
    ...initialSession.messages,
    { role: "user", content: "Tell me more" },
  ]);
  view.unmount();
});

it("auto-starts a selected unfinished Session through Core resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-resume-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: join(root, "sessions"),
    sessionId: "tui-resume-session",
  });
  await session.append({
    type: "turn_started",
    turnId: "tui-resume-turn",
    userInput: "Read README.md",
  });
  await session.append({
    type: "tool_intent",
    turnId: "tui-resume-turn",
    step: 1,
    operationId: "tui-resume-operation",
    call: {
      id: "tui-resume-call",
      name: "read",
      rawArguments: JSON.stringify({ path: "README.md" }),
    },
    replayContent: [{ type: "think", think: "I need README.md." }],
  });
  await session.append({
    type: "tool_observation",
    turnId: "tui-resume-turn",
    step: 1,
    operationId: "tui-resume-operation",
    observation: {
      toolCallId: "tui-resume-call",
      toolName: "read",
      status: "success",
      output: { content: "TUI_RESUME_MARKER" },
    },
  });
  const resumeState = foldSessionTranscript(await session.load());
  if (resumeState.kind !== "awaiting_model") {
    throw new Error("Expected an awaiting-model state.");
  }
  const provider = new StreamingScriptedProvider([
    {
      kind: "final",
      content: [{ type: "text", text: "Recovered TUI_RESUME_MARKER." }],
    },
  ]);
  let runtimeCalls = 0;
  const runtime: ToolExecutor = {
    definitions: () => [],
    execute: async () => {
      runtimeCalls += 1;
      throw new Error("The TUI must not replay an observed tool.");
    },
  };
  const core = new AgentCore(provider, runtime, { session, maxSteps: 4 });
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      sessionId={session.sessionId}
      resumeState={resumeState}
      onComplete={finish}
    />,
  );

  const result = await completion;
  await renderTurn();

  expect(result).toMatchObject({
    kind: "final_answer",
    answer: "Recovered TUI_RESUME_MARKER.",
  });
  expect(runtimeCalls).toBe(0);
  expect(provider.requests).toHaveLength(1);
  expect(
    view.frames.some((frame) =>
      frame.includes("session: tui-resume-session · resuming"),
    ),
  ).toBe(true);
  expect(
    view.frames.some((frame) => frame.includes("Recovered TUI_RESUME_MARKER.")),
  ).toBe(true);
  view.unmount();
});

it("routes Esc through the Core state machine and cancels the provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-cancel-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  let markProviderStarted: () => void = () => undefined;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  let providerWasAborted = false;
  const provider: ModelProvider = {
    complete: async (_request, options) => {
      markProviderStarted();
      return new Promise<ModelResponse>((_resolve, reject) => {
        const rejectCancelled = () => {
          providerWasAborted = true;
          reject(
            options?.signal?.reason ??
              new DOMException("The request was cancelled.", "AbortError"),
          );
        };
        if (options?.signal?.aborted === true) {
          rejectCancelled();
          return;
        }
        options?.signal?.addEventListener("abort", rejectCancelled, {
          once: true,
        });
      });
    },
  };
  const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
  const core = new AgentCore(provider, runtime);
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="读取 README.md"
      onComplete={finish}
    />,
  );

  await providerStarted;
  await renderTurn(50);
  expect(view.lastFrame()).toContain("running… · Esc to cancel");

  view.stdin.write("\u001B");
  const result = await completion;
  await renderTurn();

  expect(result).toMatchObject({ kind: "stopped", reason: "cancelled" });
  expect(providerWasAborted).toBe(true);
  expect(core.state).toEqual({ phase: "settled", outcome: "cancelled" });
  expect(
    view.frames.some((frame) => frame.includes("stopped: cancelled")),
  ).toBe(true);
  view.unmount();
});

it("shows the exact dangerous tool request and rejects it before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-approval-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const tool = new TuiApprovalProbeTool(workspace);
  const runtime = new ToolRuntime([tool]);
  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: "call-tui-bash",
          name: "bash",
          rawArguments: JSON.stringify({ command: "npm test" }),
        },
      ],
    },
    {
      kind: "final",
      content: [{ type: "text", text: "The command was not executed." }],
    },
  ]);
  const core = new AgentCore(provider, runtime);
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="运行测试"
      onComplete={finish}
    />,
  );

  await Promise.race([
    waitForFrame(view, "approval required: bash"),
    completion.then((earlyResult) => {
      throw new Error(
        `Run completed before approval: ${JSON.stringify(earlyResult)}`,
      );
    }),
  ]);
  expect(view.lastFrame()).toContain("command: npm test");
  expect(view.lastFrame()).toContain(`cwd: ${workspace}`);

  view.stdin.write("n");
  const result = await completion;
  await renderTurn();

  expect(result.kind).toBe("final_answer");
  expect(tool.executionCount).toBe(0);
  expect(
    result.messages.some(
      (message) =>
        message.role === "tool" &&
        message.observation.status === "error" &&
        message.observation.error.code === "approval_rejected",
    ),
  ).toBe(true);
  expect(
    view.frames.some((frame) =>
      frame.includes("observation error approval_rejected (call-tui-bash)"),
    ),
  ).toBe(true);
  view.unmount();
});

it("shows the Runtime-generated Edit diff and rejects it before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-edit-approval-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const tool = new TuiEditApprovalProbeTool();
  const runtime = new ToolRuntime([tool]);
  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: "call-tui-edit",
          name: "edit",
          rawArguments: JSON.stringify({
            path: "config.ts",
            old_string: "timeout=120",
            new_string: "timeout=180",
            expected_version: "file-version-v1:test",
          }),
        },
      ],
    },
    {
      kind: "final",
      content: [{ type: "text", text: "The edit was rejected." }],
    },
  ]);
  const core = new AgentCore(provider, runtime);
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="修改超时"
      onComplete={finish}
    />,
  );

  await waitForFrame(view, "approval required: edit");
  expect(view.lastFrame()).toContain("path: config.ts");
  expect(view.lastFrame()).toContain("version: file-version-v1:test");
  expect(view.lastFrame()).toContain("-timeout=120");
  expect(view.lastFrame()).toContain("+timeout=180");

  view.stdin.write("n");
  const result = await completion;
  await renderTurn();

  expect(result.kind).toBe("final_answer");
  expect(tool.executionCount).toBe(0);
  expect(
    result.messages.some(
      (message) =>
        message.role === "tool" &&
        message.observation.status === "error" &&
        message.observation.error.code === "approval_rejected",
    ),
  ).toBe(true);
  view.unmount();
});

it("cancels a pending approval without executing the dangerous tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-approval-cancel-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const tool = new TuiApprovalProbeTool(workspace);
  const runtime = new ToolRuntime([tool]);
  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: "call-cancel-bash",
          name: "bash",
          rawArguments: JSON.stringify({ command: "npm test" }),
        },
      ],
    },
  ]);
  const core = new AgentCore(provider, runtime);
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="运行测试"
      onComplete={finish}
    />,
  );

  await waitForFrame(view, "approval required: bash");
  view.stdin.write("\u001B");
  const result = await completion;
  await renderTurn();

  expect(result).toMatchObject({ kind: "stopped", reason: "cancelled" });
  expect(tool.executionCount).toBe(0);
  expect(result.messages.some((message) => message.role === "tool")).toBe(false);
  expect(core.state).toEqual({ phase: "settled", outcome: "cancelled" });
  view.unmount();
});

it("runs a real foreground Bash command only after TUI approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-real-bash-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const runtime = await ToolRuntime.withBash({
    workspaceRoot: workspace,
    toolOutputRoot: join(root, "tool-output"),
  });
  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: "call-real-bash",
          name: "bash",
          rawArguments: JSON.stringify({
            command:
              "printf 'BASH_TUI_MARKER'; printf 'BASH_TUI_WARNING' >&2",
          }),
        },
      ],
    },
    {
      kind: "final",
      content: [{ type: "text", text: "The command returned BASH_TUI_MARKER." }],
    },
  ]);
  const core = new AgentCore(provider, runtime);
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="运行本地标记命令"
      onComplete={finish}
    />,
  );

  await waitForFrame(view, "approval required: bash");
  view.stdin.write("y");
  const result = await completion;
  await renderTurn();

  expect(result.kind).toBe("final_answer");
  expect(JSON.stringify(provider.requests[1])).toContain("BASH_TUI_MARKER");
  expect(JSON.stringify(provider.requests[1])).toContain("BASH_TUI_WARNING");
  const toolMessage = result.messages.find(
    (message) =>
      message.role === "tool" && message.toolCallId === "call-real-bash",
  );
  expect(toolMessage?.role).toBe("tool");
  if (toolMessage?.role === "tool") {
    expect(toolMessage.observation.status).toBe("success");
    if (toolMessage.observation.status === "success") {
      const output = toolMessage.observation.output as BashResult;
      expect(output.stdout).toBe("BASH_TUI_MARKER");
      expect(output.stderr).toBe("BASH_TUI_WARNING");
      expect(output.exitCode).toBe(0);
    }
  }
  expect(
    view.frames.some((frame) =>
      frame.includes("The command returned BASH_TUI_MARKER."),
    ),
  ).toBe(true);
  view.unmount();
});

it("routes Esc through Core and stops a real Bash process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-bash-cancel-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const runtime = new ToolRuntime([
    await BashTool.create({
      workspaceRoot: workspace,
      outputStore: await ToolOutputStore.create({
        root: join(root, "tool-output"),
      }),
      timeoutMs: 30_000,
      terminationGraceMs: 250,
    }),
  ]);
  const provider = new StreamingScriptedProvider([
    {
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: "call-real-bash-cancel",
          name: "bash",
          rawArguments: JSON.stringify({
            command:
              'sleep 30 & child=$!; printf "%s" "$child"; wait "$child"',
          }),
        },
      ],
    },
  ]);
  const core = new AgentCore(provider, runtime);
  let finish: (result: RunResult) => void = () => undefined;
  const completion = new Promise<RunResult>((resolve) => {
    finish = resolve;
  });
  const view = render(
    <AgentApp
      core={core}
      workspace={workspace}
      initialPrompt="运行后取消"
      onComplete={finish}
    />,
  );

  await waitForFrame(view, "approval required: bash");
  view.stdin.write("y");
  await renderTurn(100);
  view.stdin.write("\u001B");
  const result = await completion;
  await renderTurn();

  expect(result).toMatchObject({ kind: "stopped", reason: "cancelled" });
  const toolMessage = result.messages.find(
    (message) =>
      message.role === "tool" &&
      message.toolCallId === "call-real-bash-cancel",
  );
  expect(toolMessage?.role).toBe("tool");
  if (
    toolMessage?.role === "tool" &&
    toolMessage.observation.status === "error"
  ) {
    expect(toolMessage.observation.error.code).toBe("cancelled");
    const details = toolMessage.observation.error.details as BashResult;
    expect(details.processStopped).toBe(true);
    await expectProcessGone(Number(details.stdout));
  }
  view.unmount();
});

class TuiApprovalProbeTool implements RuntimeTool {
  readonly definition = {
    name: "bash",
    description: "Approval TUI test tool.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  };
  readonly #workspace: string;
  executionCount = 0;

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  prepareApproval(input: unknown): ToolApprovalPreparation {
    const command = approvalCommand(input);
    if (command === undefined) {
      return {
        status: "error",
        error: {
          code: "invalid_arguments",
          message: "Bash expects one non-empty command.",
          retryable: false,
        },
      };
    }
    return {
      status: "approval_required",
      approval: {
        kind: "command",
        command,
        cwd: this.#workspace,
      },
    };
  }

  async execute(): Promise<ToolOutcome> {
    this.executionCount += 1;
    return { status: "success", output: { executed: true } };
  }
}

class TuiEditApprovalProbeTool implements RuntimeTool {
  readonly definition = {
    name: "edit",
    description: "Edit approval TUI test tool.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: true,
    },
  };
  executionCount = 0;

  prepareApproval(): ToolApprovalPreparation {
    return {
      status: "approval_required",
      approval: {
        kind: "file_edit",
        path: "config.ts",
        beforeVersion: "file-version-v1:test",
        diff: [
          "--- a/config.ts",
          "+++ b/config.ts",
          "@@ line 1 @@",
          "-timeout=120",
          "+timeout=180",
        ].join("\n"),
      },
    };
  }

  async execute(): Promise<ToolOutcome> {
    this.executionCount += 1;
    return { status: "success", output: { executed: true } };
  }
}

class StreamingScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly #responses: Array<ModelResponse | ProviderError>;

  constructor(responses: readonly (ModelResponse | ProviderError)[]) {
    this.#responses = [...responses];
  }

  async complete(
    request: ModelRequest,
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("No scripted response remains");
    }
    if (response instanceof ProviderError) {
      options?.onEvent?.({
        type: "thinking_delta",
        delta: "partial reasoning from failed attempt",
      });
      await renderTurn(75);
      throw response;
    }
    for (const part of response.content) {
      options?.onEvent?.(
        part.type === "think"
          ? { type: "thinking_delta", delta: part.think }
          : { type: "text_delta", delta: part.text },
      );
      await renderTurn(75);
    }
    if (response.kind === "tool_calls") {
      const call = response.calls[0];
      if (call !== undefined) {
        const splitAt = Math.max(1, Math.floor(call.rawArguments.length / 2));
        options?.onEvent?.({
          type: "tool_call_delta",
          index: 0,
          id: call.id,
          name: call.name,
          argumentsDelta: call.rawArguments.slice(0, splitAt),
        });
        await renderTurn();
        options?.onEvent?.({
          type: "tool_call_delta",
          index: 0,
          argumentsDelta: call.rawArguments.slice(splitAt),
        });
        await renderTurn();
      }
    }
    return response;
  }
}

async function renderTurn(delayMs = 10): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function waitForFrame(
  view: ReturnType<typeof render>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (view.lastFrame()?.includes(expected) === true) {
      return;
    }
    await renderTurn();
  }
  throw new Error(
    `TUI never rendered: ${expected}\nLast frame:\n${view.lastFrame() ?? "<none>"}`,
  );
}

function approvalCommand(input: unknown): string | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string" ||
    input.command.trim().length === 0
  ) {
    return undefined;
  }
  return input.command;
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
    await renderTurn(25);
  }
  throw new Error(`Process ${pid} is still alive.`);
}
