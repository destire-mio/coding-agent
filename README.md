# coding-agent

A build-to-learn Coding Agent project aiming for a runnable, explainable,
testable, production-grade v1.

## Current milestone: read-only ReAct loop

The first vertical slice is implemented around one real task:

```text
User: "Read README.md from the workspace and summarize it"
→ minimal TUI
→ Agent Core calls the model
→ model-generated Read tool call
→ Tool Runtime parses arguments and enforces the workspace boundary
→ Read returns a structured Observation
→ Core sends the Observation back to the model
→ model returns a final answer
```

The model proposes actions; it never reads files directly. Core owns the loop and
termination. Tool Runtime owns argument validation, permission checks, and tool
execution.

Core also owns the lifecycle of one active run:

```text
idle → requesting_model → executing_tool → requesting_model → settled
                  └──────── Esc/cancel ────────→ cancelling → settled
```

The TUI only turns Esc into a cancellation request. Core changes the run state
and aborts the same signal used by the Provider request and retry wait. Runtime
does not receive a speculative cancellation protocol in this read-only
milestone. If Read has already started, it may finish and its real Observation
is retained, but Core stops before another model request.

## Requirements

- Node.js 22 or newer
- npm
- A DeepSeek API key

## Install

```bash
npm install
npm run build
```

Create a local `.env` from `.env.example` and fill in your provider settings.
The application deliberately does not load a workspace's `.env` automatically.

```dotenv
DEEPSEEK_API_KEY=replace-me
CODING_AGENT_MODEL=deepseek-v4-flash
CODING_AGENT_BASE_URL=https://api.deepseek.com
```

DeepSeek thinking mode is enabled. The Adapter converts streamed
`reasoning_content` into provider-neutral `think` parts, Core retains the
complete assistant message, and the Adapter replays the reasoning on later
requests in the same run. The TUI renders reasoning separately from the final
answer. This milestone does not persist it to disk; Session Transcript retention
belongs to the later Session milestone, and reasoning will not enter long-term
Memory/RAG.

The v1 Provider boundary is intentionally limited to OpenAI-compatible Chat
Completions. It does not implement the OpenAI Responses API or Anthropic's native
Messages protocol; a configured provider must expose a compatible Chat
Completions endpoint.

Run the TUI with an explicit workspace:

```bash
node --env-file=.env dist/cli.js --workspace /absolute/path/to/workspace
```

Or run the acceptance task immediately:

```bash
node --env-file=.env dist/cli.js \
  --workspace /absolute/path/to/workspace \
  --prompt "读取 workspace 中的 README.md 并总结"
```

`--max-steps` limits model rounds. Reaching the limit produces
`stopped: max_steps`; it is never reported as success.

## Internal contracts

```text
ToolCall
= model proposal: id + tool name + raw arguments

AssistantContentPart
= provider-neutral text or think content retained by Core

Observation
= Runtime evidence: matching toolCallId + success/output or error/code

RunResult
= Core terminal result: final_answer, stopped(max_steps/cancelled), or failed

AgentRunState
= Core-owned lifecycle: idle, requesting_model, executing_tool, cancelling,
  or settled with an outcome
```

Expected tool failures such as invalid arguments, missing files, and permission
denials are returned to the model as error Observations. Provider or Core failures
terminate the run instead.

## Streaming boundary

Provider stream fragments are drafts, not executable tool calls. The Adapter
normalizes thinking, text, and tool-call deltas for the TUI, assembles complete
assistant content and tool arguments, and
only returns a `ToolCall` after the provider cleanly finishes with
`finish_reason: "tool_calls"`. If the stream disconnects, ends without a finish
reason, or finishes because of truncation, Core returns a Provider failure and
Tool Runtime is not called.

The TUI coalesces streaming updates every 50 ms. It keeps bounded text and tool
argument previews, while successful reasoning is accumulated and retained per
step in the current TUI trajectory. The Adapter and Core preserve the complete
response independently of rendering. Partial reasoning from a failed Provider
attempt is discarded before retrying.

## Provider failures and retries

The Adapter converts SDK and protocol failures into provider-neutral error
kinds. Authentication, permission, quota exhaustion, invalid requests, invalid
responses, and user cancellation fail fast. Rate limits, connection failures,
timeouts, interrupted streams, 408/409 responses, and 5xx/529 responses may be
retried by Core.

Retries repeat only the current model request. They do not restart the Agent or
repeat an already completed tool call. A Provider attempt therefore does not
consume another ReAct step:

```text
step 2, attempt 1 → 429
step 2, attempt 2 → final answer
```

Core uses at most 3 attempts per model request, starting with 500 ms exponential
backoff, up to 25% jitter, a 30-second delay cap, and bounded `Retry-After`
support. The OpenAI SDK's own retries are disabled so every attempt is visible
to Core and the TUI. Provider requests have a 60-second timeout. The Core API
accepts an external `AbortSignal`, and Core also exposes a cancellation entry
used by Esc while the TUI is running. Both routes abort the same active run and
produce `stopped: cancelled`.

## Verify

```bash
npm run verify
```

The deterministic suite covers:

- TUI → Core → model double → Read → Observation → model double → final answer;
- workspace path traversal, outside absolute paths, and symlink escapes;
- malformed arguments and missing files;
- `maxSteps` stopping without claiming completion;
- missing provider configuration failing closed;
- streamed thinking, text, and fragmented tool arguments being assembled
  correctly;
