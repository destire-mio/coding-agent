import { describe, expect, it } from "vitest";

import type { ModelRequest } from "../src/core/contracts.js";
import type { ProviderConfig } from "../src/provider/config.js";
import { buildChatCompletionRequest } from "../src/provider/openai-compatible-provider.js";

describe("DeepSeek Chat Completions request", () => {
  it("disables thinking for the first tool-calling milestone", () => {
    const config: ProviderConfig = {
      apiKey: "not-sent-by-this-test",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      thinking: "disabled",
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
      tool_choice: "auto",
      stream: true,
      thinking: { type: "disabled" },
    });
    expect(body.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "read" },
    });
  });
});
