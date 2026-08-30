import type {
  AgentMessage,
  ModelStreamEvent,
  ModelProvider,
  Observation,
  RunEvent,
  RunFailureReason,
  RunResult,
  ToolCall,
  ToolExecutor,
} from "./contracts.js";

const DEFAULT_SYSTEM_PROMPT = `You are a read-only coding agent operating inside one workspace.
Use the read tool whenever the user asks about file contents. Never invent file contents.
Treat every tool result as an observation of reality. If a tool is denied or fails, either
retry with a valid request or clearly explain the limitation in your final answer.
When you have enough evidence, return a concise final answer without a tool call.`;

export interface AgentCoreOptions {
  readonly maxSteps?: number;
  readonly systemPrompt?: string;
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
  }

  async run(userInput: string, options: RunOptions = {}): Promise<RunResult> {
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

    messages.push({ role: "user", content: prompt });
    const seenToolCallIds = new Set<string>();

    for (let step = 1; step <= this.#maxSteps; step += 1) {
      this.#emit(options.onEvent, { type: "model_request", step });

      let response;
      try {
        const onModelEvent =
          options.onEvent === undefined
            ? undefined
            : (event: ModelStreamEvent) => {
                if (event.type === "text_delta") {
                  this.#emit(options.onEvent, {
                    type: "model_text_delta",
                    step,
                    delta: event.delta,
                  });
                  return;
                }
                this.#emit(options.onEvent, {
                  type: "model_tool_call_delta",
                  step,
                  index: event.index,
                  ...(event.id === undefined ? {} : { id: event.id }),
                  ...(event.name === undefined ? {} : { name: event.name }),
                  ...(event.argumentsDelta === undefined
                    ? {}
                    : { argumentsDelta: event.argumentsDelta }),
                });
              };
        response = await this.#provider.complete(
          {
            systemPrompt: this.#systemPrompt,
            messages: [...messages],
            tools: this.#runtime.definitions(),
          },
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(onModelEvent === undefined ? {} : { onEvent: onModelEvent }),
          },
        );
      } catch {
        return this.#failed(
          step,
          messages,
          "provider_error",
          "The model provider request failed.",
          options.onEvent,
        );
      }

      if (response.kind === "final") {
        const answer = response.text.trim();
        if (answer.length === 0) {
          return this.#failed(
            step,
            messages,
            "invalid_model_response",
            "The model returned neither tool calls nor a final answer.",
            options.onEvent,
          );
        }

        messages.push({ role: "assistant", content: answer, toolCalls: [] });
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
        seenToolCallIds.add(call.id);
        this.#emit(options.onEvent, { type: "tool_call", step, call });

        let observation: Observation;
        try {
          observation = await this.#runtime.execute(call);
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
      }
    }

    this.#emit(options.onEvent, {
      type: "stopped",
      steps: this.#maxSteps,
      reason: "max_steps",
    });
    return {
      kind: "stopped",
      reason: "max_steps",
      steps: this.#maxSteps,
      messages: [...messages],
    };
  }

  #failed(
    steps: number,
    messages: readonly AgentMessage[],
    reason: RunFailureReason,
    message: string,
    onEvent: RunOptions["onEvent"],
  ): RunResult {
    this.#emit(onEvent, { type: "failed", steps, reason, message });
    return { kind: "failed", reason, message, steps, messages: [...messages] };
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
}
