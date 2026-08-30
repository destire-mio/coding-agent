import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCore } from "../src/core/agent-core.js";
import { loadProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const marker = "CODING_AGENT_REAL_READ_SMOKE_2026_08_30";
const workspace = await mkdtemp(join(tmpdir(), "coding-agent-real-smoke-"));

try {
  await writeFile(
    join(workspace, "README.md"),
    `# Real provider smoke\n\nThis file proves the Read loop. Marker: ${marker}\n`,
    "utf8",
  );

  const provider = new OpenAICompatibleProvider(loadProviderConfig());
  const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
  const core = new AgentCore(provider, runtime, { maxSteps: 4 });
  let sawToolCallDelta = false;
  let sawTextDelta = false;
  const result = await core.run(
    "Use the read tool to read README.md, summarize it, and include its exact marker.",
    {
      onEvent: (event) => {
        sawToolCallDelta ||= event.type === "model_tool_call_delta";
        sawTextDelta ||= event.type === "model_text_delta";
      },
    },
  );

  const readObservation = result.messages.find(
    (message) =>
      message.role === "tool" &&
      message.toolName === "read" &&
      message.observation.status === "success",
  );

  if (result.kind !== "final_answer") {
    throw new Error(`Expected final_answer, received ${result.kind}.`);
  }
  if (readObservation === undefined) {
    throw new Error("The real provider did not complete a successful Read call.");
  }
  if (!result.answer.includes(marker)) {
    throw new Error("The final answer did not preserve the README verification marker.");
  }
  if (!sawToolCallDelta || !sawTextDelta) {
    throw new Error("The real provider did not expose both tool and text stream deltas.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        steps: result.steps,
        tool: "read",
        markerVerified: true,
        streamingVerified: true,
        answer: result.answer,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
