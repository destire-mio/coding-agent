import type {
  AgentMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  Observation,
  ProviderFailure,
  RunEvent,
  RunFailureReason,
  RunResult,
  ToolCall,
  ToolExecutor,
} from "./contracts.js";
import { assistantText } from "./contracts.js";
import {
  INITIAL_AGENT_RUN_STATE,
  isAgentRunActive,
  transitionAgentRunState,
  type AgentRunState,
  type AgentRunTransition,
} from "./agent-run-state.js";
import {
  asProviderError,
  toProviderFailure,
} from "./provider-error.js";
import {
  providerRetryDelayMs,
  resolveProviderRetryPolicy,
  waitForProviderRetry,
  type ProviderRetryOptions,
  type ProviderRetryPolicy,
} from "./provider-retry.js";

const DEFAULT_SYSTEM_PROMPT = `You are a read-only coding agent operating inside one workspace.
Use grep to locate unknown content or file locations, and read when a concrete path is known.
Never invent file contents.
Treat every tool result as an observation of reality. If a tool is denied or fails, either
retry with a valid request or clearly explain the limitation in your final answer.
When you have enough evidence, return a concise final answer without a tool call.`;

export interface AgentCoreOptions {
  readonly maxSteps?: number;
  readonly systemPrompt?: string;
  readonly providerRetry?: ProviderRetryOptions;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunEvent) => void;
}

export class AgentCore {
  readonly #provider: ModelProvider;
  readonly #runtime: ToolExecutor;
  readonly #maxSteps: number;
  readonly #systemPrompt: string;
  readonly #providerRetry: ProviderRetryPolicy;
  #runState: AgentRunState = INITIAL_AGENT_RUN_STATE;
  #activeController: AbortController | undefined;

  constructor(
    provider: ModelProvider,
    runtime: ToolExecutor,
    options: AgentCoreOptions = {},
  ) {
    const maxSteps = options.maxSteps ?? 8;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError("maxSteps must be a positive safe integer");
    }

