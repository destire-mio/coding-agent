import OpenAI from "openai";

import type {
  AgentMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../core/contracts.js";
import { observationToModelContent } from "../core/contracts.js";
import type { ProviderConfig } from "./config.js";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.#client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.#config = config;
  }

  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.#client.chat.completions.create(
      buildChatCompletionRequest(this.#config, request),
      signal === undefined ? undefined : { signal },
    );

    const message = response.choices[0]?.message;
    if (message === undefined) {
      throw new Error("The provider returned no response choice.");
    }

    const toolCalls = (message.tool_calls ?? []).map((call) => {
      if (call.type !== "function") {
        throw new Error("The provider returned an unsupported tool call type.");
      }
      return {
        id: call.id,
        name: call.function.name,
        rawArguments: call.function.arguments,
      };
    });

    if (toolCalls.length > 0) {
      return {
        kind: "tool_calls",
        content: message.content ?? "",
        calls: toolCalls,
      };
    }

    return { kind: "final", text: message.content ?? "" };
  }
}

type CompatibleChatCompletionRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    readonly thinking: { readonly type: "disabled" };
  };

export function buildChatCompletionRequest(
  config: ProviderConfig,
  request: ModelRequest,
): CompatibleChatCompletionRequest {
  return {
    model: config.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      ...request.messages.map(toOpenAIMessage),
    ],
    tools: request.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    tool_choice: "auto",
    thinking: { type: config.thinking },
  };
}

function toOpenAIMessage(
  message: AgentMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.rawArguments },
              })),
            }),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: observationToModelContent(message.observation),
      };
  }
}
