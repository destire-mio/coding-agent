import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { foldSessionTranscript } from "../src/session/session-transcript-fold.js";
import { SessionTranscriptStore } from "../src/session/session-transcript-store.js";

const root = await mkdtemp(join(tmpdir(), "coding-agent-cli-resume-"));
const workspace = join(root, "workspace");
const sessionRoot = join(root, "sessions");
const sessionId = `cli-resume-${randomUUID()}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestBodies: unknown[] = [];
const finalMarker = "CLI_RESUME_FINAL_MARKER";
const reopenedFinalMarker = "CLI_REOPEN_FINAL_MARKER";
const children: ChildProcess[] = [];
let reportFirstRequest: () => void = () => undefined;
const firstRequestReceived = new Promise<void>((resolveRequest) => {
  reportFirstRequest = resolveRequest;
});
let allowFirstResponse: () => void = () => undefined;
const firstResponseGate = new Promise<void>((resolveResponse) => {
  allowFirstResponse = resolveResponse;
});

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const body = await readRequestBody(request);
  requestBodies.push(JSON.parse(body));
  if (requestBodies.length === 1) {
    reportFirstRequest();
    await firstResponseGate;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
  response.write(
    chunk({ reasoning_content: "The durable Observation is sufficient." }),
  );
  response.write(chunk({
    content: requestBodies.length === 1 ? finalMarker : reopenedFinalMarker,
  }));
  response.write(chunk({}, "stop"));
  response.end("data: [DONE]\n\n");
});

try {
  await mkdir(workspace);
  const session = await SessionTranscriptStore.create({
    workspaceRoot: workspace,
    root: sessionRoot,
    sessionId,
  });
  await session.append({
    type: "turn_started",
    turnId: "cli-resume-turn",
    userInput: "Summarize the durable README Observation",
  });
  await session.append({
    type: "tool_intent",
    turnId: "cli-resume-turn",
    step: 1,
    operationId: "cli-resume-operation",
    call: {
      id: "cli-resume-call",
      name: "read",
      rawArguments: JSON.stringify({ path: "README.md" }),
    },
    replayContent: [{ type: "think", think: "I need README.md." }],
  });
  await session.append({
    type: "tool_observation",
    turnId: "cli-resume-turn",
    step: 1,
    operationId: "cli-resume-operation",
    observation: {
      toolCallId: "cli-resume-call",
      toolName: "read",
      status: "success",
      output: { content: "CLI_RESUME_OBSERVATION_MARKER" },
    },
  });

  const port = await listen(server);
  const first = spawnCli(port);
  await withTimeout(
    firstRequestReceived,
    5_000,
    "The first CLI did not reach the Provider.",
  );

  const second = spawnCli(port);
  const secondResult = await withTimeout(
    second.completion,
    5_000,
    "The competing CLI did not fail fast.",
  );
  if (
    secondResult.exitCode !== 1 ||
    !secondResult.stderr.includes(
      `Session ${sessionId} is already running in another process.`,
    )
  ) {
    throw new Error(
      `Competing CLI did not return session_busy. stdout=${secondResult.stdout} stderr=${secondResult.stderr}`,
    );
  }
  assertProviderRequestCount(1);

  allowFirstResponse();
  const firstResult = await withTimeout(
    first.completion,
    5_000,
    "The first CLI did not finish after the Provider responded.",
  );
  if (firstResult.exitCode !== 0) {
    throw new Error(
      `Compiled CLI exited ${firstResult.exitCode}. stdout=${firstResult.stdout} stderr=${firstResult.stderr}`,
    );
  }

  const reopened = await SessionTranscriptStore.open({
    workspaceRoot: workspace,
    root: sessionRoot,
    sessionId,
  });
  const state = foldSessionTranscript(await reopened.load());
  if (
    state.kind !== "finished" ||
    state.turn.outcome !== "completed" ||
    state.turn.answer !== finalMarker
  ) {
    throw new Error("The compiled CLI did not durably finish the resumed Turn.");
  }
  assertProviderRequestCount(1);
  const requestJson = JSON.stringify(requestBodies[0]);
  if (!requestJson.includes("CLI_RESUME_OBSERVATION_MARKER")) {
    throw new Error("The Provider request omitted the durable Observation.");
  }

  const previousEvents = await reopened.load();
  const newPrompt = "What marker did the previous Read return?";
  const nextTurn = spawnCli(port, [
    "--session", sessionId, "--prompt", newPrompt,
  ]);
  const nextTurnResult = await withTimeout(
    nextTurn.completion,
    5_000,
    "The reopened CLI did not finish its new Turn.",
  );
  if (nextTurnResult.exitCode !== 0) {
    throw new Error(
      `Reopened CLI failed. stdout=${nextTurnResult.stdout} stderr=${nextTurnResult.stderr}`,
    );
  }
  assertProviderRequestCount(2);
  const reopenedRequestJson = JSON.stringify(requestBodies[1]);
  for (const evidence of [
    "CLI_RESUME_OBSERVATION_MARKER", "cli-resume-call", finalMarker, newPrompt,
  ]) {
    if (!reopenedRequestJson.includes(evidence)) {
      throw new Error(`The reopened Context omitted ${evidence}.`);
    }
  }
  if (reopenedRequestJson.includes("I need README.md.")) {
    throw new Error("Completed reasoning leaked into the new Turn Context.");
  }
  const afterReopen = await reopened.load();
  if (
    JSON.stringify(afterReopen.slice(0, previousEvents.length)) !==
    JSON.stringify(previousEvents)
  ) {
    throw new Error("Reopening a Session changed its previous facts.");
  }
  const appended = afterReopen.slice(previousEvents.length);
  const newStart = appended[0];
  const newFinish = appended[1];
  if (
    appended.length !== 2 ||
    newStart?.type !== "turn_started" ||
    newStart.turnId === "cli-resume-turn" ||
    newStart.userInput !== newPrompt ||
    newFinish?.type !== "turn_finished" ||
    newFinish.turnId !== newStart.turnId ||
    newFinish.answer !== reopenedFinalMarker
  ) {
    throw new Error("Reopening did not durably append one distinct new Turn.");
  }

  const heldLease = await reopened.acquireRunLease();
  try {
    const busyReopen = await withTimeout(
      spawnCli(port, ["--session", sessionId, "--prompt", "New task"]).completion,
      5_000,
      "The busy --session invocation did not fail fast.",
    );
    if (busyReopen.exitCode !== 1 || !busyReopen.stderr.includes("already running")) {
      throw new Error("--session did not enforce the existing Session lease.");
    }
  } finally {
    await heldLease.release();
  }

  const configPath = join(workspace, "config.ts");
  await writeFile(configPath, "UNCHANGED_CONFIG\n", "utf8");
  for (const position of ["awaiting_model", "recovering_tool"] as const) {
    const pendingId = `${sessionId}-${position}`;
    const pending = await SessionTranscriptStore.create({
      workspaceRoot: workspace,
      root: sessionRoot,
      sessionId: pendingId,
    });
    await pending.append({
      type: "turn_started",
      turnId: "unfinished-turn",
      userInput: "Edit config.ts",
    });
    if (position === "recovering_tool") {
      await pending.append({
        type: "tool_intent",
        turnId: "unfinished-turn",
        step: 1,
        operationId: "unfinished-edit-operation",
        call: {
          id: "unfinished-edit-call",
          name: "edit",
          rawArguments: JSON.stringify({
            path: "config.ts",
            old_string: "UNCHANGED_CONFIG",
            new_string: "SHOULD_NOT_WRITE",
            expected_version: "unverified-version",
          }),
        },
        replayContent: [],
      });
    }
    const pendingBefore = await pending.load();
    const rejected = await withTimeout(
      spawnCli(port, [
        "--session", pendingId,
        ...(position === "recovering_tool" ? ["--prompt", "Skip the old task"] : []),
      ]).completion,
      5_000,
      "The unfinished Session was not rejected promptly.",
    );
    if (
      rejected.exitCode !== 1 ||
      !rejected.stderr.includes(`Use --continue ${pendingId}`) ||
      JSON.stringify(await pending.load()) !== JSON.stringify(pendingBefore)
    ) {
      throw new Error(`--session skipped or changed an unfinished ${position} Turn.`);
    }
  }
  if (await readFile(configPath, "utf8") !== "UNCHANGED_CONFIG\n") {
    throw new Error("Rejecting an unfinished Session must not execute its Edit.");
  }
  const conflictingFlags = await withTimeout(
    spawnCli(port, ["--session", sessionId, "--continue", sessionId]).completion,
    5_000,
    "Conflicting Session flags were not rejected promptly.",
  );
  if (
    conflictingFlags.exitCode !== 2 ||
    !conflictingFlags.stderr.includes("--session cannot be combined with --continue.")
  ) {
    throw new Error("Rejected Session commands must make zero Provider requests.");
  }
  assertProviderRequestCount(2);

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        sessionId,
        providerRequests: requestBodies.length,
        competingExitCode: secondResult.exitCode,
        recoveredFrom: "awaiting_model",
        finalMarker,
        reopenedFinalMarker,
        newTurnId: newStart.turnId,
        unfinishedPositionsRejected: ["awaiting_model", "recovering_tool"],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  allowFirstResponse();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    }
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
}

function assertProviderRequestCount(expected: number): void {
  if (requestBodies.length !== expected) {
    throw new Error(`Expected ${expected} Provider requests, got ${requestBodies.length}.`);
  }
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-session-resume",
    object: "chat.completion.chunk",
    created: 0,
    model: "session-resume-smoke-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk_ of request) {
    chunks.push(Buffer.isBuffer(chunk_) ? chunk_ : Buffer.from(chunk_));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server_: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server_.once("error", reject);
    server_.listen(0, "127.0.0.1", () => {
      server_.off("error", reject);
      resolveListen();
    });
  });
  const address = server_.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local Provider server did not expose a TCP port.");
  }
  return address.port;
}

interface CliProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnCli(
  port: number,
  sessionArguments: readonly string[] = ["--continue", sessionId],
): {
  readonly child: ChildProcess;
  readonly completion: Promise<CliProcessResult>;
} {
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "dist", "cli.js"),
      "--workspace",
      workspace,
      ...sessionArguments,
      "--max-steps",
      "4",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "session-resume-smoke-key",
        CODING_AGENT_MODEL: "session-resume-smoke-model",
        CODING_AGENT_BASE_URL: `http://127.0.0.1:${port}/v1`,
        CODING_AGENT_SESSION_ROOT: sessionRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (data: Buffer) => stdout.push(data));
  child.stderr?.on("data", (data: Buffer) => stderr.push(data));
  const completion = new Promise<CliProcessResult>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolveExit({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  return { child, completion };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
