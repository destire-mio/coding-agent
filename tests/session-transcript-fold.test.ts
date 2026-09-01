import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { foldSessionTranscript } from "../src/session/session-transcript-fold.js";
import {
  SessionTranscriptCorruptError,
  SessionTranscriptStore,
  type SessionEventInput,
} from "../src/session/session-transcript-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Session transcript fold", () => {
  it("has no Turn to resume in a newly created Session", async () => {
    const store = await createStore("fold-empty");

    expect(foldSessionTranscript(await store.load())).toEqual({
      kind: "no_turn",
    });
  });

  it("waits for the model when only the user input is durable", async () => {
    const store = await createStore("fold-user");
    await appendTurnStart(store, "turn-user");

    expect(foldSessionTranscript(await store.load())).toEqual({
      kind: "awaiting_model",
      turnId: "turn-user",
      nextStep: 1,
      messages: [{ role: "user", content: "Read README.md" }],
    });
  });

  it("recovers a durable Tool Intent that has no Observation", async () => {
    const store = await createStore("fold-intent");
    await appendTurnStart(store, "turn-intent");
    await store.append(intent("turn-intent"));

    const state = foldSessionTranscript(await store.load());

    expect(state).toMatchObject({
      kind: "recovering_tool",
      turnId: "turn-intent",
      step: 1,
      intent: {
        operationId: "operation-read",
        call: { id: "call-read", name: "read" },
      },
      messages: [
        { role: "user", content: "Read README.md" },
        {
          role: "assistant",
          content: [{ type: "think", think: "I need the file." }],
          toolCalls: [{ id: "call-read", name: "read" }],
        },
      ],
    });
  });

  it("rebuilds the complete model context after an Observation", async () => {
    const store = await createStore("fold-observation");
    await appendTurnStart(store, "turn-observation");
    await store.append(intent("turn-observation"));
    await store.append(observation("turn-observation"));

    expect(foldSessionTranscript(await store.load())).toMatchObject({
      kind: "awaiting_model",
      turnId: "turn-observation",
      nextStep: 2,
      messages: [
        { role: "user", content: "Read README.md" },
        {
          role: "assistant",
          toolCalls: [{ id: "call-read", name: "read" }],
        },
        {
          role: "tool",
          operationId: "operation-read",
          toolCallId: "call-read",
          toolName: "read",
          observation: {
            toolCallId: "call-read",
            toolName: "read",
            status: "success",
            output: { content: "# README" },
          },
        },
      ],
    });
  });

  it("does not resume a finished Turn", async () => {
    const store = await createStore("fold-finished");
    await appendTurnStart(store, "turn-finished");
    await store.append({
      type: "turn_finished",
      turnId: "turn-finished",
      steps: 1,
      outcome: "completed",
      answer: "README summary",
    });

    expect(foldSessionTranscript(await store.load())).toMatchObject({
      kind: "finished",
      turn: {
        turnId: "turn-finished",
        outcome: "completed",
        answer: "README summary",
      },
    });
  });

  it("fails closed when an Observation cannot match its Tool Intent", async () => {
    const store = await createStore("fold-mismatch");
    await appendTurnStart(store, "turn-mismatch");
    await store.append(intent("turn-mismatch"));
    const mismatchedObservation = observation("turn-mismatch");
    await store.append({
      ...mismatchedObservation,
      operationId: "another-operation",
    });
    const events = await store.load();

    expect(() => foldSessionTranscript(events)).toThrow(
      SessionTranscriptCorruptError,
    );
  });
});

async function createStore(sessionId: string): Promise<SessionTranscriptStore> {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-session-fold-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: join(root, "sessions"),
    sessionId,
  });
}

async function appendTurnStart(
  store: SessionTranscriptStore,
  turnId: string,
): Promise<void> {
  await store.append({
    type: "turn_started",
    turnId,
    userInput: "Read README.md",
  });
}

function intent(turnId: string): SessionEventInput {
  return {
    type: "tool_intent",
    turnId,
    step: 1,
    operationId: "operation-read",
    call: {
      id: "call-read",
      name: "read",
      rawArguments: JSON.stringify({ path: "README.md" }),
    },
    replayContent: [{ type: "think", think: "I need the file." }],
  };
}

function observation(
  turnId: string,
): Extract<SessionEventInput, { type: "tool_observation" }> {
  return {
    type: "tool_observation",
    turnId,
    step: 1,
    operationId: "operation-read",
    observation: {
      toolCallId: "call-read",
      toolName: "read",
      status: "success",
      output: { content: "# README" },
    },
  };
}
