import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCore } from "../src/core/agent-core.js";
import { loadProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";
import { GrepTool } from "../src/runtime/grep-tool.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const marker = "CODING_AGENT_REAL_GREP_SMOKE_2026_08_31";
const secretMarker = "GREP_MUST_NOT_EXPOSE_ENV_SECRET";
const workspace = await mkdtemp(join(tmpdir(), "coding-agent-real-grep-"));

try {
  await writeFile(
    join(workspace, "app.log"),
    [
      "INFO service ready",
      "ERROR unrelated failure",
      `ERROR marker ${marker}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, ".env"),
    `ERROR secret ${secretMarker}\n`,
    "utf8",
  );

  const provider = new OpenAICompatibleProvider(loadProviderConfig());
  const runtime = new ToolRuntime([
    await GrepTool.create({ workspaceRoot: workspace, maxMatches: 1 }),
  ]);
  const core = new AgentCore(provider, runtime, { maxSteps: 4 });
  let sawToolCallDelta = false;
  let sawThinkingDelta = false;
  let sawTextDelta = false;
  let providerAttempts = 0;
  let providerRetries = 0;
  const result = await core.run(
    "Use grep with the regular expression ^ERROR to search the whole workspace. If complete=false, call grep again with the same pattern, omit path again, and pass the exact nextCursor. Continue until complete=true. Then report the exact CODING_AGENT marker from all safe matches. Never guess it.",
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

  const pages: Array<{
    readonly texts: readonly string[];
    readonly complete: boolean;
    readonly nextCursor?: string;
  }> = [];
  for (const message of result.messages) {
    if (message.role !== "tool" || message.toolName !== "grep") {
      continue;
    }
    if (message.observation.status !== "success") {
      throw new Error(
        `The real provider produced Grep error ${message.observation.error.code}: ${message.observation.error.message}`,
      );
    }
    const output = message.observation.output;
    if (typeof output !== "object" || output === null) {
      throw new Error("Grep did not return a structured page.");
    }
    const page = output as Record<string, unknown>;
    if (!Array.isArray(page["matches"]) || typeof page["complete"] !== "boolean") {
      throw new Error("Grep page omitted matches or completion state.");
    }
    const texts = page["matches"].map((match) => {
      if (
        typeof match !== "object" ||
        match === null ||
        typeof (match as Record<string, unknown>)["text"] !== "string"
      ) {
        throw new Error("Grep returned an invalid match record.");
      }
      return (match as Record<string, unknown>)["text"] as string;
    });
    pages.push({
      texts,
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
  if (pages.length < 2) {
    throw new Error("The real provider did not continue the bounded Grep.");
  }
  if (pages[0]?.complete !== false || pages[0]?.nextCursor === undefined) {
    throw new Error("The first Grep page did not expose a continuation cursor.");
  }
  if (pages.at(-1)?.complete !== true) {
    throw new Error("The real provider did not reach the final Grep page.");
  }
  const observationText = JSON.stringify(pages);
  if (!observationText.includes(marker)) {
    throw new Error("The Grep pages did not contain the safe marker.");
  }
  if (observationText.includes(secretMarker) || result.answer.includes(secretMarker)) {
    throw new Error("Grep exposed a sensitive .env match.");
  }
  if (thinkingToolCall === undefined || !sawThinkingDelta) {
    throw new Error(
      "The real provider did not stream and preserve tool-call reasoning.",
    );
  }
  if (!result.answer.includes(marker)) {
    throw new Error("The final answer omitted the Grep verification marker.");
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
        tool: "grep",
        grepPages: pages.length,
        pagingVerified: true,
        sensitiveFilteringVerified: true,
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
