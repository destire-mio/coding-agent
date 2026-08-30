import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";

import type { AgentCore } from "../core/agent-core.js";
import type { RunEvent, RunResult } from "../core/contracts.js";

const STREAMING_UI_FLUSH_MS = 50;
const STREAMING_TEXT_PREVIEW_MAX_CHARS = 480;
const STREAMING_TOOL_PREVIEW_MAX_CHARS = 1_024;

export interface AgentAppProps {
  readonly core: AgentCore;
  readonly workspace: string;
  readonly initialPrompt?: string;
  readonly onComplete?: (result: RunResult) => void;
}

interface StreamingToolDraft {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

export function AgentApp({
  core,
  workspace,
  initialPrompt,
  onComplete,
}: AgentAppProps) {
  const { exit } = useApp();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolDrafts, setStreamingToolDrafts] = useState<
    StreamingToolDraft[]
  >([]);
  const pendingStreamingText = useRef("");
  const textFlushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [result, setResult] = useState<RunResult>();
  const autoStarted = useRef(false);

  const clearStreamingText = useCallback(() => {
    pendingStreamingText.current = "";
    if (textFlushTimer.current !== undefined) {
      clearTimeout(textFlushTimer.current);
      textFlushTimer.current = undefined;
    }
    setStreamingText("");
  }, []);

  const submit = useCallback(
    async (value: string) => {
      if (running || value.trim().length === 0) {
        return;
      }

      setRunning(true);
      setEvents([]);
      clearStreamingText();
      setStreamingToolDrafts([]);
      const nextResult = await core.run(value, {
        onEvent: (event) => {
          if (event.type === "model_request") {
            clearStreamingText();
            setStreamingToolDrafts([]);
          } else if (event.type === "model_text_delta") {
            pendingStreamingText.current = (
              pendingStreamingText.current + event.delta
            ).slice(-STREAMING_TEXT_PREVIEW_MAX_CHARS);
            if (textFlushTimer.current === undefined) {
              textFlushTimer.current = setTimeout(() => {
                textFlushTimer.current = undefined;
                setStreamingText(pendingStreamingText.current);
              }, STREAMING_UI_FLUSH_MS);
            }
            return;
          } else if (event.type === "model_tool_call_delta") {
            setStreamingToolDrafts((current) =>
              mergeToolCallDelta(current, event),
            );
            return;
          } else if (
            event.type === "tool_call" ||
            event.type === "final_answer" ||
            event.type === "stopped" ||
            event.type === "failed"
          ) {
            clearStreamingText();
            setStreamingToolDrafts([]);
          }

          const description = describeEvent(event);
          if (description !== undefined) {
            setEvents((current) => [...current, description]);
          }
        },
      });
      setResult(nextResult);
      setRunning(false);
      onComplete?.(nextResult);
    },
    [clearStreamingText, core, onComplete, running],
  );

  useEffect(() => {
    if (initialPrompt !== undefined && !autoStarted.current) {
      autoStarted.current = true;
      void submit(initialPrompt);
    }
  }, [initialPrompt, submit]);

  useEffect(() => {
    if (result !== undefined) {
      exit();
    }
  }, [exit, result]);

  useEffect(
    () => () => {
      if (textFlushTimer.current !== undefined) {
        clearTimeout(textFlushTimer.current);
      }
    },
    [],
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        coding-agent · read-only milestone
      </Text>
      <Text dimColor>workspace: {workspace}</Text>

      {!running && result === undefined && initialPrompt === undefined ? (
        <Box marginTop={1}>
          <Text color="green">task › </Text>
          <TextInput value={prompt} onChange={setPrompt} onSubmit={submit} />
        </Box>
      ) : null}

      {running ? <Text color="yellow">running…</Text> : null}
      {streamingText.length > 0 ? (
        <Text dimColor>stream › {streamingText}</Text>
      ) : null}
      {streamingToolDrafts.map((draft) => (
        <Text key={draft.index} dimColor>
          draft {draft.name || "tool"} ({draft.id || `#${draft.index}`}) ›{" "}
          {draft.argumentsText || "…"}
        </Text>
      ))}
      {events.map((event, index) => (
        <Text key={`${index}:${event}`}>{event}</Text>
      ))}

      {result?.kind === "final_answer" ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="green">
            final answer
          </Text>
          <Text>{result.answer}</Text>
        </Box>
      ) : null}
      {result?.kind === "stopped" ? (
        <Text color="yellow">stopped: {result.reason}</Text>
      ) : null}
      {result?.kind === "failed" ? (
        <Text color="red">
          failed: {result.reason} · {result.message}
        </Text>
      ) : null}
    </Box>
  );
}

function mergeToolCallDelta(
  current: readonly StreamingToolDraft[],
  event: Extract<RunEvent, { type: "model_tool_call_delta" }>,
): StreamingToolDraft[] {
  const previous = current.find((draft) => draft.index === event.index) ?? {
    index: event.index,
    id: "",
    name: "",
    argumentsText: "",
  };
  const next: StreamingToolDraft = {
    index: event.index,
    id: event.id ?? previous.id,
    name: event.name ?? previous.name,
    argumentsText:
      previous.argumentsText + (event.argumentsDelta ?? ""),
  };
  const boundedNext = {
    ...next,
    argumentsText: next.argumentsText.slice(-STREAMING_TOOL_PREVIEW_MAX_CHARS),
  };
  return [...current.filter((draft) => draft.index !== event.index), boundedNext].sort(
    (left, right) => left.index - right.index,
  );
}

function describeEvent(event: RunEvent): string | undefined {
  switch (event.type) {
    case "model_request":
      return `step ${event.step}: model request`;
    case "model_text_delta":
    case "model_tool_call_delta":
      return undefined;
    case "tool_call":
      return `step ${event.step}: tool call ${event.call.name} (${event.call.id})`;
    case "observation":
      return event.observation.status === "success"
        ? `step ${event.step}: observation success (${event.observation.toolCallId})`
        : `step ${event.step}: observation error ${event.observation.error.code} (${event.observation.toolCallId})`;
    case "final_answer":
      return `step ${event.step}: final answer`;
    case "stopped":
      return `stopped after ${event.steps} steps: ${event.reason}`;
    case "failed":
      return `failed after ${event.steps} steps: ${event.reason}`;
  }
}
