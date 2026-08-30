import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunResult,
} from "../src/core/contracts.js";
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

  const provider = new ScriptedProvider([
    {
      kind: "tool_calls",
      content: "",
      calls: [
        {
          id: "call-tui-read",
          name: "read",
          rawArguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    },
    { kind: "final", text: "The README contains TUI_E2E_MARKER." },
  ]);
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
      initialPrompt="读取 README.md 并总结"
      onComplete={finish}
    />,
  );

  const result = await completion;
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(result.kind).toBe("final_answer");
  expect(provider.requests).toHaveLength(2);
  expect(view.lastFrame()).toContain("tool call read (call-tui-read)");
  expect(view.lastFrame()).toContain("observation success (call-tui-read)");
  expect(view.lastFrame()).toContain("The README contains TUI_E2E_MARKER.");
  view.unmount();
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
