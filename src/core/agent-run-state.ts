export type AgentRunOutcome =
  | "completed"
  | "cancelled"
  | "max_steps"
  | "failed";

export type AgentRunState =
  | { readonly phase: "idle" }
  | { readonly phase: "requesting_model"; readonly step: number }
  | {
      readonly phase: "executing_tool";
      readonly step: number;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly phase: "cancelling"; readonly step: number }
  | { readonly phase: "settled"; readonly outcome: AgentRunOutcome };

export type AgentRunTransition =
  | { readonly type: "start" }
  | { readonly type: "request_model"; readonly step: number }
  | {
      readonly type: "execute_tool";
      readonly step: number;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly type: "cancel" }
  | { readonly type: "settle"; readonly outcome: AgentRunOutcome };

export const INITIAL_AGENT_RUN_STATE: AgentRunState = { phase: "idle" };

export function transitionAgentRunState(
  state: AgentRunState,
  transition: AgentRunTransition,
): AgentRunState {
  switch (transition.type) {
    case "start":
      if (state.phase === "idle" || state.phase === "settled") {
        return { phase: "requesting_model", step: 1 };
      }
      break;
    case "request_model":
      if (
        state.phase === "requesting_model" ||
        state.phase === "executing_tool"
      ) {
        return { phase: "requesting_model", step: transition.step };
      }
      break;
    case "execute_tool":
      if (
        state.phase === "requesting_model" ||
        state.phase === "executing_tool"
      ) {
        return {
          phase: "executing_tool",
          step: transition.step,
          toolCallId: transition.toolCallId,
          toolName: transition.toolName,
        };
      }
      break;
    case "cancel":
      if (state.phase === "requesting_model" || state.phase === "executing_tool") {
        return { phase: "cancelling", step: state.step };
      }
      if (state.phase === "cancelling") {
        return state;
      }
      break;
    case "settle":
      if (isAgentRunActive(state)) {
        return { phase: "settled", outcome: transition.outcome };
      }
      break;
  }

  throw new Error(
    `Invalid Agent run transition: ${state.phase} -> ${transition.type}`,
  );
}

export function isAgentRunActive(
  state: AgentRunState,
): state is Exclude<AgentRunState, { readonly phase: "idle" | "settled" }> {
  return state.phase !== "idle" && state.phase !== "settled";
}
