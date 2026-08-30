import OpenAI, { type APIError } from "openai";

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
import {
  ProviderError,
  asProviderError,
  isAbortError,
  type ProviderErrorOptions,
} from "../core/provider-error.js";
import type { ProviderConfig } from "./config.js";

const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

interface CompatibleClientOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly maxRetries: 0;
  readonly timeout: number;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.#client = new OpenAI(buildOpenAIClientOptions(config));
    this.#config = config;
  }

  async complete(
    request: ModelRequest,
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
    try {
      const stream = await this.#client.chat.completions.create(
        buildChatCompletionRequest(this.#config, request),
        options.signal === undefined ? undefined : { signal: options.signal },
      );

      return await consumeChatCompletionStream(stream, options.onEvent);
    } catch (error) {
      throw normalizeOpenAICompatibleError(error, options.signal);
    }
  }
}

export function buildOpenAIClientOptions(
  config: ProviderConfig,
): CompatibleClientOptions {
  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: DEFAULT_PROVIDER_TIMEOUT_MS,
  };
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

  try {
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        if (choice.index !== 0) {
          throw invalidProviderResponse(
            "The provider returned an unsupported extra choice.",
          );
        }

        if (choice.finish_reason !== null) {
          if (
            finishReason !== undefined &&
            finishReason !== choice.finish_reason
          ) {
            throw invalidProviderResponse(
              "The provider returned conflicting finish reasons.",
            );
          }
          finishReason = choice.finish_reason;
        }

        const textDelta = choice.delta.content;
        if (
          textDelta !== undefined &&
          textDelta !== null &&
          textDelta.length > 0
        ) {
          content += textDelta;
          emitStreamEvent(onEvent, { type: "text_delta", delta: textDelta });
        }

        for (const toolCallDelta of choice.delta.tool_calls ?? []) {
          if (
            (toolCallDelta.type !== undefined &&
              toolCallDelta.type !== "function") ||
            toolCallDelta.custom !== undefined
          ) {
            throw invalidProviderResponse(
              "The provider returned an unsupported tool call type.",
            );
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
              throw invalidProviderResponse(
                "The provider changed a streamed tool call identity.",
              );
            }
            buffer.id = id;
          }
          if (name !== undefined && name.length > 0) {
            if (buffer.name !== undefined && buffer.name !== name) {
              throw invalidProviderResponse(
                "The provider changed a streamed tool name.",
              );
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
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    throw new ProviderError(
      "interrupted",
      "The provider stream was interrupted before completion.",
      { retryable: true, cause: error },
    );
  }

  if (finishReason === undefined) {
    throw new ProviderError(
      "interrupted",
      "The provider stream ended without a finish reason.",
      { retryable: true },
    );
  }

  if (finishReason === "tool_calls") {
    if (toolCallsByIndex.size === 0) {
      throw invalidProviderResponse(
        "The provider finished with tool_calls but returned no calls.",
      );
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
          throw invalidProviderResponse(
            "The provider returned an incomplete streamed tool call.",
          );
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
    throw invalidProviderResponse(
      `The provider stream did not complete safely: ${finishReason}.`,
    );
  }

  if (toolCallsByIndex.size > 0) {
    throw invalidProviderResponse(
      "The provider stopped normally with unfinished tool calls.",
    );
  }

  return { kind: "final", text: content };
}

export function normalizeOpenAICompatibleError(
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  if (signal?.aborted === true || isAbortError(error)) {
    return asProviderError(error, signal);
  }
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError("timeout", error.message, {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError("connection", error.message, {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError) {
    return normalizeStatusError(error);
  }
  return asProviderError(error, signal);
}

function normalizeStatusError(error: APIError): ProviderError {
  const statusCode = error.status;
  const retryAfterMs = readRetryAfterMs(error.headers);
  const common = {
    cause: error,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(error.requestID === undefined || error.requestID === null
      ? {}
      : { requestId: error.requestID }),
    ...(statusCode === undefined ? {} : { statusCode }),
  } satisfies Omit<ProviderErrorOptions, "retryable">;

  if (statusCode === 401) {
    return new ProviderError("authentication", error.message, {
      ...common,
      retryable: false,
    });
  }
  if (statusCode === 403) {
    return new ProviderError("permission", error.message, {
      ...common,
      retryable: false,
    });
  }
  if (statusCode === 429 && isQuotaExhausted(error)) {
    return new ProviderError("quota_exhausted", error.message, {
      ...common,
      retryable: false,
    });
  }
  if (statusCode === 429) {
    return new ProviderError("rate_limit", error.message, {
      ...common,
      retryable: true,
    });
  }
  if (statusCode === 408) {
    return new ProviderError("timeout", error.message, {
      ...common,
      retryable: true,
    });
  }
  if (statusCode === 409 || statusCode === 529 || (statusCode ?? 0) >= 500) {
    return new ProviderError("unavailable", error.message, {
      ...common,
      retryable: true,
    });
  }
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return new ProviderError("invalid_request", error.message, {
      ...common,
      retryable: false,
    });
  }
  return new ProviderError("unknown", error.message, {
    ...common,
    retryable: false,
  });
}

function readRetryAfterMs(headers: Headers | undefined): number | undefined {
  const milliseconds = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds;
  }

  const raw = headers?.get("retry-after");
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  const parsed = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - Date.now();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isQuotaExhausted(error: APIError): boolean {
  const providerCode = `${error.code ?? ""} ${error.type ?? ""} ${error.message}`;
  return /insufficient[_ ]quota|exceeded[_ ]current[_ ]quota|insufficient balance|recharge/i.test(
    providerCode,
  );
}

function invalidProviderResponse(message: string): ProviderError {
  return new ProviderError("invalid_response", message, { retryable: false });
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
