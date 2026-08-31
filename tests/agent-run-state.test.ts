import { describe, expect, it } from "vitest";

import {
  INITIAL_AGENT_RUN_STATE,
  transitionAgentRunState,
} from "../src/core/agent-run-state.js";

describe("Agent run state machine", () => {
  it("follows model → tool → cancelling → settled for one run", () => {
    const requesting = transitionAgentRunState(INITIAL_AGENT_RUN_STATE, {
      type: "start",
    });
    expect(requesting).toEqual({ phase: "requesting_model", step: 1 });

    const executing = transitionAgentRunState(requesting, {
      type: "execute_tool",
      step: 1,
      toolCallId: "call-readme",
      toolName: "read",
    });
    expect(executing).toEqual({
      phase: "executing_tool",
      step: 1,
      toolCallId: "call-readme",
      toolName: "read",
    });

    const cancelling = transitionAgentRunState(executing, { type: "cancel" });
    expect(cancelling).toEqual({ phase: "cancelling", step: 1 });
    expect(transitionAgentRunState(cancelling, { type: "cancel" })).toBe(
      cancelling,
    );
    expect(
      transitionAgentRunState(cancelling, {
        type: "settle",
        outcome: "cancelled",
      }),
    ).toEqual({ phase: "settled", outcome: "cancelled" });
  });

  it("rejects work that does not belong to an active run", () => {
    expect(() =>
      transitionAgentRunState(INITIAL_AGENT_RUN_STATE, {
        type: "execute_tool",
        step: 1,
        toolCallId: "call-readme",
        toolName: "read",
      }),
    ).toThrow("Invalid Agent run transition: idle -> execute_tool");
  });
});
