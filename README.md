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

Read returns at most one bounded page per tool call. If `complete` is `false`,
the Observation includes `nextCursor`; the model must call Read again with the
same path and pass that value as `cursor`. Core schedules the next proposal but
does not secretly read ahead. Runtime validates the cursor, rejects a changed
file, and returns the next structured page. The cursor is integrity-protected
and bound to that path, so model-edited or cross-file cursors fail instead of
silently skipping content. A single line longer than the page limit is continued
on a UTF-8 character boundary instead of being silently discarded.

Grep locates unknown content with ripgrep regular expressions. It accepts an
optional workspace-relative file or directory, searches the whole workspace
when path is omitted, and returns bounded structured matches. Pagination is a
live re-search: `nextCursor` is integrity-protected and binds the pattern, path,
and result offset, but files changing between calls may still cause repeated or
missed matches. Grep always filters sensitive files and VCS metadata. A timeout
discards partial matches and returns `search_timeout`.

Core also owns the lifecycle of one active run:

```text
idle → requesting_model → executing_tool → requesting_model → settled
                  └──────── Esc/cancel ────────→ cancelling → settled
```

The TUI only turns Esc into a cancellation request. Core changes the run state
and aborts the same signal used by the Provider request, retry wait, and Runtime.
If Read has already started, it ignores the signal, may finish, and retains its
real Observation before Core stops. Grep consumes the signal and terminates its
fixed ripgrep process before returning a cancelled Observation.

## Requirements

- Node.js 22 or newer
- npm
- ripgrep (`rg`) available on `PATH`
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

Read page output
= content + page byte count/line metadata + complete + optional nextCursor

Grep page output
= pattern + path + bounded matches(path/line/text) + complete + optional nextCursor

RunResult
= Core terminal result: final_answer, stopped(max_steps/cancelled), or failed

AgentRunState
= Core-owned lifecycle: idle, requesting_model, executing_tool, cancelling,
  or settled with an outcome
