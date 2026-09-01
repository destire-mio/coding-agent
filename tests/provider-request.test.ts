import { describe, expect, it } from "vitest";

import type { ModelRequest } from "../src/core/contracts.js";
import type { ProviderConfig } from "../src/provider/config.js";
import { buildChatCompletionRequest } from "../src/provider/openai-compatible-provider.js";

describe("DeepSeek Chat Completions request", () => {
  it("enables thinking and omits unsupported tool_choice", () => {
    const config: ProviderConfig = {
      apiKey: "not-sent-by-this-test",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      thinking: "enabled",
    };
    const request: ModelRequest = {
      systemPrompt: "Use Read.",
      messages: [{ role: "user", content: "Read README.md" }],
      tools: [
        {
          name: "read",
          description: "Read one file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };

    const body = buildChatCompletionRequest(config, request);

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      thinking: { type: "enabled" },
    });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "read" },
    });
  });

  it("round-trips thinking on the assistant tool-call message", () => {
    const config: ProviderConfig = {
      apiKey: "not-sent-by-this-test",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      thinking: "enabled",
    };
    const request: ModelRequest = {
      systemPrompt: "Use Read.",
      messages: [
        { role: "user", content: "Read README.md" },
        {
          role: "assistant",
          content: [
            { type: "think", think: "I need the real file contents." },
            { type: "text", text: "I will read it." },
          ],
          toolCalls: [
            {
              id: "call-readme",
              name: "read",
              rawArguments: '{"path":"README.md"}',
            },
          ],
        },
        {
          role: "tool",
          operationId: "operation-readme",
          toolCallId: "call-readme",
          toolName: "read",
          observation: {
            toolCallId: "call-readme",
            toolName: "read",
            status: "success",
            output: { content: "README contents" },
          },
        },
      ],
      tools: [],
    };

    const body = buildChatCompletionRequest(config, request);
    const assistantMessage = body.messages.find(
      (message) => message.role === "assistant",
    );

    expect(assistantMessage).toMatchObject({
      role: "assistant",
      content: "I will read it.",
      reasoning_content: "I need the real file contents.",
      tool_calls: [
        {
          id: "call-readme",
          type: "function",
          function: { name: "read", arguments: '{"path":"README.md"}' },
        },
      ],
    });
  });
});