- DeepSeek thinking enabled without unsupported `tool_choice`;
- a real local OpenAI-compatible HTTP Read trajectory that verifies the second
  request contains the first response's reasoning, ToolCall, and Observation;
- interrupted or truncated streams producing a Provider failure with zero tool
  executions;
- typed 401/429/quota/timeout/5xx/cancellation classification;
- a real local OpenAI-compatible HTTP 429 followed by a visible Core retry;
- retrying the second model request without repeating a successful Read;
- cancellation interrupting retry backoff and preventing tool execution;
- Core state transitions for model requests, tool execution, cancellation, and
  terminal outcomes;
- TUI Esc aborting an active Provider request through Core;
- cancellation during an in-flight Read retaining its completed Observation
  while preventing the next model request;
- TUI frames for streamed reasoning, text, and tool arguments;
- a clean TypeScript build and executable CLI entry point.

The real-provider smoke is separate because it spends provider quota and requires
credentials:

```bash
node --env-file=.env --import tsx scripts/real-smoke.ts
```

It creates a temporary workspace, requires the real model to call Read, verifies
the matching Observation, checks that thinking, tool-call, and text stream
deltas were received, verifies that tool-call reasoning was retained by Core,
and checks that the final answer contains a marker read from the file.

## Design reference

The Provider work was checked against Kimi Code at pinned commit
[`56b5480`](https://github.com/MoonshotAI/kimi-code/tree/56b5480ed0da2274f062cd9a38a281187cbe8c36).
This project adopts provider-neutral deltas, the no-partial-execution gate, and
50 ms TUI coalescing. It also adopts typed retryability, per-step retry budgets,
exponential backoff with jitter, `Retry-After`, and cancellation-aware waiting.

There are deliberate simplifications and deviations. Kimi's Core defaults to
10 attempts and its OpenAI client retains SDK retries; this milestone uses 3
Core-visible attempts and disables SDK retries so its attempt count is directly
explainable and testable. It also does not yet persist interrupted turns or
write a synthetic unexecuted tool result; those belong to later Session and
recovery milestones.

The Thinking round-trip was separately checked against Kimi Code at pinned
commit
[`619564d`](https://github.com/MoonshotAI/kimi-code/tree/619564dcf9ee10a3cfbf7ecbc764c6b9b63fc91b).
This project adopts its provider-neutral `think` content, separate thinking
stream, and Adapter-owned conversion back to DeepSeek's reasoning field.
Unlike Kimi's Transcript layer, this milestone retains reasoning only in the
current run and TUI; disk persistence waits for the Session milestone.

The Agent cancellation design was checked at the same pinned commit against
Kimi's stateful Agent/TurnFlow lifecycle, stateless loop `AbortSignal`, and Esc
keyboard tests. This project adopts Agent-owned cancellation and signal
propagation, but deliberately omits Kimi's Session, dialog, compaction,
double-Esc exit, and subagent states. Its current Read boundary is cooperative:
an already-started read completes and records reality, then the Core stops.

## Current security boundary

- Only the `read` tool is registered.
- Read accepts a relative path, canonicalizes it, and rejects paths or symlinks
  resolving outside the workspace.
- Read accepts regular UTF-8 files up to 128 KiB for this milestone.
- File contents returned by Read are sent to the configured model provider as an
  Observation. The provider is therefore part of the data trust boundary.
- Model reasoning may repeat sensitive material from the prompt or Observation.
  It is displayed in the TUI and retained in the current in-memory `RunResult`,
  but is not written to the workspace, Git, long-term Memory, or telemetry.
- Application-level path checks are not an OS sandbox and do not yet defend every
  concurrent filesystem race. Stronger sandboxing is a later milestone.
- Bash, Edit, MCP, plugins, long-term Session/Memory, multi-agent behavior, and a
  complex TUI are intentionally absent.

## Status

On 2026-08-31, the deterministic suite passed 44 tests across 11 test files. The
suite includes an in-process OpenAI-compatible HTTP server that returns 429 then
streams success, proving the retry is owned and surfaced by Core rather than
hidden inside the SDK. A second real HTTP trajectory proves that
`reasoning_content` is streamed into a generic `think` part and serialized back
beside the original ToolCall and Read Observation on the next request. Retrying
the second model request preserves the existing Observation and executes Read
only once. A deterministic Ink TUI trajectory also proves that Esc reaches the
Core state machine, aborts the Provider signal, and ends as
`stopped: cancelled`. A separate in-flight Read test proves that its completed
Observation is retained while the next model request is suppressed.

The real-provider smoke passed with DeepSeek Thinking in two model rounds:
reasoning and tool-call arguments were streamed, Core retained the tool-call
reasoning, Runtime returned a successful matching Observation, and streamed
final text contained the file's private marker. It used 2 Provider attempts
with 0 retries. The compiled TUI also completed a real `package.json` Read,
retained `step 1 thinking › ...` in the visible trajectory, and displayed
`tool call read → observation success → final answer` before exiting normally.

This proves the current minimum chain runs; it does not yet prove the later
production-strength Provider, sandbox, Session, or recovery milestones.

## License

[MIT](LICENSE)
