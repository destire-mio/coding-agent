import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelProvider,
  ModelRequest,
  Observation,
  ToolCall,
  ToolExecutor,
} from "../src/core/contracts.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
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
      messages: [],
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
      messages: [
        { role: "user", content: "Read README.md" },
        {
          role: "assistant",
          content: [{ type: "text", text: "README summary" }],
          toolCalls: [],
        },
      ],
    });
  });

  it("rebuilds completed facts before an unfinished second Turn", async () => {
    const store = await createStore("fold-second-turn");
    await store.append({
      type: "turn_started",
      turnId: "turn-first",
      userInput: "Summarize README.md",
    });
    await store.append({
      ...intent("turn-first"),
      replayContent: [
        { type: "think", think: "PRIVATE_FIRST_TURN_REASONING" },
        { type: "text", text: "I will read the file." },
      ],
    });
    await store.append(observation("turn-first"));
    await store.append({
      type: "turn_finished",
      turnId: "turn-first",
      steps: 2,
      outcome: "completed",
      answer: "README summary",
    });
    await store.append({
      type: "turn_started",
      turnId: "turn-second",
      userInput: "What is its license?",
    });

    const state = foldSessionTranscript(await store.load());

    expect(state).toMatchObject({
      kind: "awaiting_model",
      turnId: "turn-second",
      nextStep: 1,
      messages: [
        { role: "user", content: "Summarize README.md" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I will read the file." }],
          toolCalls: [{ id: "call-read", name: "read" }],
        },
        {
          role: "tool",
          toolCallId: "call-read",
          observation: {
            status: "success",
            output: { content: "# README" },
          },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "README summary" }],
          toolCalls: [],
        },
        { role: "user", content: "What is its license?" },
      ],
    });
    expect(JSON.stringify(state)).not.toContain("PRIVATE_FIRST_TURN_REASONING");
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

