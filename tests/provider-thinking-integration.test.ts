import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type { RunEvent } from "../src/core/contracts.js";
import type { ProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const servers: ReturnType<typeof createServer>[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        }),
    ),
  );
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("round-trips DeepSeek reasoning through a real HTTP Read trajectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-thinking-http-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "HTTP_THINKING_MARKER\n", "utf8");

  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) {
      rawBody += chunk.toString();
    }
    requestBodies.push(JSON.parse(rawBody) as Record<string, unknown>);

    if (requestBodies.length === 1) {
      sendSse(response, [
        sseChunk({ reasoning_content: "I need the real README. " }),
        sseChunk({
          reasoning_content: "I will call Read.",
          tool_calls: [
            {
              index: 0,
              id: "call-http-read",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        }),
        sseChunk({}, "tool_calls"),
      ]);
      return;
    }

    sendSse(response, [
      sseChunk({ reasoning_content: "The Observation contains the marker." }),
      sseChunk({ content: "HTTP_THINKING_MARKER" }),
      sseChunk({}, "stop"),
    ]);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on a TCP port.");
  }

  const config: ProviderConfig = {
    apiKey: "local-test-key",
    model: "deepseek-v4-flash",
    baseURL: `http://127.0.0.1:${address.port}`,
    thinking: "enabled",
  };
  const provider = new OpenAICompatibleProvider(config);
  const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });
  const core = new AgentCore(provider, runtime, { maxSteps: 4 });
  const events: RunEvent[] = [];

  const result = await core.run("Read README.md and report its marker.", {
    onEvent: (event) => events.push(event),
  });

  expect(result).toMatchObject({
    kind: "final_answer",
    answer: "HTTP_THINKING_MARKER",
    steps: 2,
  });
  expect(requestBodies).toHaveLength(2);
  expect(requestBodies[0]).toMatchObject({
    thinking: { type: "enabled" },
  });
  expect(requestBodies[0]).not.toHaveProperty("tool_choice");

  const secondMessages = requestBodies[1]?.messages as
    | Array<Record<string, unknown>>
    | undefined;
  const assistant = secondMessages?.find(
    (message) => message.role === "assistant",
  );
  const tool = secondMessages?.find((message) => message.role === "tool");
  expect(assistant).toMatchObject({
    reasoning_content: "I need the real README. I will call Read.",
    tool_calls: [
      {
        id: "call-http-read",
        function: { name: "read", arguments: '{"path":"README.md"}' },
      },
    ],
  });
  expect(tool?.content).toContain("HTTP_THINKING_MARKER");
  expect(events).toContainEqual({
    type: "model_thinking_delta",
    step: 1,
    attempt: 1,
    delta: "I need the real README. ",
  });
  expect(
    result.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "think" &&
            part.think.includes("I need the real README"),
        ),
    ),
  ).toBe(true);
});

function sendSse(
  response: ServerResponse,
  chunks: readonly Record<string, unknown>[],
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function sseChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-thinking-http",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    created: 0,
    model: "deepseek-v4-flash",
    object: "chat.completion.chunk",
  };
}
