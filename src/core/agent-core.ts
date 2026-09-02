import { randomUUID } from "node:crypto";

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
  ToolApprovalHandler,
  ToolCall,
  ToolExecutor,
} from "./contracts.js";
import { assistantText, projectCompletedContext } from "./contracts.js";
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
import type {
  SessionEventInput,
  SessionEventWriter,
} from "../session/session-transcript-store.js";
import type {
  ResumableSessionState,
} from "../session/session-transcript-fold.js";

const DEFAULT_SYSTEM_PROMPT = `You are a coding agent operating inside one workspace.
Use grep to locate unknown content or file locations, and read when a concrete path is known.
Use bash only when Read and Grep cannot complete the task. Bash requires explicit user approval,
may have side effects, and must never be automatically retried after timeout or cancellation.
If Bash output is truncated, use Read with its stdoutRef or stderrRef to inspect the saved output;
never rerun a side-effecting command merely to recover omitted output.
Use edit only after Read returns the current workspace file content and version. Pass that exact
version as expected_version, use an exact old_string that matches once, and review the Runtime-generated
diff. Edit requires fresh user approval and must never be automatically retried after a verification failure.
Never invent file contents.
Treat every tool result as an observation of reality. If a tool is denied or fails, either
retry with a valid request or clearly explain the limitation in your final answer.
Call at most one tool in each model response. Use the next model response for another tool.
When you have enough evidence, return a concise final answer without a tool call.`;

const RECOVERABLE_TOOL_NAMES = new Set(["read", "grep", "edit"]);

export interface AgentCoreOptions {
  readonly maxSteps?: number;
  readonly systemPrompt?: string;
  readonly providerRetry?: ProviderRetryOptions;
  readonly session?: SessionEventWriter;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunEvent) => void;
  readonly requestApproval?: ToolApprovalHandler;
}

export class AgentCore {
  readonly #provider: ModelProvider;
  readonly #runtime: ToolExecutor;
  readonly #maxSteps: number;
  readonly #systemPrompt: string;
  readonly #providerRetry: ProviderRetryPolicy;
  readonly #session: SessionEventWriter | undefined;
  #runState: AgentRunState = INITIAL_AGENT_RUN_STATE;
  #activeController: AbortController | undefined;
  #contextMessages: AgentMessage[] = [];

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
    this.#session = options.session;
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
    this.#requireNoActiveRun();

    const prompt = userInput.trim();
    const messages = [...this.#contextMessages];

    if (prompt.length === 0) {
      const result = this.#failed(
        0,
        messages,
        "invalid_user_input",
        "The user input must not be empty.",
      );
      this.#emitTerminal(options.onEvent, result);
      return result;
    }

