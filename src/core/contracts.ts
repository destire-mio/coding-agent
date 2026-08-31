export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly rawArguments: string;
}

export type AssistantContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "think";
      readonly think: string;
      /** Provider-owned continuation state. Core preserves it; TUI never renders it. */
      readonly opaque?: string;
    };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type Observation =
  | {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "success";
      readonly output: unknown;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "error";
      readonly error: ToolError;
    };

export type AgentMessage =
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: readonly AssistantContentPart[];
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly observation: Observation;
    };

export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolDefinition[];
}

export type ModelResponse =
  | {
      readonly kind: "final";
      readonly content: readonly AssistantContentPart[];
    }
  | {
      readonly kind: "tool_calls";
      readonly content: readonly AssistantContentPart[];
      readonly calls: readonly ToolCall[];
    };

export type ModelStreamEvent =
  | {
      readonly type: "thinking_delta";
      readonly delta: string;
    }
  | {
      readonly type: "text_delta";
      readonly delta: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    };

export interface ModelCompletionOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ModelStreamEvent) => void;
}

export type ProviderErrorKind =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "quota_exhausted"
  | "timeout"
  | "connection"
  | "interrupted"
  | "unavailable"
  | "invalid_request"
  | "invalid_response"
  | "cancelled"
  | "unknown";

export interface ProviderFailure {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly statusCode?: number;
  readonly requestId?: string;
}

export interface ModelProvider {
  complete(
    request: ModelRequest,
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse>;
}

export interface ToolExecutor {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall): Promise<Observation>;
}

export type RunEvent =
  | {
      readonly type: "model_request";
      readonly step: number;
      readonly attempt: number;
      readonly maxAttempts: number;
    }
  | {
      readonly type: "model_thinking_delta";
      readonly step: number;
      readonly attempt: number;
      readonly delta: string;
    }
  | {
      readonly type: "model_text_delta";
      readonly step: number;
      readonly attempt: number;
      readonly delta: string;
    }
  | {
      readonly type: "model_tool_call_delta";
      readonly step: number;
      readonly attempt: number;
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | {
      readonly type: "provider_retry";
      readonly step: number;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorKind: ProviderErrorKind;
    }
  | { readonly type: "tool_call"; readonly step: number; readonly call: ToolCall }
  | {
      readonly type: "observation";
      readonly step: number;
      readonly observation: Observation;
    }
  | { readonly type: "final_answer"; readonly step: number; readonly answer: string }
  | { readonly type: "stopped"; readonly steps: number; readonly reason: RunStopReason }
  | {
      readonly type: "failed";
      readonly steps: number;
      readonly reason: RunFailureReason;
      readonly message: string;
      readonly providerFailure?: ProviderFailure;
    };

export type RunStopReason = "max_steps" | "cancelled";

export type RunFailureReason =
  | "invalid_user_input"
  | "provider_error"
  | "invalid_model_response"
  | "runtime_error";

interface RunEvidence {
  readonly steps: number;
  readonly messages: readonly AgentMessage[];
}

export type RunResult =
  | (RunEvidence & {
      readonly kind: "final_answer";
      readonly answer: string;
    })
  | (RunEvidence & {
      readonly kind: "stopped";
      readonly reason: RunStopReason;
    })
  | (RunEvidence & {
      readonly kind: "failed";
      readonly reason: RunFailureReason;
      readonly message: string;
      readonly providerFailure?: ProviderFailure;
    });

export function observationToModelContent(observation: Observation): string {
  return JSON.stringify(observation);
}

export function assistantText(
  content: readonly AssistantContentPart[],
): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export function assistantThinking(
  content: readonly AssistantContentPart[],
): string {
  return content
    .map((part) => (part.type === "think" ? part.think : ""))
    .join("");
}
