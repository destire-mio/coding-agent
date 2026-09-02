import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { Observation } from "../src/core/contracts.js";
import { EditOperationStore } from "../src/runtime/edit-operation-store.js";
import { foldSessionTranscript } from "../src/session/session-transcript-fold.js";
import { SessionTranscriptStore } from "../src/session/session-transcript-store.js";
import type { RecoveryFixture, RecoveryProbe } from "./helpers/session-tool-recovery-hooks.js";

type Tool = RecoveryFixture["tool"];
type Checkpoint = Extract<RecoveryProbe, { type: "checkpoint" }>;
interface WireMessage {
  readonly role: string;
  readonly content?: string;
  readonly tool_call_id?: string;
}
interface WireRequest { readonly messages: readonly WireMessage[] }

const root = await mkdtemp(join(tmpdir(), "coding-agent-tool-recovery-"));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children: ReturnType<typeof spawnCli>[] = [];
const requests = new Map<Tool, WireRequest[]>();
const serverErrors: unknown[] = [];
const server = createServer((request, response) => {
  void respond(request, response).catch((error: unknown) => {
    serverErrors.push(error);
    response.writeHead(500).end("Recovery smoke fixture failed.");
  });
});

try {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const port = address.port;

  const prepared = await Promise.allSettled((["read", "grep", "edit", "bash"] as const).map(
    async (tool) => {
      const caseRoot = join(root, tool);
      const workspace = join(caseRoot, "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "README.md"), "RECOVERY_BEFORE\n");
      await writeFile(join(workspace, "app.log"), "RECOVERY_BEFORE\n");
      await writeFile(join(workspace, "config.ts"), "export const marker = 'EDIT_BEFORE';\n");
      const session = await SessionTranscriptStore.create({
        workspaceRoot: workspace,
        root: join(caseRoot, "sessions"),
        sessionId: `cold-${tool}`,
      });
      const fixture = { tool, root: caseRoot, workspace };
      const first = spawnCli(port, { ...fixture, phase: "crash" }, [
        "--session", session.sessionId, "--prompt", `Run the ${tool} recovery fixture.`,
      ]);
      const checkpoint = await withTimeout(Promise.race([
        first.checkpoint,
        first.completion.then((result) => {
          throw new Error(`${tool} exited before checkpoint: ${JSON.stringify({ result, probes: first.probes })}`);
        }),
      ]), `${tool} did not reach the post-execution checkpoint.`);
      assert.equal(checkpoint.observation.status, "success", JSON.stringify(checkpoint));
      const before = await session.load();
      const state = foldSessionTranscript(before);
      assert.equal(state.kind, "recovering_tool");
      assert(state.kind === "recovering_tool");
      assert.equal(state.intent.call.name, tool);
      assert.equal(state.intent.operationId, checkpoint.operationId);
      assert.deepEqual(state.intent.call, checkpoint.call);
      assert.equal(before.at(-1)?.type, "tool_intent");
      assert.deepEqual(first.probes.filter((p) => p.type === "execute").map((p) => p.call.name),
        tool === "edit" ? ["read", "edit"] : [tool]);
      assert.equal(first.probes.filter((p) => p.type === "approval").length,
        tool === "edit" || tool === "bash" ? 1 : 0);
      if (tool === "read" || tool === "grep") {
        assert(JSON.stringify(checkpoint.observation).includes("RECOVERY_BEFORE"));
      }
      if (tool === "bash") {
        assert.equal(await readFile(join(workspace, "bash-runs.txt"), "utf8"), "BASH_ONCE\n");
        const output = checkpoint.observation.status === "success"
          ? checkpoint.observation.output as { exitCode: number; processStopped: boolean }
          : undefined;
        assert.equal(output?.exitCode, 0);
        assert.equal(output?.processStopped, true);
      }
      const operationStore = await EditOperationStore.create({
        root: join(caseRoot, "edit-operations"),
      });
      const editRecord = await operationStore.read(checkpoint.operationId);
      if (tool === "edit") {
        assert.equal(editRecord?.state, "applied");
        assert.equal(await readFile(join(workspace, "config.ts"), "utf8"),
          "export const marker = 'EDIT_AFTER';\n");
      }
      const editedStat = await stat(join(workspace, "config.ts"));
      assert(first.child.kill("SIGKILL"));
      const killed = await withTimeout(first.completion, `${tool} did not die.`);
      assert.equal(killed.signal, "SIGKILL");
      assert.deepEqual(await session.load(), before, "Killing must leave the pending Intent unchanged.");
      // A different marker proves Read/Grep really execute after restart, not
      // that a non-durable in-memory result was smuggled into the new process.
      await writeFile(join(workspace, "README.md"), "RECOVERY_AFTER\n");
      await writeFile(join(workspace, "app.log"), "RECOVERY_AFTER\n");
      return { fixture, session, before, state, checkpoint, editedStat, operationStore, editRecord };
    },
  ));
  // Wait for all setup attempts before cleanup, so no late spawn can escape it.
  const cases = prepared.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

  process.stdout.write("All 4 real tool executions reached the missing-Observation window and were SIGKILLed.\n");
  // The real lease has a 5s stale period; include filesystem mtime precision
  // margin, as in session-run-lease.test.ts. Do not delete or bypass the lock.
  await delay(6_500);

  await Promise.all(cases.map(async ({
    fixture, session, before, state, checkpoint, editedStat, operationStore, editRecord,
  }) => {
    const { tool, workspace } = fixture;
    const recovery = spawnCli(port, { ...fixture, phase: "resume" }, [
      "--continue", session.sessionId,
    ]);
    const result = await withTimeout(recovery.completion, `${tool} recovery did not finish.`);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert(result.stdout.includes(`RECOVERED_${tool}`));
    const after = await session.load();
    assert.deepEqual(after.slice(0, before.length), before, "Recovery must preserve old facts.");
    const appended = after.slice(before.length);
    assert.equal(appended.length, 2, "Recovery must append one Observation and one terminal event.");
    const observationEvent = appended[0];
    assert(observationEvent?.type === "tool_observation");
    assert.equal(observationEvent.turnId, state.turnId);
    assert.equal(observationEvent.step, state.step);
    assert.equal(observationEvent.operationId, checkpoint.operationId);
    assert.equal(observationEvent.observation.toolCallId, checkpoint.call.id);
    const finished = foldSessionTranscript(after);
    assert(finished.kind === "finished");
    assert.equal(finished.turn.turnId, state.turnId);
    assert.equal(finished.turn.outcome, "completed");
    assert.equal(finished.turn.answer, `RECOVERED_${tool}`);

    const executions = recovery.probes.filter((probe) => probe.type === "execute");
    assert.equal(recovery.probes.filter((probe) => probe.type === "approval").length, 0);
    assert.equal(executions.length, tool === "bash" ? 0 : 1);
    if (tool !== "bash") {
      assert.deepEqual(executions[0], {
        type: "execute", call: checkpoint.call, operationId: checkpoint.operationId,
      });
    }
    const observation = observationEvent.observation;
    if (tool === "read" || tool === "grep") {
      assert.equal(observation.status, "success");
      assert(JSON.stringify(observation).includes("RECOVERY_AFTER"));
      assert(!JSON.stringify(observation).includes("RECOVERY_BEFORE"));
    } else if (tool === "edit") {
      assert.deepEqual(observation, checkpoint.observation, "Applied Edit must return its original success.");
      assert.equal(await readFile(join(workspace, "config.ts"), "utf8"),
        "export const marker = 'EDIT_AFTER';\n");
      const afterStat = await stat(join(workspace, "config.ts"));
      assert.equal(afterStat.ino, editedStat.ino, "Edit recovery must not replace the file again.");
      assert.equal(afterStat.mtimeMs, editedStat.mtimeMs, "Edit recovery must not rewrite in place.");
      assert.deepEqual(await operationStore.read(checkpoint.operationId), editRecord);
    } else {
      assert(observation.status === "error");
      assert.equal(observation.error.code, "recovery_unknown_outcome");
      assert.equal(observation.error.retryable, false);
      assert.equal(await readFile(join(workspace, "bash-runs.txt"), "utf8"), "BASH_ONCE\n");
    }
    const providerRequests = requests.get(tool)!;
    assert.equal(providerRequests.length, tool === "edit" ? 3 : 2);
    const lastToolMessage = providerRequests.at(-1)!.messages.filter((m) => m.role === "tool").at(-1);
    assert.equal(lastToolMessage?.tool_call_id, checkpoint.call.id);
    assert.deepEqual(JSON.parse(lastToolMessage!.content!), observation,
      "The model must receive exactly the recovered, durable Observation.");
    process.stdout.write(`PASS ${tool}: same Turn/operation, correct recovery, durable Observation delivered to Provider.\n`);
  }));
  assert.deepEqual(serverErrors, []);
  process.stdout.write("PASS: 4 killed CLI processes + 4 fresh --continue processes; local SSE only, no paid model requests.\n");
} finally {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(children.map(({ completion }) => completion));
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  // root is this invocation's mkdtemp directory, never a user directory.
  await rm(root, { recursive: true, force: true });
}

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const match = /^\/(read|grep|edit|bash)\/v1\/chat\/completions$/.exec(request.url ?? "");
  assert.equal(request.method, "POST");
  assert(match);
  const tool = match[1] as Tool;
  const chunks: Buffer[] = [];
  for await (const data of request) chunks.push(Buffer.from(data));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
  const history = requests.get(tool) ?? [];
  history.push(body);
  requests.set(tool, history);
  const observations = body.messages.filter((message) => message.role === "tool");
  let call: { name: Tool; args: Record<string, unknown> } | undefined;
  if (observations.length === 0) {
    call = tool === "grep" ? { name: "grep", args: { pattern: "RECOVERY", path: "app.log" } }
      : tool === "bash" ? { name: "bash", args: { command: "printf 'BASH_ONCE\\n' >> bash-runs.txt" } }
      : { name: "read", args: { path: tool === "edit" ? "config.ts" : "README.md" } };
  } else if (tool === "edit" && observations.length === 1) {
    const read = JSON.parse(observations[0]!.content!) as Observation;
    assert(read.status === "success");
    const version = (read.output as { version: string }).version;
    assert.equal(typeof version, "string");
    call = { name: "edit", args: {
      path: "config.ts", old_string: "EDIT_BEFORE", new_string: "EDIT_AFTER", expected_version: version,
    } };
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(chunk({ reasoning_content: "Use the fixture's tool result." }));
  response.write(chunk(call === undefined ? { content: `RECOVERED_${tool}` } : {
    tool_calls: [{ index: 0, id: `${tool}-call-${observations.length + 1}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) } }],
  }));
  response.write(chunk({}, call === undefined ? "stop" : "tool_calls"));
  response.end("data: [DONE]\n\n");
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "recovery-smoke", object: "chat.completion.chunk", created: 1,
    model: "recovery-smoke", choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

interface CliResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnCli(port: number, fixture: RecoveryFixture, args: readonly string[]): {
  child: ChildProcess;
  completion: Promise<CliResult>;
  checkpoint: Promise<Checkpoint>;
  probes: RecoveryProbe[];
} {
  const child = spawn(process.execPath, [
    "--import", "tsx", "--import", join(repoRoot, "scripts/helpers/session-tool-recovery-hooks.ts"),
    join(repoRoot, "dist/cli.js"), "--workspace", fixture.workspace, ...args, "--max-steps", "4",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "local-recovery-smoke-key",
      CODING_AGENT_MODEL: "local-recovery-smoke",
      CODING_AGENT_BASE_URL: `http://127.0.0.1:${port}/${fixture.tool}/v1`,
      CODING_AGENT_SESSION_ROOT: join(fixture.root, "sessions"),
      CODING_AGENT_RECOVERY_FIXTURE: JSON.stringify(fixture),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const probes: RecoveryProbe[] = [];
  const checkpoint = new Promise<Checkpoint>((resolveCheckpoint) => {
    child.on("message", (probe: RecoveryProbe) => {
      probes.push(probe);
      if (probe.type === "checkpoint") resolveCheckpoint(probe);
    });
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (data: Buffer) => stdout.push(data));
  child.stderr?.on("data", (data: Buffer) => stderr.push(data));
  const completion = new Promise<CliResult>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveExit({
      exitCode, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  const running = { child, completion, checkpoint, probes };
  children.push(running);
  return running;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 15_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
