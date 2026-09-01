import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  response.write(chunk({ content: finalMarker }));
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
  if (requestBodies.length !== 1) {
    throw new Error("The competing CLI must not contact the Provider.");
  }

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
  if (requestBodies.length !== 1) {
    throw new Error("The resumed CLI must make exactly one Provider request.");
  }
  const requestJson = JSON.stringify(requestBodies[0]);
  if (!requestJson.includes("CLI_RESUME_OBSERVATION_MARKER")) {
    throw new Error("The Provider request omitted the durable Observation.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        sessionId,
        providerRequests: requestBodies.length,
        competingExitCode: secondResult.exitCode,
        recoveredFrom: "awaiting_model",
        finalMarker,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  allowFirstResponse();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
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

function spawnCli(port: number): {
  readonly child: ChildProcess;
  readonly completion: Promise<CliProcessResult>;
} {
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "dist", "cli.js"),
      "--workspace",
      workspace,
      "--continue",
      sessionId,
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
