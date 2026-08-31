import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type { RunEvent, ToolExecutor } from "../src/core/contracts.js";
import type { ProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";

const servers: ReturnType<typeof createServer>[] = [];

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
});

it("retries a real OpenAI-compatible HTTP 429 visibly through Core", async () => {
  let httpRequests = 0;
  const server = createServer((_request, response) => {
    httpRequests += 1;
    if (httpRequests === 1) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after-ms": "1",
      });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify(chunk({ content: "recovered" }, null))}\n\n`,
    );
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
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
  const runtime: ToolExecutor = {
    definitions: () => [],
    execute: async () => {
      throw new Error("must not execute");
    },
  };
  const core = new AgentCore(provider, runtime, {
    providerRetry: {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    },
  });
  const events: RunEvent[] = [];

  const result = await core.run("answer", {
    onEvent: (event) => events.push(event),
  });

  expect(result).toMatchObject({
    kind: "final_answer",
    answer: "recovered",
    steps: 1,
  });
  expect(httpRequests).toBe(2);
  expect(events).toContainEqual({
    type: "provider_retry",
    step: 1,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 2,
    delayMs: 0,
    errorKind: "rate_limit",
  });
  expect(
    events.filter((event) => event.type === "model_request"),
  ).toHaveLength(2);
});

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-local-retry",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    created: 0,
    model: "deepseek-v4-flash",
    object: "chat.completion.chunk",
  };
}