describe("Core finished-Session reopening", () => {
  it("loads history without execution and starts a distinct Turn on new input", async () => {
    const harness = await createStoreHarness("reopen-finished");
    await appendTurnStart(harness.store, "previous-turn");
    await harness.store.append(intent("previous-turn"));
    await harness.store.append(observation("previous-turn"));
    await harness.store.append({
      type: "turn_finished",
      turnId: "previous-turn",
      outcome: "completed",
      answer: "README summary",
      steps: 2,
    });
    const previousEvents = await harness.store.load();
    const opened = await SessionTranscriptStore.openForRun({
      workspaceRoot: harness.workspace,
      root: join(harness.root, "sessions"),
      sessionId: harness.store.sessionId,
    });

    try {
      const state = foldSessionTranscript(opened.events);
      if (state.kind !== "finished") {
        throw new Error("Expected a finished Session.");
      }
      const requests: ModelRequest[] = [];
      let runtimeCalls = 0;
      const core = new AgentCore(
        {
          complete: async (request) => {
            requests.push(request);
            return {
              kind: "final",
              content: [{ type: "text", text: "The heading was README." }],
            };
          },
        },
        {
          definitions: () => [],
          execute: async () => {
            runtimeCalls += 1;
            throw new Error("Opening history must not rerun an old tool.");
          },
        },
        { session: opened.session, initialSession: state },
      );

      expect(core.state).toEqual({ phase: "idle" });
      expect(requests).toHaveLength(0);
      expect(runtimeCalls).toBe(0);
      expect(await opened.session.load()).toEqual(previousEvents);

      const result = await core.run("What was the heading?");

      expect(result.kind).toBe("final_answer");
      expect(runtimeCalls).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.messages).toEqual([
        ...state.messages,
        { role: "user", content: "What was the heading?" },
      ]);
      expect(JSON.stringify(requests[0])).toContain("# README");
      expect(JSON.stringify(requests[0])).not.toContain("I need the file.");
      const events = await opened.session.load();
      expect(events.slice(0, previousEvents.length)).toEqual(previousEvents);
      const newEvents = events.slice(previousEvents.length);
      expect(newEvents).toMatchObject([
        { type: "turn_started", userInput: "What was the heading?" },
        { type: "turn_finished", outcome: "completed" },
      ]);
      const started = newEvents[0];
      if (started?.type !== "turn_started") {
        throw new Error("Expected a new turn_started record.");
      }
      expect(started.turnId).not.toBe("previous-turn");
    } finally {
      await opened.lease.release();
    }
  });

  it("refuses history from a different Session writer", async () => {
    const source = await createStore("reopen-source");
    const destination = await createStore("reopen-destination");
    const state = foldSessionTranscript(await source.load());
    if (state.kind !== "no_turn") {
      throw new Error("Expected an empty Session.");
    }
    expect(
      () =>
        new AgentCore(
          {
            complete: async () => {
              throw new Error("Must not call Provider.");
            },
          },
          {
            definitions: () => [],
            execute: async () => {
              throw new Error("Must not execute a tool.");
            },
          },
          { session: destination, initialSession: state },
        ),
    ).toThrow(
      "AgentCore initial Session requires the matching Session event writer.",
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

describe("Core recovering-tool resume", () => {
  it("reruns a pending Read with its original operation identity", async () => {
    const harness = await createStoreHarness("resume-read");
    await writeFile(
      join(harness.workspace, "README.md"),
      "# Recovery\n\nREAD_RECOVERY_MARKER\n",
      "utf8",
    );
    await appendTurnStart(harness.store, "turn-read");
    await harness.store.append(intent("turn-read"));
    const state = foldSessionTranscript(await harness.store.load());
    if (state.kind !== "recovering_tool") {
      throw new Error("Expected a recovering-tool state.");
    }

    const realRuntime = await ToolRuntime.readOnly({
      workspaceRoot: harness.workspace,
    });
    const executions: Array<{ call: ToolCall; operationId?: string }> = [];
    const runtime: ToolExecutor = {
      definitions: () => realRuntime.definitions(),
      execute: async (call, options) => {
        executions.push({
          call,
          ...(options?.operationId === undefined
            ? {}
            : { operationId: options.operationId }),
        });
        return realRuntime.execute(call, options);
      },
    };
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        return {
          kind: "final",
          content: [{ type: "text", text: "Recovered README summary" }],
        };
      },
    };
    const core = new AgentCore(provider, runtime, {
      session: harness.store,
      maxSteps: 4,
    });

    const result = await core.resume(state);

    expect(result).toMatchObject({
      kind: "final_answer",
      answer: "Recovered README summary",
      steps: 2,
    });
    expect(executions).toEqual([
      {
        call: state.intent.call,
        operationId: "operation-read",
      },
    ]);
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "READ_RECOVERY_MARKER",
    );
    expect((await harness.store.load()).map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
      "tool_intent",
      "tool_observation",
      "turn_finished",
    ]);
  });

  it("reruns a pending Grep and gives its new Observation to the model", async () => {
    const harness = await createStoreHarness("resume-grep");
    await writeFile(
      join(harness.workspace, "app.log"),
      "INFO ready\nERROR GREP_RECOVERY_MARKER\n",
      "utf8",
    );
    await appendTurnStart(harness.store, "turn-grep");
    const call: ToolCall = {
      id: "call-grep",
      name: "grep",
      rawArguments: JSON.stringify({ pattern: "^ERROR", path: "app.log" }),
    };
    await harness.store.append(
      toolIntent("turn-grep", "operation-grep", call),
    );
    const state = foldSessionTranscript(await harness.store.load());
    if (state.kind !== "recovering_tool") {
      throw new Error("Expected a recovering-tool state.");
    }
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: harness.workspace,
    });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        return {
          kind: "final",
          content: [{ type: "text", text: "Recovered Grep result" }],
        };
      },
    };
    const core = new AgentCore(provider, runtime, {
      session: harness.store,
      maxSteps: 4,
    });

    const result = await core.resume(state);

    expect(result.kind).toBe("final_answer");
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "GREP_RECOVERY_MARKER",
    );
  });

  it("uses the Edit journal instead of writing an applied operation again", async () => {
    const harness = await createStoreHarness("resume-edit");
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "export const timeout = 30;\n", "utf8");
    const runtimeOptions = {
      workspaceRoot: harness.workspace,
      editOperationRoot: join(harness.root, "edit-operations"),
      toolOutputRoot: join(harness.root, "tool-output"),
    };
    const firstRuntime = await ToolRuntime.withEdit(runtimeOptions);
    const version = readVersion(
      await firstRuntime.execute({
        id: "call-version",
        name: "read",
        rawArguments: JSON.stringify({ path: "config.ts" }),
      }),
    );
    const call: ToolCall = {
      id: "call-edit",
      name: "edit",
      rawArguments: JSON.stringify({
        path: "config.ts",
        old_string: "timeout = 30",
        new_string: "timeout = 60",
        expected_version: version,
      }),
    };
    const operationId = "operation-edit-recovery";
    await appendTurnStart(harness.store, "turn-edit");
    await harness.store.append(toolIntent("turn-edit", operationId, call));
    const applied = await firstRuntime.execute(call, {
      operationId,
      requestApproval: async () => "approved",
    });
    expect(applied.status).toBe("success");
    const appliedInode = (await stat(path, { bigint: true })).ino;

    const state = foldSessionTranscript(await harness.store.load());
    if (state.kind !== "recovering_tool") {
      throw new Error("Expected a recovering-tool state.");
    }
    const restartedRuntime = await ToolRuntime.withEdit(runtimeOptions);
    let approvals = 0;
    const provider: ModelProvider = {
      complete: async () => ({
        kind: "final",
        content: [{ type: "text", text: "Edit recovery confirmed" }],
      }),
    };
    const core = new AgentCore(provider, restartedRuntime, {
      session: harness.store,
      maxSteps: 4,
    });

    const result = await core.resume(state, {
      requestApproval: async () => {
        approvals += 1;
        return "approved";
      },
    });

    expect(result).toMatchObject({
      kind: "final_answer",
      answer: "Edit recovery confirmed",
    });
    expect(approvals).toBe(0);
    await expect(readFile(path, "utf8")).resolves.toBe(
      "export const timeout = 60;\n",
    );
    expect((await stat(path, { bigint: true })).ino).toBe(appliedInode);
  });

  it("turns an unfinished Bash into unknown outcome without executing it", async () => {
    const store = await createStore("resume-bash");
    await appendTurnStart(store, "turn-bash");
    const call: ToolCall = {
      id: "call-bash",
      name: "bash",
      rawArguments: JSON.stringify({ command: "touch SHOULD_NOT_EXIST" }),
    };
    await store.append(toolIntent("turn-bash", "operation-bash", call));
    const state = foldSessionTranscript(await store.load());
    if (state.kind !== "recovering_tool") {
      throw new Error("Expected a recovering-tool state.");
    }

    let runtimeCalls = 0;
    let approvalCalls = 0;
    const requests: ModelRequest[] = [];
    const runtime: ToolExecutor = {
      definitions: () => [],
      execute: async () => {
        runtimeCalls += 1;
        throw new Error("Bash must not be executed during recovery.");
      },
    };
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        return {
          kind: "final",
          content: [{ type: "text", text: "Bash outcome is unknown" }],
        };
      },
    };
    const core = new AgentCore(provider, runtime, {
      session: store,
      maxSteps: 4,
    });

    const result = await core.resume(state, {
      requestApproval: async () => {
        approvalCalls += 1;
        return "approved";
      },
    });

    expect(result.kind).toBe("final_answer");
    expect(runtimeCalls).toBe(0);
    expect(approvalCalls).toBe(0);
    const recoveredObservation = requests[0]?.messages.at(-1);
    expect(recoveredObservation).toMatchObject({
      role: "tool",
      operationId: "operation-bash",
      observation: {
        status: "error",
        error: {
          code: "recovery_unknown_outcome",
          retryable: false,
          details: {
            operationId: "operation-bash",
            outcome: "unknown",
            executedAgain: false,
          },
        },
      },
    });
    expect((await store.load()).map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
      "tool_intent",
      "tool_observation",
      "turn_finished",
    ]);
  });
});

async function createStore(sessionId: string): Promise<SessionTranscriptStore> {
  return (await createStoreHarness(sessionId)).store;
}

async function createStoreHarness(sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-session-fold-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = await SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: join(root, "sessions"),
    sessionId,
  });
  return { root, workspace, store };
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

function intent(
  turnId: string,
): Extract<SessionEventInput, { type: "tool_intent" }> {
  return toolIntent(turnId, "operation-read", {
    id: "call-read",
    name: "read",
    rawArguments: JSON.stringify({ path: "README.md" }),
  });
}

function toolIntent(
  turnId: string,
  operationId: string,
  call: ToolCall,
): Extract<SessionEventInput, { type: "tool_intent" }> {
  return {
    type: "tool_intent",
    turnId,
    step: 1,
    operationId,
    call,
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

function readVersion(observation: Observation): string {
  if (observation.status !== "success") {
    throw new Error("Expected Read to return a version.");
  }
  if (typeof observation.output !== "object" || observation.output === null) {
    throw new Error("Expected structured Read output.");
  }
  const version = (observation.output as Record<string, unknown>)["version"];
  if (typeof version !== "string") {
    throw new Error("Expected Read to return a version.");
  }
  return version;
}