```

Expected tool failures such as invalid arguments, missing files, and permission
denials are returned to the model as error Observations. Provider or Core failures
terminate the run instead.

Model-visible tool definitions come from the same Runtime registry used for
execution. Duplicate names fail during Runtime construction, while an
unregistered name returns a paired `unknown_tool` Observation. If one model
response contains multiple tool calls, Core executes them sequentially in model
order and records their Observations in the same order. The current run's
messages form an in-memory trajectory returned in `RunResult`; persistent audit
storage belongs to the later Session milestone.

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
- duplicate registrations, unknown tools, malformed JSON, invalid schemas, and
  missing files;
- bounded Read continuation across multiple pages, exact reconstruction of one
  oversized UTF-8 line, malformed/tampered/cross-file cursors, and file-change
  rejection;
- ripgrep regular expressions, live Grep pagination, bounded long-line previews,
  empty matches, signed cursor rejection, workspace escapes, sensitive-file
  filtering, unavailable ripgrep, timeout, and cancellation;
- multiple tool calls executing sequentially in model order;
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
- cancellation during an in-flight Read retaining its completed Observation,
  while cancellation during Grep reaches Runtime and terminates ripgrep;
- TUI frames for streamed reasoning, text, and tool arguments;
- a clean TypeScript build and executable CLI entry point.

The real-provider smoke is separate because it spends provider quota and requires
credentials:

```bash
node --env-file=.env --import tsx scripts/real-smoke.ts
node --env-file=.env --import tsx scripts/real-grep-smoke.ts
```

The Read smoke creates a temporary workspace whose marker exists only on the
second page. It requires the real model to follow `nextCursor` and verifies exact
file reconstruction. A model-edited cursor must be rejected; the smoke permits
the model to correct that error only if later successful pages still reconstruct
the file exactly. The Grep smoke puts its safe marker on the second match and a
forbidden marker in `.env`; it requires live pagination and verifies the
sensitive match never reaches the model. Both smokes check thinking, tool-call,
and text stream deltas and require the final answer to contain the safe marker.

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

Read paging was also compared at pinned commit `619564d`, specifically
`packages/agent-core-v2/src/agent/tools/os/read/`. Kimi bounds each call by lines
and bytes and continues with `line_offset`, but truncates an oversized single
line for model display. This project keeps the bounded-call principle and uses a
Runtime-issued byte cursor so even one oversized UTF-8 line can be continued
without silent content loss.

Grep was compared against the same pinned commit at
`packages/agent-core-v2/src/agent/tools/os/grep/`. Both implementations execute a
fixed ripgrep binary without a shell, apply workspace and sensitive-file policy,
bound output, and page by re-running the current search. Kimi exposes a raw
`offset` plus glob, type, context, multiline, and output-mode controls. This
project keeps only `pattern`, `path`, and a Runtime-signed cursor. It also treats
timeout as a whole-call error instead of returning Kimi-style partial results.

## Current security boundary

- Only the read-only `read` and `grep` tools are registered.
- Read accepts a relative path, canonicalizes it, and rejects paths or symlinks
  resolving outside the workspace.
- Read accepts regular UTF-8 files and returns at most 128 KiB per call. Larger
  files continue through `nextCursor`; stale cursors fail with `file_changed`.
- Grep executes the fixed `rg` program without a shell, accepts only relative
  workspace paths, does not follow escaping symlinks, and skips `.env` variants,
  common private-key names, cloud credential files, and VCS metadata. Safe
  example files such as `.env.example` remain searchable.
- File contents returned by Read or Grep are sent to the configured model
  provider as an Observation. The provider is therefore part of the data trust
  boundary. Grep filtering does not prevent an explicit Read of a sensitive
  workspace file under the current Read policy.
- Model reasoning may repeat sensitive material from the prompt or Observation.
  It is displayed in the TUI and retained in the current in-memory `RunResult`,
  but is not written to the workspace, Git, long-term Memory, or telemetry.
- Application-level path checks are not an OS sandbox and do not yet defend every
  concurrent filesystem race. Stronger sandboxing is a later milestone.
- Bash, Edit, MCP, plugins, long-term Session/Memory, multi-agent behavior, and a
  complex TUI are intentionally absent.

## Status

On 2026-08-31, the deterministic suite passed 75 tests across 12 test files. The
suite includes an in-process OpenAI-compatible HTTP server that returns 429 then
streams success, proving the retry is owned and surfaced by Core rather than
hidden inside the SDK. A second real HTTP trajectory proves that
`reasoning_content` is streamed into a generic `think` part and serialized back
beside the original ToolCall and Read Observation on the next request. Retrying
the second model request preserves the existing Observation and executes Read
only once. Tool Runtime contract tests lock same-registry disclosure, duplicate
registration rejection, paired unknown-tool and malformed-argument failures,
and sequential multi-call scheduling. A deterministic Ink TUI trajectory also
proves that Esc reaches the Core state machine, aborts the Provider signal, and
ends as `stopped: cancelled`. A separate in-flight Read test proves that its
completed Observation is retained while the next model request is suppressed.
Grep tests cover real ripgrep regex execution, bounded live pagination, signed
cursors, workspace and sensitive-file policy, long-line previews, timeout with
partial-result discard, and Runtime cancellation of the fixed ripgrep process.

The real-provider Read and Grep smokes passed with DeepSeek Thinking. Read
reconstructed two bounded pages; Grep followed two live result pages, found the
safe marker, and did not expose the `.env` marker. Both streamed reasoning,
tool-call arguments, and final text through 3 Provider attempts with 0 retries.
The compiled TUI also completed a real `package.json` Read,
retained `step 1 thinking › ...` in the visible trajectory, and displayed
`tool call read → observation success → final answer` before exiting normally.

This proves the current minimum chain runs; it does not yet prove the later
production-strength Provider, sandbox, Session, or recovery milestones.

## License

[MIT](LICENSE)
