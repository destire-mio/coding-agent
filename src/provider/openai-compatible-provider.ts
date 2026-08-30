import OpenAI from "openai";

import type {
  AgentMessage,
  ModelCompletionOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
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
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
    const stream = await this.#client.chat.completions.create(
      buildChatCompletionRequest(this.#config, request),
      options.signal === undefined ? undefined : { signal: options.signal },
    );

    return consumeChatCompletionStream(stream, options.onEvent);
  }
}

interface BufferedToolCall {
  readonly index: number;
  id?: string;
  name?: string;
  rawArguments: string;
}

export async function consumeChatCompletionStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  onEvent?: (event: ModelStreamEvent) => void,
): Promise<ModelResponse> {
  let content = "";
  let finishReason: string | undefined;
  const toolCallsByIndex = new Map<number, BufferedToolCall>();

  for await (const chunk of stream) {
    for (const choice of chunk.choices) {
      if (choice.index !== 0) {
        throw new Error("The provider returned an unsupported extra choice.");
      }

      if (choice.finish_reason !== null) {
        if (
          finishReason !== undefined &&
          finishReason !== choice.finish_reason
        ) {
          throw new Error("The provider returned conflicting finish reasons.");
        }
        finishReason = choice.finish_reason;
      }

      const textDelta = choice.delta.content;
      if (textDelta !== undefined && textDelta !== null && textDelta.length > 0) {
        content += textDelta;
        emitStreamEvent(onEvent, { type: "text_delta", delta: textDelta });
      }

      for (const toolCallDelta of choice.delta.tool_calls ?? []) {
        if (
          (toolCallDelta.type !== undefined && toolCallDelta.type !== "function") ||
          toolCallDelta.custom !== undefined
        ) {
          throw new Error("The provider returned an unsupported tool call type.");
        }

        const buffer = toolCallsByIndex.get(toolCallDelta.index) ?? {
          index: toolCallDelta.index,
          rawArguments: "",
        };
        const id = toolCallDelta.id;
        const name = toolCallDelta.function?.name;
        const argumentsDelta = toolCallDelta.function?.arguments;

        if (id !== undefined) {
          if (buffer.id !== undefined && buffer.id !== id) {
            throw new Error("The provider changed a streamed tool call identity.");
          }
          buffer.id = id;
        }
        if (name !== undefined && name.length > 0) {
          if (buffer.name !== undefined && buffer.name !== name) {
            throw new Error("The provider changed a streamed tool name.");
          }
          buffer.name = name;
        }
        if (argumentsDelta !== undefined) {
          buffer.rawArguments += argumentsDelta;
        }
        toolCallsByIndex.set(toolCallDelta.index, buffer);

        emitStreamEvent(onEvent, {
          type: "tool_call_delta",
          index: toolCallDelta.index,
          ...(id === undefined ? {} : { id }),
          ...(name === undefined ? {} : { name }),
          ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
        });
      }
    }
  }

  if (finishReason === undefined) {
    throw new Error("The provider stream ended without a finish reason.");
  }

  if (finishReason === "tool_calls") {
    if (toolCallsByIndex.size === 0) {
      throw new Error("The provider finished with tool_calls but returned no calls.");
    }

    const calls: ToolCall[] = [...toolCallsByIndex.values()]
      .sort((left, right) => left.index - right.index)
      .map((call) => {
        if (
          call.id === undefined ||
          call.id.trim().length === 0 ||
          call.name === undefined ||
          call.name.trim().length === 0
        ) {
          throw new Error("The provider returned an incomplete streamed tool call.");
        }
        return {
          id: call.id,
          name: call.name,
          rawArguments: call.rawArguments,
        };
      });

    return { kind: "tool_calls", content, calls };
  }

  if (finishReason !== "stop") {
    throw new Error(`The provider stream did not complete safely: ${finishReason}.`);
  }

  if (toolCallsByIndex.size > 0) {
    throw new Error("The provider stopped normally with unfinished tool calls.");
  }

  return { kind: "final", text: content };
}

function emitStreamEvent(
  onEvent: ((event: ModelStreamEvent) => void) | undefined,
  event: ModelStreamEvent,
): void {
  if (onEvent === undefined) {
    return;
  }
  try {
    onEvent(event);
  } catch {
    // Progress observers such as the TUI cannot change provider semantics.
  }
}

type CompatibleChatCompletionRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
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
    stream: true,
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
