import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";

import type { AgentCore } from "../core/agent-core.js";
import type { RunEvent, RunResult } from "../core/contracts.js";

export interface AgentAppProps {
  readonly core: AgentCore;
  readonly workspace: string;
  readonly initialPrompt?: string;
  readonly onComplete?: (result: RunResult) => void;
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
  const [result, setResult] = useState<RunResult>();
  const autoStarted = useRef(false);

  const submit = useCallback(
    async (value: string) => {
      if (running || value.trim().length === 0) {
        return;
      }

      setRunning(true);
      setEvents([]);
      const nextResult = await core.run(value, {
        onEvent: (event) => {
          setEvents((current) => [...current, describeEvent(event)]);
        },
      });
      setResult(nextResult);
      setRunning(false);
      onComplete?.(nextResult);
    },
    [core, onComplete, running],
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

function describeEvent(event: RunEvent): string {
  switch (event.type) {
    case "model_request":
      return `step ${event.step}: model request`;
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
