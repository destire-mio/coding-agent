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
  ToolExecutor,
} from "../src/core/contracts.js";
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
        content: "",
        calls: [
          {
            id: "call-readme",
            name: "read",
            rawArguments: JSON.stringify({ path: "README.md" }),
          },
        ],
      },
      { kind: "final", text: "The README describes a demo with E2E_MARKER." },
    ]);
    const core = new AgentCore(provider, runtime, { maxSteps: 4 });

    const result = await core.run("读取 workspace 中的 README.md 并总结");

    expect(result.kind).toBe("final_answer");
    expect(result.steps).toBe(2);
    expect(provider.requests).toHaveLength(2);
    const secondRequest = provider.requests[1];
    expect(secondRequest).toBeDefined();
    const toolMessage = secondRequest?.messages.at(-1);
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.toolCallId).toBe("call-readme");
      expect(toolMessage.observation.status).toBe("success");
      expect(JSON.stringify(toolMessage.observation)).toContain("E2E_MARKER");
    }
  });

  it("feeds a denied Read back to the model as an error Observation", async () => {
    const { root, workspace } = await createWorkspace();
    await writeFile(join(root, "secret.txt"), "DO_NOT_LEAK", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        content: "",
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
        text: "I cannot read that file because it is outside the workspace.",
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

    expect(result).toMatchObject({ kind: "failed", reason: "provider_error", steps: 1 });
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
        throw new Error("provider stream disconnected");
      },
    };
    const core = new AgentCore(provider, runtime);
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
      content: "",
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
