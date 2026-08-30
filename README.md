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

The first milestone deliberately disables DeepSeek thinking mode. DeepSeek V4
enables thinking by default, but tool-calling conversations must then preserve
and replay provider-specific `reasoning_content`. That state belongs to the next
Provider milestone; silently dropping it would break the second model request.

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

Observation
= Runtime evidence: matching toolCallId + success/output or error/code

RunResult
= Core terminal result: final_answer, stopped(max_steps), or failed
```

Expected tool failures such as invalid arguments, missing files, and permission
denials are returned to the model as error Observations. Provider or Core failures
terminate the run instead.

## Streaming boundary

Provider stream fragments are drafts, not executable tool calls. The Adapter
normalizes text and tool-call deltas for the TUI, assembles tool arguments, and
only returns a `ToolCall` after the provider cleanly finishes with
`finish_reason: "tool_calls"`. If the stream disconnects, ends without a finish
reason, or finishes because of truncation, Core returns a Provider failure and
Tool Runtime is not called.

The TUI coalesces draft updates every 50 ms and keeps a bounded preview, while
the Adapter preserves the complete response used by Core. This keeps rendering
responsive without weakening the execution gate.

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
- streamed text and fragmented tool arguments being assembled correctly;
- interrupted or truncated streams producing a Provider failure with zero tool
  executions;
- TUI draft frames for streamed text and tool arguments;
- a clean TypeScript build and executable CLI entry point.

The real-provider smoke is separate because it spends provider quota and requires
credentials:

```bash
node --env-file=.env --import tsx scripts/real-smoke.ts
```

It creates a temporary workspace, requires the real model to call Read, verifies
the matching Observation, checks that both tool-call and text stream deltas were
received, and checks that the final answer contains a marker read from the file.

## Design reference

The streaming split was checked against Kimi Code at pinned commit
[`56b5480`](https://github.com/MoonshotAI/kimi-code/tree/56b5480ed0da2274f062cd9a38a281187cbe8c36).
This project adopts provider-neutral deltas, the no-partial-execution gate, and
50 ms TUI coalescing. It deliberately does not yet persist interrupted turns or
write a synthetic unexecuted tool result; those belong to the later Session and
recovery milestones.

## Current security boundary

- Only the `read` tool is registered.
- Read accepts a relative path, canonicalizes it, and rejects paths or symlinks
  resolving outside the workspace.
- Read accepts regular UTF-8 files up to 128 KiB for this milestone.
- File contents returned by Read are sent to the configured model provider as an
  Observation. The provider is therefore part of the data trust boundary.
- Application-level path checks are not an OS sandbox and do not yet defend every
  concurrent filesystem race. Stronger sandboxing is a later milestone.
- Bash, Edit, MCP, plugins, long-term Session/Memory, multi-agent behavior, and a
  complex TUI are intentionally absent.

## Status

On 2026-08-30, the deterministic suite passed 20 tests across 6 test files. The
real-provider smoke passed with DeepSeek in two model rounds: streamed tool-call
arguments were assembled into Read, Runtime returned a successful matching
Observation, and streamed final text contained the file's private marker. The
compiled TUI also completed the real README task, displayed bounded streaming
drafts plus `tool call read → observation success → final answer`, and exited
normally.

This proves the current minimum chain runs; it does not yet prove the later
production-strength Provider, sandbox, Session, or recovery milestones.

## License

[MIT](LICENSE)