    this.#provider = provider;
    this.#runtime = runtime;
    this.#maxSteps = maxSteps;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#providerRetry = resolveProviderRetryPolicy(options.providerRetry);
  }

  get state(): AgentRunState {
    return this.#runState;
  }

  cancel(): boolean {
    const controller = this.#activeController;
    if (controller === undefined || !isAgentRunActive(this.#runState)) {
      return false;
    }

    this.#transition({ type: "cancel" });
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("The Agent run was cancelled.", "AbortError"));
    }
    return true;
  }

  async run(userInput: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.#activeController !== undefined) {
      throw new Error("AgentCore already has an active run.");
    }

    const prompt = userInput.trim();
    const messages: AgentMessage[] = [];

    if (prompt.length === 0) {
      return this.#failed(
        0,
        messages,
        "invalid_user_input",
        "The user input must not be empty.",
        options.onEvent,
      );
    }

    const controller = new AbortController();
    this.#transition({ type: "start" });
    this.#activeController = controller;

    const onExternalAbort = () => {
      this.cancel();
    };
    if (options.signal?.aborted === true) {
      onExternalAbort();
    } else {
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const result = await this.#runLoop(prompt, {
        signal: controller.signal,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      this.#transition({ type: "settle", outcome: runOutcome(result) });
      return result;
    } catch (error) {
      if (isAgentRunActive(this.#runState)) {
        this.#transition({ type: "settle", outcome: "failed" });
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      this.#activeController = undefined;
    }
  }

  async #runLoop(prompt: string, options: RunOptions): Promise<RunResult> {
    const messages: AgentMessage[] = [];
    messages.push({ role: "user", content: prompt });
    const seenToolCallIds = new Set<string>();

    for (let step = 1; step <= this.#maxSteps; step += 1) {
      if (isSignalAborted(options.signal)) {
        return this.#stopped(step - 1, messages, "cancelled", options.onEvent);
      }
      this.#transition({ type: "request_model", step });
      const completion = await this.#completeModel(
        {
          systemPrompt: this.#systemPrompt,
          messages: [...messages],
          tools: this.#runtime.definitions(),
        },
        step,
        messages,
        options,
      );
      if (completion.kind === "terminal") {
        return completion.result;
      }
      const response = completion.response;
      if (isSignalAborted(options.signal)) {
        return this.#stopped(step, messages, "cancelled", options.onEvent);
      }

      if (response.kind === "final") {
        const answer = assistantText(response.content).trim();
        if (answer.length === 0) {
          return this.#failed(
            step,
            messages,
            "invalid_model_response",
            "The model returned neither tool calls nor a final answer.",
            options.onEvent,
          );
        }

        messages.push({
          role: "assistant",
          content: [...response.content],
          toolCalls: [],
        });
        this.#emit(options.onEvent, { type: "final_answer", step, answer });
        return { kind: "final_answer", answer, steps: step, messages: [...messages] };
      }

      if (response.calls.length === 0) {
        return this.#failed(
          step,
          messages,
          "invalid_model_response",
          "The model returned an empty tool call list.",
          options.onEvent,
        );
      }

      const invalidCall = response.calls.find(
        (call) =>
          call.id.trim().length === 0 ||
          call.name.trim().length === 0 ||
          seenToolCallIds.has(call.id),
      );
      if (invalidCall !== undefined) {
        return this.#failed(
          step,
          messages,
          "invalid_model_response",
          "The model returned a missing or duplicate tool call identity.",
          options.onEvent,
        );
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: [...response.calls],
      });

      for (const call of response.calls) {
        if (isSignalAborted(options.signal)) {
          return this.#stopped(step, messages, "cancelled", options.onEvent);
        }
        seenToolCallIds.add(call.id);
        this.#transition({
          type: "execute_tool",
          step,
          toolCallId: call.id,
          toolName: call.name,
        });
        this.#emit(options.onEvent, { type: "tool_call", step, call });
        if (isSignalAborted(options.signal)) {
          return this.#stopped(step, messages, "cancelled", options.onEvent);
        }

        let observation: Observation;
        try {
          observation = await this.#runtime.execute(call, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
        } catch {
          return this.#failed(
            step,
            messages,
            "runtime_error",
            "The tool runtime failed before it could return an observation.",
            options.onEvent,
          );
        }

        if (observation.toolCallId !== call.id) {
          return this.#failed(
            step,
            messages,
            "runtime_error",
            "The tool runtime returned an observation for the wrong tool call.",
            options.onEvent,
          );
        }

        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          observation,
        });
        this.#emit(options.onEvent, { type: "observation", step, observation });
        if (isSignalAborted(options.signal)) {
          return this.#stopped(step, messages, "cancelled", options.onEvent);
        }
      }
    }

    return this.#stopped(
      this.#maxSteps,
      messages,
      "max_steps",
      options.onEvent,
    );
  }

  async #completeModel(
    request: ModelRequest,
    step: number,
    messages: readonly AgentMessage[],
    options: RunOptions,
  ): Promise<ModelCompletionOutcome> {
    if (options.signal?.aborted === true) {
      return {
        kind: "terminal",
        result: this.#stopped(step - 1, messages, "cancelled", options.onEvent),
      };
    }

    for (
      let attempt = 1;
      attempt <= this.#providerRetry.maxAttempts;
      attempt += 1
    ) {
      this.#emit(options.onEvent, {
        type: "model_request",
        step,
        attempt,
        maxAttempts: this.#providerRetry.maxAttempts,
      });

      const onModelEvent = this.#modelEventForwarder(
        step,
        attempt,
        options.onEvent,
      );

      try {
        const response = await this.#provider.complete(request, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(onModelEvent === undefined ? {} : { onEvent: onModelEvent }),
        });
        return { kind: "response", response };
      } catch (error) {
        const providerError = asProviderError(error, options.signal);
        if (providerError.kind === "cancelled") {
          return {
            kind: "terminal",
            result: this.#stopped(step, messages, "cancelled", options.onEvent),
          };
        }

        if (
          !providerError.retryable ||
          attempt >= this.#providerRetry.maxAttempts
        ) {
          return {
            kind: "terminal",
            result: this.#failed(
              step,
              messages,
              "provider_error",
              `The model provider request failed (${providerError.kind}).`,
              options.onEvent,
              toProviderFailure(providerError, attempt),
            ),
          };
        }

        const delayMs = providerRetryDelayMs(
          providerError,
          attempt,
          this.#providerRetry,
        );
        this.#emit(options.onEvent, {
          type: "provider_retry",
          step,
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          maxAttempts: this.#providerRetry.maxAttempts,
          delayMs,
          errorKind: providerError.kind,
        });

        try {
          await waitForProviderRetry(delayMs, options.signal);
        } catch (error) {
          const waitError = asProviderError(error, options.signal);
          if (waitError.kind === "cancelled") {
            return {
              kind: "terminal",
              result: this.#stopped(step, messages, "cancelled", options.onEvent),
            };
          }
          return {
            kind: "terminal",
            result: this.#failed(
              step,
              messages,
              "provider_error",
              `The provider retry wait failed (${waitError.kind}).`,
              options.onEvent,
              toProviderFailure(waitError, attempt),
            ),
          };
        }
      }
    }

    throw new Error("Provider retry loop ended without an outcome.");
  }

  #modelEventForwarder(
    step: number,
    attempt: number,
    onEvent: RunOptions["onEvent"],
  ): ((event: ModelStreamEvent) => void) | undefined {
    if (onEvent === undefined) {
      return undefined;
    }
    return (event) => {
      if (event.type === "thinking_delta") {
        this.#emit(onEvent, {
          type: "model_thinking_delta",
          step,
          attempt,
          delta: event.delta,
        });
        return;
      }
      if (event.type === "text_delta") {
        this.#emit(onEvent, {
          type: "model_text_delta",
          step,
          attempt,
          delta: event.delta,
        });
        return;
      }
      this.#emit(onEvent, {
        type: "model_tool_call_delta",
        step,
        attempt,
        index: event.index,
        ...(event.id === undefined ? {} : { id: event.id }),
        ...(event.name === undefined ? {} : { name: event.name }),
        ...(event.argumentsDelta === undefined
          ? {}
          : { argumentsDelta: event.argumentsDelta }),
      });
    };
  }

  #stopped(
    steps: number,
    messages: readonly AgentMessage[],
    reason: "max_steps" | "cancelled",
    onEvent: RunOptions["onEvent"],
  ): RunResult {
    if (reason === "cancelled" && isAgentRunActive(this.#runState)) {
      this.#transition({ type: "cancel" });
    }
    this.#emit(onEvent, { type: "stopped", steps, reason });
    return { kind: "stopped", reason, steps, messages: [...messages] };
  }

  #failed(
    steps: number,
    messages: readonly AgentMessage[],
    reason: RunFailureReason,
    message: string,
    onEvent: RunOptions["onEvent"],
    providerFailure?: ProviderFailure,
  ): RunResult {
    this.#emit(onEvent, {
      type: "failed",
      steps,
      reason,
      message,
      ...(providerFailure === undefined ? {} : { providerFailure }),
    });
    return {
      kind: "failed",
      reason,
      message,
      steps,
      messages: [...messages],
      ...(providerFailure === undefined ? {} : { providerFailure }),
    };
  }

  #emit(onEvent: RunOptions["onEvent"], event: RunEvent): void {
    if (onEvent === undefined) {
      return;
    }

    try {
      onEvent(event);
    } catch {
      // An observer such as the TUI must never be able to break the Core loop.
    }
  }

  #transition(transition: AgentRunTransition): void {
    this.#runState = transitionAgentRunState(this.#runState, transition);
  }
}

type ModelCompletionOutcome =
  | { readonly kind: "response"; readonly response: ModelResponse }
  | { readonly kind: "terminal"; readonly result: RunResult };

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function runOutcome(result: RunResult) {
  if (result.kind === "final_answer") {
    return "completed" as const;
  }
  if (result.kind === "failed") {
    return "failed" as const;
  }
  return result.reason;
}
