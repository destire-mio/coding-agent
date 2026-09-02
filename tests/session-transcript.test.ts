import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunEvent,
  ToolCall,
} from "../src/core/contracts.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { SessionBusyError } from "../src/session/session-run-lease.js";
import { foldSessionTranscript } from "../src/session/session-transcript-fold.js";
import {
  SessionTranscriptConfigurationError,
  SessionTranscriptCorruptError,
  SessionTranscriptNotFoundError,
  SessionTranscriptStore,
  type SessionEventInput,
  type SessionEventWriter,
} from "../src/session/session-transcript-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Session transcript JSONL", () => {
  it("appends complete events and reloads them in order", async () => {
    const harness = await createStore("session-order");
    await harness.store.append({
      type: "turn_started",
      turnId: "turn-order",
      userInput: "Read README.md",
    });
    await harness.store.append({
      type: "turn_finished",
      turnId: "turn-order",
      steps: 1,
      outcome: "completed",
      answer: "done",
    });

    const events = await harness.store.load();

    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
      "turn_finished",
    ]);
    expect((await stat(harness.store.transcriptPath)).mode & 0o777).toBe(0o600);
    await expect(readFile(harness.store.transcriptPath, "utf8")).resolves.toMatch(
      /\n$/,
    );
  });

  it("truncates only an incomplete tail before appending again", async () => {
    const harness = await createStore("session-tail");
    await harness.store.append({
      type: "turn_started",
      turnId: "turn-tail",
      userInput: "Read README.md",
    });
    await appendFile(
      harness.store.transcriptPath,
      '{"schemaVersion":1,"type":"tool_obser',
      "utf8",
    );

    const reopened = await SessionTranscriptStore.create({
      workspaceRoot: harness.workspace,
      root: harness.storeRoot,
      sessionId: "session-tail",
    });
    await reopened.append({
      type: "turn_finished",
      turnId: "turn-tail",
      steps: 0,
      outcome: "cancelled",
      reason: "cancelled",
    });

    expect((await reopened.load()).map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
      "turn_finished",
    ]);
    expect(await readFile(reopened.transcriptPath, "utf8")).not.toContain(
      "tool_obser",
    );
  });

  it("fails closed when a committed middle event is corrupt", async () => {
    const harness = await createStore("session-corrupt");
    await appendFile(harness.store.transcriptPath, "not-json\n", "utf8");

    await expect(
      SessionTranscriptStore.create({
        workspaceRoot: harness.workspace,
        root: harness.storeRoot,
        sessionId: "session-corrupt",
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptCorruptError);
  });

  it("requires the private Session store to stay outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-agent-session-boundary-"));
    temporaryRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    const forbiddenRoot = join(workspace, ".session-state");
    await expect(
      SessionTranscriptStore.create({
        workspaceRoot: workspace,
        root: forbiddenRoot,
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptConfigurationError);
    await expect(stat(forbiddenRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("opens an existing Session without appending another start event", async () => {
    const harness = await createStore("session-open");
    await harness.store.append({
      type: "turn_started",
      turnId: "turn-open",
      userInput: "Read README.md",
    });

    const opened = await SessionTranscriptStore.open({
      workspaceRoot: harness.workspace,
      root: harness.storeRoot,
      sessionId: "session-open",
    });

    expect(opened.transcriptPath).toBe(harness.store.transcriptPath);
    expect((await opened.load()).map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
    ]);
  });

  it("does not create a Session when open receives an unknown identity", async () => {
    const harness = await createStore("session-existing");
    const workspaceBucket = dirname(dirname(harness.store.transcriptPath));

    await expect(
      SessionTranscriptStore.open({
        workspaceRoot: harness.workspace,
        root: harness.storeRoot,
        sessionId: "session-missing",
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptNotFoundError);
    await expect(stat(join(workspaceBucket, "session-missing"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("allows only one active runner for a Session", async () => {
    const harness = await createStore("session-single-runner");
    const first = await harness.store.acquireRunLease();

    await expect(harness.store.acquireRunLease()).rejects.toBeInstanceOf(
      SessionBusyError,
    );

    await first.release();
    const next = await harness.store.acquireRunLease();
    await next.release();
  });
});

describe("Core Session ordering", () => {
  it("records a real Core → Read → Observation → final trajectory", async () => {
    const harness = await createStore("session-real-chain");
    await writeFile(
      join(harness.workspace, "README.md"),
      "# Session\n\nREAL_SESSION_MARKER\n",
      "utf8",
    );
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: harness.workspace,
    });
    const provider = new ScriptedProvider([
      toolResponse(readCall("README.md"), "I need the real file."),
      finalResponse("The README contains REAL_SESSION_MARKER."),
    ]);
    const core = new AgentCore(provider, runtime, { session: harness.store });

    const result = await core.run("Read README.md");
    const events = await harness.store.load();

    expect(result).toMatchObject({
      kind: "final_answer",
      answer: "The README contains REAL_SESSION_MARKER.",
    });
    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "turn_started",
      "tool_intent",
      "tool_observation",
      "turn_finished",
    ]);
    expect(JSON.stringify(events)).toContain("REAL_SESSION_MARKER");
  });

  it("persists one Tool Intent before Runtime and its Observation afterward", async () => {
    const order: string[] = [];
    const session = new RecordingSession((event) => {
      order.push(`session:${event.type}`);
    });
    const provider = new ScriptedProvider([
      toolResponse(readCall("README.md"), "private recovery reasoning"),
      finalResponse("done", "final reasoning is not persisted"),
    ]);
    let runtimeOperationId: string | undefined;
    const core = new AgentCore(
      provider,
      {
        definitions: () => [],
        execute: async (call, options) => {
          order.push("runtime:execute");
          runtimeOperationId = options?.operationId;
          return {
            toolCallId: call.id,
            toolName: call.name,
            status: "success",
            output: "README",
          };
        },
      },
      { session },
    );

    const result = await core.run("Read README.md");

    expect(result.kind).toBe("final_answer");
    expect(order).toEqual([
      "session:turn_started",
      "session:tool_intent",
      "runtime:execute",
      "session:tool_observation",
      "session:turn_finished",
    ]);
    const intent = session.events.find((event) => event.type === "tool_intent");
    const observation = session.events.find(
      (event) => event.type === "tool_observation",
    );
    expect(intent).toMatchObject({
      type: "tool_intent",
      operationId: runtimeOperationId,
      replayContent: [
        { type: "think", think: "private recovery reasoning" },
      ],
    });
    expect(observation).toMatchObject({
      type: "tool_observation",
      operationId: runtimeOperationId,
    });
    expect(session.events.at(-1)).toMatchObject({
      type: "turn_finished",
      outcome: "completed",
      answer: "done",
    });
    expect(JSON.stringify(session.events.at(-1))).not.toContain(
      "final reasoning is not persisted",
    );
  });

  it("does not call the Provider when Turn start persistence fails", async () => {
    const session = new RecordingSession(undefined, "turn_started");
    const provider = new ScriptedProvider([finalResponse("must not run")]);
    const core = new AgentCore(provider, noToolRuntime(), { session });

    const result = await core.run("answer");

    expect(result).toMatchObject({
      kind: "failed",
      reason: "session_persist_failed",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("leaves the file unchanged when Tool Intent persistence fails", async () => {
    const harness = await createEditHarness();
    const version = await readVersion(harness.runtime, "config.ts");
    const provider = new ScriptedProvider([
      toolResponse(editCall(version), "I will edit exactly once."),
    ]);
    const session = new RecordingSession(undefined, "tool_intent");
    const core = new AgentCore(provider, harness.runtime, { session });

    const result = await core.run("set timeout to 60", {
      requestApproval: async () => "approved",
    });

    expect(result).toMatchObject({
      kind: "failed",
      reason: "session_persist_failed",
    });
    await expect(readFile(join(harness.workspace, "config.ts"), "utf8")).resolves.toBe(
      "export const timeout = 30;\n",
    );
  });

  it("reports Session failure without hiding an already applied Edit", async () => {
    const harness = await createEditHarness();
    const version = await readVersion(harness.runtime, "config.ts");
    const provider = new ScriptedProvider([
      toolResponse(editCall(version), "I will edit exactly once."),
    ]);
    const session = new RecordingSession(undefined, "tool_observation");
    const core = new AgentCore(provider, harness.runtime, { session });

    const result = await core.run("set timeout to 60", {
      requestApproval: async () => "approved",
    });

    expect(result).toMatchObject({
      kind: "failed",
      reason: "session_persist_failed",
    });
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
    await expect(readFile(join(harness.workspace, "config.ts"), "utf8")).resolves.toBe(
      "export const timeout = 60;\n",
    );
    expect(session.events.map((event) => event.type)).toEqual([
      "turn_started",
      "tool_intent",
    ]);
  });

  it("does not mark a final answer complete when Turn outcome persistence fails", async () => {
    const session = new RecordingSession(undefined, "turn_finished");
    const provider = new ScriptedProvider([finalResponse("unsaved answer")]);
    const core = new AgentCore(provider, noToolRuntime(), { session });

    const result = await core.run("answer");

    expect(result).toMatchObject({
      kind: "failed",
      reason: "session_persist_failed",
    });
    expect(result.messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "unsaved answer" }],
      toolCalls: [],
    });
  });
});

describe("Core admission after Session persistence failure", () => {
  const boundaries = [
    { type: "turn_started", before: "no_turn", after: "awaiting_model" },
    { type: "tool_intent", before: "awaiting_model", after: "recovering_tool" },
    { type: "tool_observation", before: "recovering_tool", after: "awaiting_model" },
    { type: "turn_finished", before: "awaiting_model", after: "finished" },
  ] as const;

  it.each(boundaries.flatMap((boundary) =>
    (["before", "after"] as const).map((timing) => ({ ...boundary, timing })),
  ))("blocks stale Core calls after $type fails $timing append", async ({
    type, timing, before, after,
  }) => {
    const harness = await createStore(`failed-${type}-${timing}`);
    await writeFile(join(harness.workspace, "README.md"), "RECOVERY_MARKER\n");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: harness.workspace });
    const provider = new ScriptedProvider([
      toolResponse(readCall("README.md"), "read first"),
      finalResponse("done"),
      finalResponse("must not start a new Turn"),
    ]);
    let failOnce = true;
    let appendCalls = 0;
    let runtimeCalls = 0;
    const writer: SessionEventWriter = {
      sessionId: harness.store.sessionId,
      async append(event) {
        appendCalls++;
        const fail = failOnce && event.type === type;
        if (fail) failOnce = false;
        if (fail && timing === "before") throw new Error("injected write failure");
        await harness.store.append(event);
        // A rejected write does not prove that no bytes reached the file.
        if (fail && timing === "after") throw new Error("injected acknowledgement failure");
      },
    };
    const core = new AgentCore(provider, {
      definitions: () => runtime.definitions(),
      execute: async (call, options) => {
        runtimeCalls++;
        return runtime.execute(call, options);
      },
    }, { session: writer });
    const lease = await harness.store.acquireRunLease();
    try {
      expect(await core.run("Read README.md")).toMatchObject({
        kind: "failed", reason: "session_persist_failed",
      });
      const durableEvents = await harness.store.load();
      const state = foldSessionTranscript(durableEvents);
      expect(state.kind).toBe(timing === "before" ? before : after);
      const previousCounts = [appendCalls, provider.requests.length, runtimeCalls];
      const runEvents: RunEvent[] = [];
      const rejected = await core.run("Start another task", {
        onEvent: (event) => runEvents.push(event),
      });
      // The old bug appended a second turn_started here and corrupted folding.
      expect(await harness.store.load()).toEqual(durableEvents);
      expect(rejected).toMatchObject({
        kind: "failed", reason: "session_persist_failed", steps: 0,
      });
      expect(runEvents).toMatchObject([
        { type: "failed", reason: "session_persist_failed", steps: 0 },
      ]);
      if (state.kind === "awaiting_model" || state.kind === "recovering_tool") {
        expect(await core.resume(state)).toMatchObject({
          kind: "failed", reason: "session_persist_failed", steps: 0,
        });
      }
      expect(core.requiresSessionReload).toBe(true);
      expect([appendCalls, provider.requests.length, runtimeCalls]).toEqual(previousCounts);
      expect(await harness.store.load()).toEqual(durableEvents);
    } finally {
      await lease.release();
    }

    // Reopen through the production lock/read path, then build a fresh Core.
    // Durable state (not the failed return value) selects resume vs new Turn.
    const reopened = await SessionTranscriptStore.openForRun({
      workspaceRoot: harness.workspace, root: harness.storeRoot,
      sessionId: harness.store.sessionId,
    });
    try {
      const state = foldSessionTranscript(reopened.events);
      const ready = state.kind === "no_turn" || state.kind === "finished";
      const fresh = new AgentCore(new ScriptedProvider([finalResponse("recovered")]),
        await ToolRuntime.readOnly({ workspaceRoot: harness.workspace }), {
          session: reopened.session,
          ...(ready ? { initialSession: state } : {}),
        });
      expect(fresh.requiresSessionReload).toBe(false);
      const result = ready ? await fresh.run("New task") : await fresh.resume(state);
      expect(result.kind).toBe("final_answer");
      expect(foldSessionTranscript(await reopened.session.load()).kind).toBe("finished");
      expect(core.requiresSessionReload).toBe(true);
    } finally {
      await reopened.lease.release();
    }
  });

  it("still accepts a new Turn after an ordinary failure was durably finished", async () => {
    const harness = await createStore("durable-normal-failure");
    const provider = new ScriptedProvider([
      { kind: "tool_calls", calls: [], content: [] },
      finalResponse("next Turn succeeded"),
    ]);
    const core = new AgentCore(provider, noToolRuntime(), { session: harness.store });
    expect(await core.run("Invalid model response")).toMatchObject({
      kind: "failed", reason: "invalid_model_response",
    });
    expect(core.requiresSessionReload).toBe(false);
    expect((await core.run("Try a new task")).kind).toBe("final_answer");
    expect(foldSessionTranscript(await harness.store.load()).kind).toBe("finished");
  });
});

class RecordingSession implements SessionEventWriter {
  readonly sessionId = "recording-session";
  readonly events: SessionEventInput[] = [];

  constructor(
    private readonly onAppend?: (event: SessionEventInput) => void,
    private readonly failOn?: SessionEventInput["type"],
  ) {}

  async append(event: SessionEventInput): Promise<void> {
    this.onAppend?.(event);
    if (event.type === this.failOn) {
      throw new Error("injected Session persistence failure");
    }
    this.events.push(event);
  }
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: readonly ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) {
      throw new Error("No scripted response remains.");
    }
    return response;
  }
}

function toolResponse(call: ToolCall, thinking: string): ModelResponse {
  return {
    kind: "tool_calls",
    content: [{ type: "think", think: thinking }],
    calls: [call],
  };
}

function finalResponse(text: string, thinking?: string): ModelResponse {
  return {
    kind: "final",
    content: [
      ...(thinking === undefined
        ? []
        : [{ type: "think" as const, think: thinking }]),
      { type: "text", text },
    ],
  };
}

function readCall(path: string): ToolCall {
  return {
    id: "call-read",
    name: "read",
    rawArguments: JSON.stringify({ path }),
  };
}

function editCall(expectedVersion: string): ToolCall {
  return {
    id: "call-edit",
    name: "edit",
    rawArguments: JSON.stringify({
      path: "config.ts",
      old_string: "timeout = 30",
      new_string: "timeout = 60",
      expected_version: expectedVersion,
    }),
  };
}

function noToolRuntime() {
  return {
    definitions: () => [],
    execute: async () => {
      throw new Error("must not execute");
    },
  };
}

async function createStore(sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-session-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const storeRoot = join(root, "private-sessions");
  await mkdir(workspace);
  const store = await SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: storeRoot,
    sessionId,
  });
  return { workspace, storeRoot, store };
}

async function createEditHarness() {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-session-edit-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "config.ts"),
    "export const timeout = 30;\n",
    "utf8",
  );
  const runtime = await ToolRuntime.withEdit({
    workspaceRoot: workspace,
    editOperationRoot: join(root, "edit-operations"),
    toolOutputRoot: join(root, "tool-output"),
  });
  return { workspace, runtime };
}

async function readVersion(runtime: ToolRuntime, path: string): Promise<string> {
  const observation = await runtime.execute(readCall(path));
  if (observation.status !== "success") {
    throw new Error("Expected Read to succeed.");
  }
  if (typeof observation.output !== "object" || observation.output === null) {
    throw new Error("Expected structured Read output.");
  }
  const version = (observation.output as Record<string, unknown>)["version"];
  if (typeof version !== "string") {
    throw new Error("Expected a Read version.");
  }
  return version;
}
