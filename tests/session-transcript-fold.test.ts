import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelProvider,
  ModelRequest,
  ToolExecutor,
} from "../src/core/contracts.js";
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
      sessionId: "fold-empty",
    });
  });

  it("waits for the model when only the user input is durable", async () => {
    const store = await createStore("fold-user");
    await appendTurnStart(store, "turn-user");

    expect(foldSessionTranscript(await store.load())).toEqual({
      kind: "awaiting_model",
      sessionId: "fold-user",
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

describe("Core awaiting-model resume", () => {
  it("continues from a durable Observation without executing the tool again", async () => {
    const store = await createStore("resume-observation");
    await appendTurnStart(store, "turn-resume");
    await store.append(intent("turn-resume"));
    await store.append(observation("turn-resume"));
    const state = foldSessionTranscript(await store.load());
    if (state.kind !== "awaiting_model") {
      throw new Error("Expected an awaiting-model recovery state.");
    }

    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        return {
          kind: "final",
          content: [{ type: "text", text: "README summary" }],
        };
      },
    };
    let runtimeCalls = 0;
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => {
        runtimeCalls += 1;
        throw new Error("The recovered Read must not execute again.");
      },
    };
    const core = new AgentCore(provider, runtime, {
      session: store,
      maxSteps: 4,
    });

    const result = await core.resume(state);

    expect(result).toMatchObject({
      kind: "final_answer",
      answer: "README summary",
      steps: 2,
    });
    expect(runtimeCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual(state.messages);
    expect((await store.load()).map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
      "tool_intent",
      "tool_observation",
      "turn_finished",
    ]);
  });

  it("refuses to append a resumed Turn to a different Session", async () => {
    const source = await createStore("resume-source");
    await appendTurnStart(source, "turn-source");
    const state = foldSessionTranscript(await source.load());
    if (state.kind !== "awaiting_model") {
      throw new Error("Expected an awaiting-model recovery state.");
    }
    const destination = await createStore("resume-destination");
    const provider: ModelProvider = {
      complete: async () => {
        throw new Error("The Provider must not run for a mismatched Session.");
      },
    };
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => {
        throw new Error("The Runtime must not run for a mismatched Session.");
      },
    };
    const core = new AgentCore(provider, runtime, { session: destination });

    await expect(core.resume(state)).rejects.toThrow(
      "AgentCore resume requires the matching Session event writer.",
    );
    expect((await destination.load()).map((event) => event.type)).toEqual([
      "session_started",
    ]);
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
