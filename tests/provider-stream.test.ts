import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import type { ModelStreamEvent } from "../src/core/contracts.js";
import { consumeChatCompletionStream } from "../src/provider/openai-compatible-provider.js";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Delta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;
type FinishReason =
  OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"];

describe("OpenAI-compatible provider streaming", () => {
  it("assembles tool call argument deltas before returning a ToolCall", async () => {
    const events: ModelStreamEvent[] = [];
    const response = await consumeChatCompletionStream(
      chunks(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-stream-read",
              type: "function",
              function: { name: "read", arguments: '{"pa' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: 'th":"README.md"}' },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ),
      (event) => events.push(event),
    );

    expect(response).toEqual({
      kind: "tool_calls",
      content: "",
      calls: [
        {
          id: "call-stream-read",
          name: "read",
          rawArguments: '{"path":"README.md"}',
        },
      ],
    });
    expect(events).toEqual([
      {
        type: "tool_call_delta",
        index: 0,
        id: "call-stream-read",
        name: "read",
        argumentsDelta: '{"pa',
      },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: 'th":"README.md"}',
      },
    ]);
  });

  it("assembles text deltas into one final response", async () => {
    const events: ModelStreamEvent[] = [];
    const response = await consumeChatCompletionStream(
      chunks(chunk({ content: "Hello" }), chunk({ content: " world" }), chunk({}, "stop")),
      (event) => events.push(event),
    );

    expect(response).toEqual({ kind: "final", text: "Hello world" });
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
    ]);
  });

  it("rejects a stream that ends before a finish reason", async () => {
    await expect(
      consumeChatCompletionStream(
        chunks(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call-cut-off",
                type: "function",
                function: { name: "read", arguments: '{"path":"READ' },
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow("without a finish reason");
  });

  it("rejects a truncated finish instead of returning partial tool calls", async () => {
    await expect(
      consumeChatCompletionStream(
        chunks(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call-truncated",
                type: "function",
                function: { name: "read", arguments: '{"path":"READ' },
              },
            ],
          }),
          chunk({}, "length"),
        ),
      ),
    ).rejects.toThrow("did not complete safely: length");
  });
});

function chunk(delta: Delta, finishReason: FinishReason = null): Chunk {
  return {
    id: "chatcmpl-stream-test",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    created: 0,
    model: "deepseek-v4-flash",
    object: "chat.completion.chunk",
  };
}

async function* chunks(...values: readonly Chunk[]): AsyncGenerator<Chunk> {
  for (const value of values) {
    yield value;
  }
}
