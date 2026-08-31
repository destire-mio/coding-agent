import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunResult,
} from "../src/core/contracts.js";
import { ProviderError } from "../src/core/provider-error.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
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
