import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunEvent,
  ToolExecutor,
} from "../src/core/contracts.js";
import { ProviderError } from "../src/core/provider-error.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("read-only ReAct end-to-end", () => {
  it("runs user → model → Read → Observation → model → final answer", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(
      join(workspace, "README.md"),
      "# Demo\n\nThis workspace contains the E2E_MARKER.\n",
      "utf8",
    );
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        content: [
          { type: "think", think: "I need to read the real README first." },
        ],
        calls: [
          {
            id: "call-readme",
            name: "read",
            rawArguments: JSON.stringify({ path: "README.md" }),
          },
        ],
      },
      {
        kind: "final",
        content: [
          { type: "think", think: "The Observation contains the marker." },
          {
            type: "text",
            text: "The README describes a demo with E2E_MARKER.",
          },
        ],
      },
    ]);
    const core = new AgentCore(provider, runtime, { maxSteps: 4 });

    const result = await core.run("读取 workspace 中的 README.md 并总结");

    expect(result.kind).toBe("final_answer");
    expect(result.steps).toBe(2);
    expect(provider.requests).toHaveLength(2);
    const secondRequest = provider.requests[1];
    expect(secondRequest).toBeDefined();
    expect(secondRequest?.messages).toContainEqual({
      role: "assistant",
      content: [
        { type: "think", think: "I need to read the real README first." },
      ],
      toolCalls: [
        {
          id: "call-readme",
          name: "read",
          rawArguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    });
    const toolMessage = secondRequest?.messages.at(-1);
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.toolCallId).toBe("call-readme");
      expect(toolMessage.observation.status).toBe("success");
      expect(JSON.stringify(toolMessage.observation)).toContain("E2E_MARKER");
    }
  });

  it("executes multiple tool calls sequentially in model order", async () => {
    const executionOrder: string[] = [];
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async (call) => {
        executionOrder.push(`start:${call.id}`);
        await Promise.resolve();
        executionOrder.push(`finish:${call.id}`);
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "success",
          output: call.id,
        };
      },
    };
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        content: [],
        calls: [
          {
            id: "call-first",
            name: "read",
            rawArguments: JSON.stringify({ path: "README.md" }),
          },
          {
            id: "call-second",
            name: "read",
            rawArguments: JSON.stringify({ path: "package.json" }),
          },
        ],
      },
      {
        kind: "final",
        content: [{ type: "text", text: "Both reads completed." }],
      },
    ]);
    const core = new AgentCore(provider, runtime);

    const result = await core.run("Read README.md and package.json");

    expect(result.kind).toBe("final_answer");
    expect(executionOrder).toEqual([
      "start:call-first",
      "finish:call-first",
      "start:call-second",
      "finish:call-second",
    ]);
    expect(
      provider.requests[1]?.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-first", "call-second"]);
  });

  it("feeds a denied Read back to the model as an error Observation", async () => {
    const { root, workspace } = await createWorkspace();
    await writeFile(join(root, "secret.txt"), "DO_NOT_LEAK", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        content: [],
        calls: [
          {
            id: "call-denied",
            name: "read",
            rawArguments: JSON.stringify({ path: "../secret.txt" }),
          },
        ],
      },
      {
        kind: "final",
        content: [
          {
            type: "text",
            text: "I cannot read that file because it is outside the workspace.",
          },
        ],
      },
    ]);
    const core = new AgentCore(provider, runtime);

    const result = await core.run("读取 workspace 外的 secret.txt");

    expect(result.kind).toBe("final_answer");
    const secondRequest = provider.requests[1];
    const toolMessage = secondRequest?.messages.at(-1);
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.observation.status).toBe("error");
      if (toolMessage.observation.status === "error") {
        expect(toolMessage.observation.error.code).toBe("path_outside_workspace");
      }
    }
    expect(JSON.stringify(secondRequest)).not.toContain("DO_NOT_LEAK");
  });

  it("fails the run when Runtime throws before returning an Observation", async () => {
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        content: [],
        calls: [
          {
            id: "call-runtime-crash",
            name: "read",
            rawArguments: JSON.stringify({ path: "README.md" }),
          },
        ],
      },
    ]);
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => {
        throw new Error("runtime crashed");
      },
    };
    const events: RunEvent[] = [];
    const core = new AgentCore(provider, runtime);

    const result = await core.run("读取 README.md", {
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      kind: "failed",
      reason: "runtime_error",
      steps: 1,
    });
    expect(provider.requests).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_call", step: 1 }),
    );
    expect(events.some((event) => event.type === "observation")).toBe(false);
  });

  it("fails the run when Runtime returns an Observation for another call", async () => {
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        content: [],
        calls: [
          {
            id: "call-expected",
            name: "read",
            rawArguments: JSON.stringify({ path: "README.md" }),
          },
        ],
      },
    ]);
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => ({
        toolCallId: "call-wrong",
        toolName: "read",
        status: "success",
        output: "untrusted result",
      }),
    };
    const core = new AgentCore(provider, runtime);

    const result = await core.run("读取 README.md");

    expect(result).toMatchObject({
      kind: "failed",
      reason: "runtime_error",
      steps: 1,
    });
    expect(provider.requests).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "tool")).toBe(
      false,
    );
  });

  it("stops at maxSteps without claiming success", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "README.md"), "loop\n", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
    const provider = new RepeatingReadProvider();
    const core = new AgentCore(provider, runtime, { maxSteps: 2 });

    const result = await core.run("keep reading");

    expect(result).toMatchObject({ kind: "stopped", reason: "max_steps", steps: 2 });
    expect(provider.requests).toHaveLength(2);
  });

  it("reports a provider failure as a RunResult instead of an Observation", async () => {
    const { workspace } = await createWorkspace();
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
    const provider: ModelProvider = {
      complete: async () => {
        throw new Error("transport failed");
      },
    };
    const core = new AgentCore(provider, runtime);

    const result = await core.run("读取 README.md");

    expect(result).toMatchObject({
      kind: "failed",
      reason: "provider_error",
      steps: 1,
      providerFailure: {
        kind: "unknown",
        retryable: false,
        attempts: 1,
      },
    });
  });

  it("retries a transient provider failure inside the same ReAct step", async () => {
    let providerAttempts = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerAttempts += 1;
        if (providerAttempts === 1) {
          throw new ProviderError("rate_limit", "slow down", {
            retryable: true,
          });
        }
        return {
          kind: "final",
          content: [{ type: "text", text: "recovered" }],
        };
      },
    };
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => {
        throw new Error("must not execute");
      },
    };
    const core = new AgentCore(provider, runtime, {
      providerRetry: zeroDelayRetryPolicy(),
    });
    const events: RunEvent[] = [];

    const result = await core.run("answer", {
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ kind: "final_answer", steps: 1 });
    expect(providerAttempts).toBe(2);
    expect(
      events.filter((event) => event.type === "model_request"),
    ).toMatchObject([
      { step: 1, attempt: 1, maxAttempts: 3 },
      { step: 1, attempt: 2, maxAttempts: 3 },
    ]);
    expect(events).toContainEqual({
      type: "provider_retry",
      step: 1,
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 0,
      errorKind: "rate_limit",
    });
  });

  it("does not retry authentication or user cancellation", async () => {
    for (const scenario of [
      {
        error: new ProviderError("authentication", "bad key", {
          retryable: false,
        }),
        expected: { kind: "failed", reason: "provider_error" },
      },
      {
        error: new ProviderError("cancelled", "user cancelled", {
          retryable: false,
        }),
        expected: { kind: "stopped", reason: "cancelled" },
      },
    ] as const) {
      let providerAttempts = 0;
      const provider: ModelProvider = {
        complete: async () => {
          providerAttempts += 1;
          throw scenario.error;
        },
      };
      const runtime: ToolExecutor = {
        definitions: () => [],
        execute: async () => {
          throw new Error("must not execute");
        },
      };
      const core = new AgentCore(provider, runtime, {
        providerRetry: zeroDelayRetryPolicy(),
      });

      const result = await core.run("answer");

      expect(result).toMatchObject(scenario.expected);
      expect(providerAttempts).toBe(1);
    }
  });

  it("does not execute a completed ToolCall when cancellation wins the boundary", async () => {
    const controller = new AbortController();
    let executions = 0;
    const provider: ModelProvider = {
      complete: async () => {
        controller.abort();
        return {
          kind: "tool_calls",
          content: [],
          calls: [
            {
              id: "call-after-cancel",
              name: "read",
              rawArguments: JSON.stringify({ path: "README.md" }),
            },
          ],
        };
      },
    };
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async (call) => {
        executions += 1;
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "success",
          output: "must not run",
        };
      },
    };
    const core = new AgentCore(provider, runtime);

    const result = await core.run("读取 README.md", {
      signal: controller.signal,
    });

    expect(result).toMatchObject({ kind: "stopped", reason: "cancelled" });
    expect(executions).toBe(0);
  });

  it("owns provider cancellation and exposes the run lifecycle", async () => {
    let markProviderStarted: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    const provider: ModelProvider = {
      complete: async (_request, options) => {
        providerSignal = options?.signal;
        markProviderStarted();
        return new Promise<ModelResponse>((_resolve, reject) => {
          const rejectCancelled = () => {
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
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => {
        throw new Error("must not execute");
      },
    };
    const core = new AgentCore(provider, runtime);

    expect(core.state).toEqual({ phase: "idle" });
    const running = core.run("读取 README.md");
    await providerStarted;

    expect(core.state).toEqual({ phase: "requesting_model", step: 1 });
    expect(core.cancel()).toBe(true);
    expect(core.state).toEqual({ phase: "cancelling", step: 1 });
    expect(providerSignal?.aborted).toBe(true);

    await expect(running).resolves.toMatchObject({
      kind: "stopped",
      reason: "cancelled",
      steps: 1,
    });
    expect(core.state).toEqual({ phase: "settled", outcome: "cancelled" });
    expect(core.cancel()).toBe(false);
  });

  it("records an in-flight Read result, then stops before another model request", async () => {
    let markToolStarted: () => void = () => undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let releaseTool: () => void = () => undefined;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let providerRequests = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerRequests += 1;
        if (providerRequests > 1) {
          throw new Error("must stop before another model request");
        }
        return {
          kind: "tool_calls",
          content: [],
          calls: [
            {
              id: "call-in-flight",
              name: "read",
              rawArguments: JSON.stringify({ path: "README.md" }),
            },
          ],
        };
      },
    };
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async (call) => {
        markToolStarted();
        await toolReleased;
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "success",
          output: "READ_FINISHED_AFTER_CANCEL",
        };
      },
    };
    const core = new AgentCore(provider, runtime);

    const running = core.run("读取 README.md");
    await toolStarted;

    expect(core.state).toEqual({
      phase: "executing_tool",
      step: 1,
      toolCallId: "call-in-flight",
      toolName: "read",
    });
    expect(core.cancel()).toBe(true);
    expect(core.state).toEqual({ phase: "cancelling", step: 1 });
    releaseTool();

    const result = await running;
    expect(result).toMatchObject({
      kind: "stopped",
      reason: "cancelled",
      steps: 1,
    });
    expect(providerRequests).toBe(1);
    expect(result.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-in-flight",
      observation: {
        status: "success",
        output: "READ_FINISHED_AFTER_CANCEL",
      },
    });
    expect(core.state).toEqual({ phase: "settled", outcome: "cancelled" });
  });

  it("retries only the second model request and preserves the Read Observation", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "README.md"), "PRESERVED_OBSERVATION\n", "utf8");
    const delegate = await ToolRuntime.readOnly({ workspaceRoot: workspace });
    let executions = 0;
    const runtime: ToolExecutor = {
      definitions: () => delegate.definitions(),
      execute: async (call) => {
        executions += 1;
        return delegate.execute(call);
      },
    };
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            kind: "tool_calls",
            content: [
              { type: "think", think: "Read the file once, then wait." },
            ],
            calls: [
              {
                id: "call-preserved-read",
                name: "read",
                rawArguments: JSON.stringify({ path: "README.md" }),
              },
            ],
          };
        }
        if (requests.length === 2) {
          throw new ProviderError("rate_limit", "slow down", {
            retryable: true,
          });
        }
        return {
          kind: "final",
          content: [{ type: "text", text: "PRESERVED_OBSERVATION" }],
        };
      },
    };
    const core = new AgentCore(provider, runtime, {
      providerRetry: zeroDelayRetryPolicy(),
    });

    const result = await core.run("读取 README.md");

    expect(result).toMatchObject({ kind: "final_answer", steps: 2 });
    expect(requests).toHaveLength(3);
    expect(executions).toBe(1);
    expect(requests[1]?.messages.at(-1)).toEqual(
      requests[2]?.messages.at(-1),
    );
    expect(JSON.stringify(requests[2])).toContain("PRESERVED_OBSERVATION");
    expect(JSON.stringify(requests[2])).toContain(
      "Read the file once, then wait.",
    );
  });

  it("never executes a partial streamed ToolCall after provider failure", async () => {
    let executions = 0;
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async (call) => {
        executions += 1;
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "success",
          output: "must not run",
        };
      },
    };
    const provider: ModelProvider = {
      complete: async (
        _request: ModelRequest,
        options?: ModelCompletionOptions,
      ) => {
        options?.onEvent?.({
          type: "tool_call_delta",
          index: 0,
          id: "call-partial",
          name: "read",
          argumentsDelta: '{"path":"READ',
        });
        throw new ProviderError("interrupted", "provider stream disconnected", {
          retryable: true,
        });
      },
    };
    const core = new AgentCore(provider, runtime, {
      providerRetry: { maxAttempts: 1 },
    });
    const eventTypes: string[] = [];

    const result = await core.run("读取 README.md", {
      onEvent: (event) => eventTypes.push(event.type),
    });

    expect(result).toMatchObject({ kind: "failed", reason: "provider_error", steps: 1 });
    expect(executions).toBe(0);
    expect(eventTypes).toContain("model_tool_call_delta");
    expect(eventTypes).not.toContain("tool_call");
    expect(eventTypes).not.toContain("observation");
  });
});

function zeroDelayRetryPolicy() {
  return {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
  } as const;
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly #responses: ModelResponse[];

  constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("No scripted response remains");
    }
    return response;
  }
}

class RepeatingReadProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: `call-${this.requests.length}`,
          name: "read",
          rawArguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    };
  }
}

async function createWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-e2e-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}
