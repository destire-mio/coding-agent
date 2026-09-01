import type { AgentMessage } from "../core/contracts.js";
import {
  SessionTranscriptCorruptError,
  type SessionEvent,
} from "./session-transcript-store.js";

type TurnFinishedEvent = Extract<SessionEvent, { type: "turn_finished" }>;
type ToolIntentEvent = Extract<SessionEvent, { type: "tool_intent" }>;

export type SessionResumeState =
  | { readonly kind: "no_turn"; readonly sessionId: string }
  | {
      readonly kind: "finished";
      readonly sessionId: string;
      readonly turn: TurnFinishedEvent;
    }
  | {
      readonly kind: "awaiting_model";
      readonly sessionId: string;
      readonly turnId: string;
      readonly nextStep: number;
      readonly messages: readonly AgentMessage[];
    }
  | {
      readonly kind: "recovering_tool";
      readonly sessionId: string;
      readonly turnId: string;
      readonly step: number;
      readonly messages: readonly AgentMessage[];
      readonly intent: ToolIntentEvent;
    };

export type AwaitingModelResumeState = Extract<
  SessionResumeState,
  { readonly kind: "awaiting_model" }
>;

export type ResumableSessionState = Extract<
  SessionResumeState,
  { readonly kind: "awaiting_model" | "recovering_tool" }
>;

interface ActiveTurn {
  readonly turnId: string;
  readonly messages: AgentMessage[];
  readonly seenToolCallIds: Set<string>;
  nextStep: number;
  pendingIntent: ToolIntentEvent | undefined;
}

/** Rebuilds the latest Turn's durable recovery position from Session facts. */
export function foldSessionTranscript(
  events: readonly SessionEvent[],
): SessionResumeState {
  const first = events[0];
  if (first?.type !== "session_started") {
    throw corrupt("The Session transcript must start with session_started.");
  }

  const sessionId = first.sessionId;
  let active: ActiveTurn | undefined;
  let latestFinished: TurnFinishedEvent | undefined;

  for (const [index, event] of events.entries()) {
    if (event.sessionId !== sessionId) {
      throw corrupt("The Session transcript contains another session identity.");
    }
    if (index === 0) {
      continue;
    }

    switch (event.type) {
      case "session_started":
        throw corrupt("The Session transcript starts a Session more than once.");

      case "turn_started":
        if (active !== undefined) {
          throw corrupt("The Session transcript overlaps two unfinished Turns.");
        }
        active = {
          turnId: event.turnId,
          messages: [{ role: "user", content: event.userInput }],
          seenToolCallIds: new Set<string>(),
          nextStep: 1,
          pendingIntent: undefined,
        };
        latestFinished = undefined;
        break;

      case "tool_intent": {
        const turn = requireActiveTurn(active, event.turnId);
        if (turn.pendingIntent !== undefined) {
          throw corrupt(
            "The Session transcript records another Tool Intent before its Observation.",
          );
        }
        if (event.step !== turn.nextStep) {
          throw corrupt("The Session transcript contains an unexpected tool step.");
        }
        if (turn.seenToolCallIds.has(event.call.id)) {
          throw corrupt("The Session transcript repeats a ToolCall identity.");
        }

        turn.messages.push({
          role: "assistant",
          content: event.replayContent,
          toolCalls: [event.call],
        });
        turn.seenToolCallIds.add(event.call.id);
        turn.pendingIntent = event;
        break;
      }

      case "tool_observation": {
        const turn = requireActiveTurn(active, event.turnId);
        const intent = turn.pendingIntent;
        if (intent === undefined) {
          throw corrupt(
            "The Session transcript records an Observation without a Tool Intent.",
          );
        }
        if (
          event.step !== intent.step ||
          event.operationId !== intent.operationId ||
          event.observation.toolCallId !== intent.call.id ||
          event.observation.toolName !== intent.call.name
        ) {
          throw corrupt(
            "The Session transcript cannot pair a Tool Intent with its Observation.",
          );
        }

        turn.messages.push({
          role: "tool",
          operationId: intent.operationId,
          toolCallId: intent.call.id,
          toolName: intent.call.name,
          observation: event.observation,
        });
        turn.pendingIntent = undefined;
        turn.nextStep = intent.step + 1;
        break;
      }

      case "turn_finished":
        requireActiveTurn(active, event.turnId);
        active = undefined;
        latestFinished = event;
        break;
    }
  }

  if (active === undefined) {
    return latestFinished === undefined
      ? { kind: "no_turn", sessionId }
      : { kind: "finished", sessionId, turn: latestFinished };
  }
  if (active.pendingIntent !== undefined) {
    return {
      kind: "recovering_tool",
      sessionId,
      turnId: active.turnId,
      step: active.pendingIntent.step,
      messages: [...active.messages],
      intent: active.pendingIntent,
    };
  }
  return {
    kind: "awaiting_model",
    sessionId,
    turnId: active.turnId,
    nextStep: active.nextStep,
    messages: [...active.messages],
  };
}

function requireActiveTurn(
  active: ActiveTurn | undefined,
  eventTurnId: string,
): ActiveTurn {
  if (active === undefined || active.turnId !== eventTurnId) {
    throw corrupt("The Session event does not belong to the active Turn.");
  }
  return active;
}

function corrupt(message: string): SessionTranscriptCorruptError {
  return new SessionTranscriptCorruptError(message);
}
