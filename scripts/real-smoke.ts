import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCore } from "../src/core/agent-core.js";
import { loadProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const marker = "CODING_AGENT_REAL_READ_SMOKE_2026_08_30";
const workspace = await mkdtemp(join(tmpdir(), "coding-agent-real-smoke-"));
const readmeContent = [
  "# Real provider smoke\n",
  "This file proves bounded Read paging.\n",
  "The verification marker is on the next page.\n",
  `Marker: ${marker}\n`,
].join("");

try {
  await writeFile(join(workspace, "README.md"), readmeContent, "utf8");

  const provider = new OpenAICompatibleProvider(loadProviderConfig());
  const runtime = await ToolRuntime.readOnly({
    workspaceRoot: workspace,
    maxReadBytes: 96,
  });
  const core = new AgentCore(provider, runtime, { maxSteps: 4 });
  let sawToolCallDelta = false;
  let sawThinkingDelta = false;
  let sawTextDelta = false;
  let providerAttempts = 0;
  let providerRetries = 0;
  const result = await core.run(
    "Use the read tool to read all of README.md. If a page says complete=false, call read again with the same path and put the exact returned nextCursor value in the cursor argument. Continue until complete=true, then summarize the complete file and include its exact marker.",
    {
      onEvent: (event) => {
        sawToolCallDelta ||= event.type === "model_tool_call_delta";
        sawThinkingDelta ||= event.type === "model_thinking_delta";
        sawTextDelta ||= event.type === "model_text_delta";
        providerAttempts += event.type === "model_request" ? 1 : 0;
        providerRetries += event.type === "provider_retry" ? 1 : 0;
      },
    },
  );

  const readPages: Array<{
    readonly content: string;
    readonly complete: boolean;
    readonly nextCursor?: string;
  }> = [];
  for (const message of result.messages) {
    if (message.role !== "tool" || message.toolName !== "read") {
      continue;
    }
    if (message.observation.status !== "success") {
      throw new Error(
        `The real provider produced Read error ${message.observation.error.code}: ${message.observation.error.message}`,
      );
    }
    const output = message.observation.output;
    if (typeof output !== "object" || output === null) {
      throw new Error("Read did not return a structured page.");
    }
    const page = output as Record<string, unknown>;
    if (typeof page["content"] !== "string" || typeof page["complete"] !== "boolean") {
      throw new Error("Read page omitted content or completion state.");
    }
    readPages.push({
      content: page["content"],
      complete: page["complete"],
      ...(typeof page["nextCursor"] === "string"
        ? { nextCursor: page["nextCursor"] }
        : {}),
    });
  }
  const thinkingToolCall = result.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls.length > 0 &&
      message.content.some(
        (part) => part.type === "think" && part.think.length > 0,
      ),
  );

  if (result.kind !== "final_answer") {
    throw new Error(`Expected final_answer, received ${result.kind}.`);
  }
  if (readPages.length < 2) {
    throw new Error("The real provider did not continue the bounded Read.");
  }
  if (readPages[0]?.complete !== false || readPages[0]?.nextCursor === undefined) {
    throw new Error("The first Read page did not expose a continuation cursor.");
  }
  if (readPages.at(-1)?.complete !== true) {
    throw new Error("The real provider did not reach the final Read page.");
  }
  if (readPages.map((page) => page.content).join("") !== readmeContent) {
    throw new Error("The bounded Read pages did not reconstruct README.md exactly.");
  }
  if (thinkingToolCall === undefined || !sawThinkingDelta) {
    throw new Error(
      "The real provider did not stream and preserve tool-call reasoning.",
    );
  }
  if (!result.answer.includes(marker)) {
    throw new Error("The final answer did not preserve the README verification marker.");
  }
  if (!sawToolCallDelta || !sawTextDelta) {
    throw new Error(
      "The real provider did not expose both tool and text stream deltas.",
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        steps: result.steps,
        tool: "read",
        readPages: readPages.length,
        pagingVerified: true,
        markerVerified: true,
        streamingVerified: true,
        thinkingVerified: true,
        providerAttempts,
        providerRetries,
        answer: result.answer,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