    const turnId = randomUUID();
    return this.#executeTurn(turnId, options, (activeOptions) =>
      this.#runLoop(messages, prompt, turnId, activeOptions),
    );
  }

  async resume(
    state: ResumableSessionState,
    options: RunOptions = {},
  ): Promise<RunResult> {
    this.#requireNoActiveRun();
    if (
      this.#session === undefined ||
      this.#session.sessionId !== state.sessionId
    ) {
      throw new Error(
        "AgentCore resume requires the matching Session event writer.",
      );
    }

    const messages = [...state.messages];
    if (state.kind === "recovering_tool") {
      return this.#executeTurn(state.turnId, options, async (activeOptions) => {
        const toolStep = await this.#completeToolStep(
          messages,
          state.turnId,
          state.step,
          state.intent.operationId,
          state.intent.call,
          activeOptions,
          "recovery",
        );
        if (toolStep.kind === "terminal") {
          return toolStep.result;
        }
        return this.#continueLoop(
          messages,
          state.turnId,
          state.step + 1,
          collectToolCallIds(messages),
          activeOptions,
        );
      });
    }
    return this.#executeTurn(state.turnId, options, (activeOptions) =>
      this.#continueLoop(
        messages,
        state.turnId,
        state.nextStep,
        collectToolCallIds(messages),
        activeOptions,
      ),
    );
  }

  async #executeTurn(
    turnId: string,
    options: RunOptions,
    execute: (options: RunOptions) => Promise<RunResult>,
  ): Promise<RunResult> {
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
      let result = await execute({
        signal: controller.signal,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        ...(options.requestApproval === undefined
          ? {}
          : { requestApproval: options.requestApproval }),
      });
      result = await this.#persistTurnOutcome(turnId, result);
      if (result.kind === "final_answer") {
        this.#contextMessages = projectCompletedContext(result.messages);
      }
      this.#emitTerminal(options.onEvent, result);
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

  async #runLoop(
    messages: AgentMessage[],
    prompt: string,
    turnId: string,
    options: RunOptions,
  ): Promise<RunResult> {
    messages.push({ role: "user", content: prompt });
    if (
      !(await this.#persistSessionEvent({
        type: "turn_started",
        turnId,
        userInput: prompt,
      }))
    ) {
      return this.#sessionFailure(0, messages);
    }
    return this.#continueLoop(
      messages,
      turnId,
      1,
      collectToolCallIds(messages),
      options,
    );
  }

  async #continueLoop(
    messages: AgentMessage[],
    turnId: string,
    startStep: number,
    seenToolCallIds: Set<string>,
    options: RunOptions,
  ): Promise<RunResult> {
    for (let step = startStep; step <= this.#maxSteps; step += 1) {
      if (isSignalAborted(options.signal)) {
        return this.#stopped(step - 1, messages, "cancelled");
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
        return this.#stopped(step, messages, "cancelled");
      }

      if (response.kind === "final") {
        const answer = assistantText(response.content).trim();
        if (answer.length === 0) {
          return this.#failed(
            step,
            messages,
            "invalid_model_response",
            "The model returned neither tool calls nor a final answer.",
          );
        }

        messages.push({
          role: "assistant",
          content: [...response.content],
          toolCalls: [],
        });
        return { kind: "final_answer", answer, steps: step, messages: [...messages] };
      }

      if (response.calls.length === 0) {
        return this.#failed(
          step,
          messages,
          "invalid_model_response",
          "The model returned an empty tool call list.",
        );
      }

      if (response.calls.length > 1) {
        return this.#failed(
          step,
          messages,
          "invalid_model_response",
          "The model returned multiple tool calls in one response.",
        );
      }

      const call = response.calls[0];
      if (
        call === undefined ||
        call.id.trim().length === 0 ||
        call.name.trim().length === 0 ||
        seenToolCallIds.has(call.id)
      ) {
        return this.#failed(
          step,
          messages,
          "invalid_model_response",
          "The model returned a missing or duplicate tool call identity.",
        );
      }

      if (isSignalAborted(options.signal)) {
        return this.#stopped(step, messages, "cancelled");
      }

      const operationId = randomUUID();
      if (
        !(await this.#persistSessionEvent({
          type: "tool_intent",
          turnId,
          step,
          operationId,
          call,
          replayContent: [...response.content],
        }))
      ) {
        return this.#sessionFailure(step, messages);
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: [call],
      });
      seenToolCallIds.add(call.id);
      const toolStep = await this.#completeToolStep(
        messages,
        turnId,
        step,
        operationId,
        call,
        options,
        "normal",
      );
      if (toolStep.kind === "terminal") {
        return toolStep.result;
      }
    }

    return this.#stopped(this.#maxSteps, messages, "max_steps");
  }

  async #completeToolStep(
    messages: AgentMessage[],
    turnId: string,
    step: number,
    operationId: string,
    call: ToolCall,
    options: RunOptions,
    mode: "normal" | "recovery",
  ): Promise<ToolStepOutcome> {
    this.#transition({
      type: "execute_tool",
      step,
      toolCallId: call.id,
      toolName: call.name,
    });
    this.#emit(options.onEvent, {
      type: "tool_call",
      step,
      operationId,
      call,
    });
    if (isSignalAborted(options.signal)) {
      return {
        kind: "terminal",
        result: this.#stopped(step, messages, "cancelled"),
      };
    }

    let observation: Observation;
    if (mode === "recovery" && !RECOVERABLE_TOOL_NAMES.has(call.name)) {
      observation = recoveryUnknownOutcome(call, operationId);
    } else {
      try {
        observation = await this.#runtime.execute(call, {
          operationId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.requestApproval === undefined
            ? {}
            : { requestApproval: options.requestApproval }),
        });
      } catch {
        if (isSignalAborted(options.signal)) {
          return {
            kind: "terminal",
            result: this.#stopped(step, messages, "cancelled"),
          };
        }
        return {
          kind: "terminal",
          result: this.#failed(
            step,
            messages,
            "runtime_error",
            "The tool runtime failed before it could return an observation.",
          ),
        };
      }
    }

    if (observation.toolCallId !== call.id) {
      return {
        kind: "terminal",
        result: this.#failed(
          step,
          messages,
          "runtime_error",
          "The tool runtime returned an observation for the wrong tool call.",
        ),
      };
    }

    messages.push({
      role: "tool",
      operationId,
      toolCallId: call.id,
      toolName: call.name,
      observation,
    });
    this.#emit(options.onEvent, { type: "observation", step, observation });
    if (
      !(await this.#persistSessionEvent({
        type: "tool_observation",
        turnId,
        step,
        operationId,
        observation,
      }))
    ) {
      return {
        kind: "terminal",
        result: this.#sessionFailure(step, messages),
      };
    }
    if (isSignalAborted(options.signal)) {
      return {
        kind: "terminal",
        result: this.#stopped(step, messages, "cancelled"),
      };
    }
    return { kind: "continued" };
  }

  #requireNoActiveRun(): void {
    if (this.#activeController !== undefined) {
      throw new Error("AgentCore already has an active run.");
    }
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
        result: this.#stopped(step - 1, messages, "cancelled"),
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
            result: this.#stopped(step, messages, "cancelled"),
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
              result: this.#stopped(step, messages, "cancelled"),
            };
          }
          return {
            kind: "terminal",
            result: this.#failed(
              step,
              messages,
              "provider_error",
              `The provider retry wait failed (${waitError.kind}).`,
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
  ): RunResult {
    if (reason === "cancelled" && isAgentRunActive(this.#runState)) {
      this.#transition({ type: "cancel" });
    }
    return { kind: "stopped", reason, steps, messages: [...messages] };
  }

  #failed(
    steps: number,
    messages: readonly AgentMessage[],
    reason: RunFailureReason,
    message: string,
    providerFailure?: ProviderFailure,
  ): RunResult {
    return {
      kind: "failed",
      reason,
      message,
      steps,
      messages: [...messages],
      ...(providerFailure === undefined ? {} : { providerFailure }),
    };
  }

  #sessionFailure(
    steps: number,
    messages: readonly AgentMessage[],
  ): RunResult {
    return this.#failed(
      steps,
      messages,
      "session_persist_failed",
      "The Agent could not persist required Session state. Any completed tool side effect remains associated with its operation ID.",
    );
  }

  async #persistSessionEvent(event: SessionEventInput): Promise<boolean> {
    if (this.#session === undefined) {
      return true;
    }
    try {
      await this.#session.append(event);
      return true;
    } catch {
      return false;
    }
  }

  async #persistTurnOutcome(
    turnId: string,
    result: RunResult,
  ): Promise<RunResult> {
    if (
      result.kind === "failed" &&
      result.reason === "session_persist_failed"
    ) {
      return result;
    }

    const event: SessionEventInput =
      result.kind === "final_answer"
        ? {
            type: "turn_finished",
            turnId,
            steps: result.steps,
            outcome: "completed",
            answer: result.answer,
          }
        : result.kind === "stopped"
          ? {
              type: "turn_finished",
              turnId,
              steps: result.steps,
              outcome: result.reason,
              reason: result.reason,
            }
          : {
              type: "turn_finished",
              turnId,
              steps: result.steps,
              outcome: "failed",
              reason: result.reason,
              message: result.message,
            };

    if (await this.#persistSessionEvent(event)) {
      return result;
    }
    return this.#sessionFailure(result.steps, result.messages);
  }

  #emitTerminal(onEvent: RunOptions["onEvent"], result: RunResult): void {
    if (result.kind === "final_answer") {
      this.#emit(onEvent, {
        type: "final_answer",
        step: result.steps,
        answer: result.answer,
      });
      return;
    }
    if (result.kind === "stopped") {
      this.#emit(onEvent, {
        type: "stopped",
        steps: result.steps,
        reason: result.reason,
      });
      return;
    }
    this.#emit(onEvent, {
      type: "failed",
      steps: result.steps,
      reason: result.reason,
      message: result.message,
      ...(result.providerFailure === undefined
        ? {}
        : { providerFailure: result.providerFailure }),
    });
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

type ToolStepOutcome =
  | { readonly kind: "continued" }
  | { readonly kind: "terminal"; readonly result: RunResult };

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function collectToolCallIds(messages: readonly AgentMessage[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? message.toolCalls.map((call) => call.id)
        : [],
    ),
  );
}

function recoveryUnknownOutcome(
  call: ToolCall,
  operationId: string,
): Observation {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: "error",
    error: {
      code: "recovery_unknown_outcome",
      message:
        `The previous ${call.name} execution may or may not have completed ` +
        "before the Agent stopped. It was not executed again. Inspect " +
        "workspace state with read-only tools before deciding the next action.",
      retryable: false,
      details: {
        operationId,
        outcome: "unknown",
        executedAgain: false,
      },
    },
  };
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
