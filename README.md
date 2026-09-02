# coding-agent

A build-to-learn Coding Agent project aiming for a runnable, explainable,
testable, production-grade v1.

## Current milestone: workspace ReAct loop, Bash, and exact Edit

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

Large workspace Read and Grep results stay inside this bounded paging contract.
Bash is the first tool whose complete output is stored externally, because
rerunning a side-effecting command merely to recover truncated output is unsafe.

This milestone trusts the workspace to be controlled by the current user. The
Runtime rejects lexical and resolved path escapes, and Read refuses to follow a
symlink in the final path component, but this is not an OS sandbox. It does not
claim to defend against another malicious process replacing parent directories
between the path check and the later Read or ripgrep open. Supporting hostile,
concurrently mutated workspaces requires descriptor-based path traversal and a
process sandbox in a later security milestone.

The local CLI also registers a foreground-only Bash tool. Every command is shown
with its exact workspace cwd and requires a fresh TUI approval before Runtime can
spawn it. The child receives a small environment allowlist rather than the Agent
process environment, so Provider credentials such as `DEEPSEEK_API_KEY` are not
inherited. Bash runs in its own POSIX process group with a fixed 120-second limit;
Esc or timeout stops the whole group with TERM followed by KILL. Background jobs
that remain in the managed process group are rejected and cleaned up; this is
still not an OS sandbox against a process that deliberately escapes that group.

stdout and stderr are captured separately as bounded 32,768-character previews
and streamed in full to private files under `~/.coding-agent/tool-output/` by
default. Runtime returns a separate unguessable capability ref for each stream.
The existing Read tool accepts exactly one of a workspace-relative `path` or a
Runtime `ref`; both reuse the same bounded UTF-8 paging semantics, but follow
separate authorization paths. The private store must remain outside the
workspace, is not exposed as an arbitrary readable directory, and defaults to
directory mode `0700` with log files created as `0600`.

Refs can reopen completed logs after an Agent restart. Read cursors remain
process-local integrity tokens, so after restart the model starts again from the
same ref without an old cursor. Log expiry and garbage collection are not yet
implemented; retained files currently require explicit local cleanup. Binary
output is preserved in the log, but the current text-only Read tool rejects a
ref whose requested page is not valid UTF-8.

Workspace-path Read Observations also include an opaque, process-local file
`version`. Edit accepts only `path`, `old_string`, `new_string`, and that exact
`expected_version`. Runtime rejects a stale version, a missing old string, or
more than one exact match before requesting approval. An ambiguous-match
Observation includes bounded line, column, and source previews so the model can
choose a more precise string instead of guessing. The first Edit deliberately
does not expose `replace_all`, arbitrary whole-file overwrite, or multi-file
patches.

For a valid proposal, Runtime computes the actual before/after diff and the TUI
requests a fresh approval for that path, version, and diff. After approval,
Runtime rechecks the same precondition, writes a complete temporary file in the
target directory, atomically renames it over the target, and reads it back before
returning success. A change made while approval is pending therefore returns
`stale_file` with zero Agent writes.

Core assigns every tool execution an internal `operationId` that is separate
from the Provider's `toolCallId`; the model cannot choose it. For Edit, Runtime
stores a private operation record under
`~/.coding-agent/state/edit-operations/` by default. The record is written as
`pending` before the workspace rename and as `applied` only after read-back.
The store must remain outside the workspace and uses directory mode `0700` and
atomic `0600` JSON record replacement.

After a restart, a redelivered pending operation compares the current file with
the recorded before and intended-after content hashes. Intended-after is
accepted as already applied without another write; unchanged before content
requires the same diff to be approved again; any third content becomes a
terminal `operation_conflict`. Replaying an applied operation returns its stored
success, while a rejected operation leaves a minimal `cancelled` tombstone.
Reusing one operation identity with different arguments is always rejected.
On explicit Session continuation, Core redelivers an unfinished Edit with this
same operation identity, so Runtime can reconcile the journal instead of blindly
applying the change again. The CLI never guesses which Session to resume.
Operation-record expiry and garbage collection are also not yet implemented.

The CLI now starts one private Session transcript under
`~/.coding-agent/sessions/` by default. Each Session uses an append-only
`transcript.jsonl`: Core records `turn_started`, one complete `tool_intent`, its
`tool_observation`, and the terminal Turn outcome in execution order. A Tool
Intent contains the Core-generated `operationId` and the complete successful
assistant response needed to replay DeepSeek reasoning while that Turn remains
unfinished. Failed stream fragments are displayed by the TUI but are never
committed. Final-answer reasoning is not written to the transcript or long-term
Memory.

While the interactive TUI stays open, a completed Turn returns to the input
prompt instead of exiting. Core gives every new input a new `turnId` and builds
its model Context from the completed conversation facts: prior user messages,
assistant ToolCalls, paired Observations, and final answers. Complete thinking is
removed from this later-Turn Context, while ToolCalls and Observations remain as
execution evidence. If a later Turn is interrupted, transcript folding rebuilds
those completed facts before the unfinished Turn so recovery does not lose the
earlier evidence.

Every JSONL record must end with a newline and be synced before it is considered
committed. On open, an incomplete tail is truncated to the last newline; invalid
JSON in an earlier committed record makes the Session fail closed. If
`turn_started` or `tool_intent` cannot be persisted, Core does not call the
Provider or Runtime respectively. If a tool has already returned but its
Observation cannot be persisted, the run ends as `session_persist_failed`
without pretending the side effect did not happen. A Turn is completed only
after its terminal record is durable.

Any Session append failure also marks that Core as requiring a Session reload.
Both `run` and `resume` then return `session_persist_failed` without calling the
Provider, executing tools, or appending more events. The TUI removes the task
input and shows recovery instructions. Fix the storage problem, exit, and reopen
the same workspace with `--session <id>`; if a Turn is unfinished, the CLI directs
you to `--continue <id>`. A fresh Core uses the existing lock-then-read path to
select the recovery position from disk. An append can report failure even after
the record was written, so the old Core never guesses that position or resets
its guard in place. Ordinary failures with a durable terminal record still allow
the next Turn.

One model response may contain either no ToolCall (a final answer) or exactly one
ToolCall. More than one is rejected with zero tool execution. A Turn can still
perform `Read → Edit → final` across separate model responses. This milestone
can now fold a transcript into `no_turn`, `awaiting_model`, `recovering_tool`,
or `finished`, and rebuild the latest unfinished Turn's paired model messages.
Mismatched Tool Intent and Observation identities fail closed. Core can resume
an unfinished state only when it is attached to the same Session writer. For
`awaiting_model`, it sends the rebuilt messages to the Provider without replaying
an observed tool. For `recovering_tool`, Read and Grep run again, Edit is
redelivered with its original operation identity to the durable Edit journal,
and Bash or any unclassified tool is never re-executed: Core records a
`recovery_unknown_outcome` Observation instead. Recovery then continues the
same loop and durably appends its terminal result. The CLI can explicitly open
the exact unfinished Session named by `--continue`. With `--session`, a fresh
process instead opens an existing Session that has no unfinished Turn, restores
its completed Context into an idle Core, and waits for new input. Opening it
does not call the Provider, replay an old tool, or append a Turn. An unfinished
Session is rejected with a `--continue` hint. The CLI does not automatically
select a recent Session, compact history, list Sessions, or garbage-collect data.

Every new, resumed, or reopened CLI holds one exclusive `.run.lock` in that
Session's private directory until the TUI exits, including while awaiting input.
A competing `--continue` or `--session` fails immediately with `session_busy`,
before Provider or Runtime
initialization. The winner acquires the lock and only then loads and folds the
Transcript, so it cannot continue from a pre-lock snapshot. Normal exit releases
the lock; a killed process leaves a heartbeat-based lock that becomes stale after
5 seconds and can then be acquired by a fresh process. This is cooperative
single-writer coordination, not protection against a hostile process deleting
private state.

Core also owns the lifecycle of one active run:

```text
idle → requesting_model → executing_tool → requesting_model → settled
                  └──────── Esc/cancel ────────→ cancelling → settled
```

The TUI only turns Esc into a cancellation request. Core changes the run state
and aborts the same signal used by the Provider request, retry wait, and Runtime.
If Read has already started, it ignores the signal, may finish, and retains its
real Observation before Core stops. Grep consumes the signal and terminates its
fixed ripgrep process before returning a cancelled Observation. Bash consumes
the same signal, terminates its complete POSIX process group, preserves bounded
stdout/stderr evidence, and reports that side effects may have an unknown outcome.

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
answer. Successful reasoning attached to an unfinished Tool Intent is persisted
as private replay state; failed deltas and completed final-answer reasoning are
not. Replay state does not automatically enter future completed-Turn Context or
long-term Memory/RAG.

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

To continue one known unfinished Session, use the same workspace and its exact
Session ID:

```bash
node --env-file=.env dist/cli.js \
  --workspace /absolute/path/to/workspace \
  --continue <session-id>
```

To reopen a completed conversation and type a new task, use:

```bash
node --env-file=.env dist/cli.js \
  --workspace /absolute/path/to/workspace \
  --session <session-id>
```

`--session` also accepts an existing empty Session. It refuses to skip an
unfinished Turn and tells you to use `--continue` instead. Add `--prompt <text>`
to explicitly submit one new task immediately and exit afterward; without it,
the TUI waits for your input before making any Provider request.

Without `--session`, a new task creates a new Session. `--continue` cannot be
combined with either `--session` or `--prompt`. Both Session flags open only an
existing Session; an unknown ID is not created. `--continue` refuses an empty
or already finished Session without contacting the Provider.
Set `CODING_AGENT_SESSION_ROOT` when
the private Session store should live somewhere other than
`~/.coding-agent/sessions/`.

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
= workspace version when applicable + content + page byte count/line metadata
  + complete + optional nextCursor

Grep page output
= pattern + path + bounded matches(path/line/text) + complete + optional nextCursor

Bash output
= command + cwd + exitCode/signal + bounded stdout/stderr + separate
  stdoutRef/stderrRef + process outcome

Edit output
= path + one replacement + before/after versions + approved diff + read-back proof

Edit operation record
= Core operationId + request fingerprint + pending/applied/conflict/cancelled
  Runtime state outside the workspace

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
response contains multiple tool calls, Core rejects the complete response and
executes none of them. Separate responses can still produce a sequential tool
trajectory. The current run's messages form an in-memory trajectory returned in
`RunResult`, while the private Session transcript records the durable execution
facts needed by the later resume milestone.

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
- dangerous-tool approval failing closed, exact command/cwd display, explicit
  approval and rejection, and Esc cancellation with zero execution before approval;
- real foreground Bash execution with fixed cwd, Provider-secret isolation,
  separate stdout/stderr, non-zero and command-not-found exits, bounded output,
  timeout/cancellation process-group termination, and background-job cleanup;
- complete Bash stdout/stderr streaming to separate private logs, capability-ref
  Read paging, exact reconstruction after truncation and restart, forged/cross-ref
  rejection, and timeout/cancellation evidence recovery;
- exact Edit schema, Read-issued file versions, fresh diff approval, rejection
  with zero writes, stale-version rejection before and after approval, explicit
  ambiguous-match locations, workspace escapes, atomic replacement, mode
  preservation, post-write Read verification, and Core Read → Edit → final flow;
- Edit operation identity, private-store failure with zero writes, applied
  replay without another approval or rename, both restart crash windows,
  recovery re-approval, conflict detection, cancelled tombstones, and
  same-ID/different-arguments rejection;
- multiple tool calls in one model response being rejected with zero execution;
- private Session JSONL ordering, `0600` files, incomplete-tail truncation,
  committed-record corruption failure, and workspace/private-store separation;
- Tool Intent durability before Runtime, Observation durability after Runtime,
  final-outcome durability, and injected persistence failures on both sides of
  an applied Edit;
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
node --env-file=.env --import tsx scripts/real-bash-smoke.ts
node --env-file=.env --import tsx scripts/real-edit-smoke.ts
```

The Read smoke creates a temporary workspace whose marker exists only on the
second page. It requires the real model to follow `nextCursor` and verifies exact
file reconstruction. A model-edited cursor must be rejected; the smoke permits
the model to correct that error only if later successful pages still reconstruct
the file exactly. The Grep smoke puts its safe marker on the second match and a
forbidden marker in `.env`; it requires live pagination and verifies the
sensitive match never reaches the model. Both smokes check thinking, tool-call,
and text stream deltas and require the final answer to contain the safe marker.
The Bash smoke allows exactly one predeclared, side-effect-free command in a
temporary workspace. It requires the real model to observe truncation, page the
private `stdoutRef` without rerunning Bash, reconstruct 33,076 bytes exactly,
recover a marker absent from the preview, and confirm the Provider credential
was not inherited by the child process.
The Edit smoke creates a temporary file whose markers are unique to that run. It
requires the real model to Read first, pass the exact returned version into one
Edit, receive approval for the Runtime-generated diff, and use the successful
Observation in its final answer. The oracle independently verifies the exact
disk content and a fresh Read of the returned after-version.

## Design reference

The Provider work was checked against Kimi Code at pinned commit
[`56b5480`](https://github.com/MoonshotAI/kimi-code/tree/56b5480ed0da2274f062cd9a38a281187cbe8c36).
This project adopts provider-neutral deltas, the no-partial-execution gate, and
50 ms TUI coalescing. It also adopts typed retryability, per-step retry budgets,
exponential backoff with jitter, `Retry-After`, and cancellation-aware waiting.

There are deliberate simplifications and deviations. Kimi's Core defaults to
10 attempts and its OpenAI client retains SDK retries; this milestone uses 3
Core-visible attempts and disables SDK retries so its attempt count is directly
explainable and testable. This project resumes only an explicitly selected
unfinished Session. It re-executes recoverable read-only tools, reconciles Edit
through its durable journal, and writes a synthetic
`recovery_unknown_outcome` Observation instead of re-executing Bash.

The cross-process Session critical section was checked against Kimi Code's
[`OAuthManager`](https://github.com/MoonshotAI/kimi-code/blob/619564dcf9ee10a3cfbf7ecbc764c6b9b63fc91b/packages/oauth/src/oauth-manager.ts#L163-L220)
at the same pinned commit. Both use `proper-lockfile`, fail closed when locking
cannot be established, and re-read durable state after acquisition. Kimi's OAuth
refresh waits and retries because callers want one refreshed credential; this
interactive Session boundary deliberately uses zero retries so a second terminal
gets an immediate `session_busy` result instead of silently running later.

The Thinking round-trip was separately checked against Kimi Code at pinned
commit
[`619564d`](https://github.com/MoonshotAI/kimi-code/tree/619564dcf9ee10a3cfbf7ecbc764c6b9b63fc91b).
This project adopts its provider-neutral `think` content, separate thinking
stream, and Adapter-owned conversion back to DeepSeek's reasoning field.
Kimi persists a complete per-Agent Wire event stream for Session replay. This
project now adopts the smaller append-only fact-log principle, but keeps only one
Session transcript, one ToolCall per response, and no Session index, metadata
snapshot, multi-Agent layout, automatic latest-Session selection, or Context
read model. Complete
reasoning is durable only as private recovery payload for an unfinished Tool
Intent and is excluded from completed final-answer records.

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

Bash output handling follows Kimi's bounded-model-result principle at pinned
commit `619564d`: complete oversized tool output is stored outside model context
and later read in bounded pages. This project does not expose Kimi-style private
filesystem paths to the model; Runtime returns an unguessable single-file ref
and authorizes it separately from workspace paths.

Edit was compared at pinned commit `619564d` against
[`packages/agent-core/src/tools/builtin/file/edit.ts`](https://github.com/MoonshotAI/kimi-code/blob/619564dcf9ee10a3cfbf7ecbc764c6b9b63fc91b/packages/agent-core/src/tools/builtin/file/edit.ts).
Both tools use exact string replacement, reject no-op or missing matches, require
unique selection by default, and put writes behind approval. Kimi also exposes
an explicit `replace_all`; this milestone omits it and adds a Read-issued version
precondition, same-directory atomic replacement, and post-write verification.

Kimi's v2
[`toolDedupe`](https://github.com/MoonshotAI/kimi-code/blob/619564dcf9ee10a3cfbf7ecbc764c6b9b63fc91b/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts)
is per-turn loop protection: same-step duplicates share one result, while
cross-step repeats receive reminders. Its state is not the durable Edit outcome
journal needed for a process crash. This project therefore keeps a small
Runtime-owned Edit record and a separate minimal Session transcript instead of
importing Kimi's complete Session/Wire stack.

## Current security boundary

- The local CLI registers `read`, `grep`, foreground-only `bash`, and exact
  `edit`. Every Bash call requires a fresh approval after Runtime validates its
  arguments and the TUI displays the exact command and canonical workspace cwd.
- Every new Edit execution requires a fresh approval for a Runtime-generated
  path/version/diff. Replaying an already applied identity returns its stored
  result without another write. Runtime revalidates the file version after
  approval and never automatically retries a stale or unverified edit. Edit
  operation records remain private and cannot be addressed through the
  model-visible Read tool.
- Read accepts exactly one workspace-relative path or Runtime output ref. Paths
  are canonicalized and paths or symlinks resolving outside the workspace are
  rejected. Refs grant access to one private output file and cannot be used to
  enumerate or open arbitrary paths in the private store.
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
  It is displayed in the TUI and retained in the current in-memory `RunResult`.
  Successful reasoning needed to resume an unfinished Tool Intent is also stored
  in the private `0600` Session transcript, but it is not written to the
  workspace, Git, long-term Memory, or telemetry.
- Application-level path checks are not an OS sandbox and do not yet defend every
  concurrent filesystem race. Stronger sandboxing is a later milestone.
- Bash receives a small environment allowlist, runs in a separate POSIX process
  group with timeout/cancellation cleanup, and rejects managed background
  leftovers. It may still access files, processes, or networks available to the
  current user and may leave side effects before timeout or cancellation; this
  is not an OS sandbox and an unknown outcome is never automatically retried.
- Arbitrary overwrite, multi-file Edit, MCP, plugins, long-term Memory,
  multi-agent behavior, background task management, and a complex TUI are
  intentionally absent.

## Status

On 2026-09-02, the deterministic suite passed 160 tests across 19 test files. The
suite includes an in-process OpenAI-compatible HTTP server that returns 429 then
streams success, proving the retry is owned and surfaced by Core rather than
hidden inside the SDK. A second real HTTP trajectory proves that
`reasoning_content` is streamed into a generic `think` part and serialized back
beside the original ToolCall and Read Observation on the next request. Retrying
the second model request preserves the existing Observation and executes Read
only once. Tool Runtime contract tests lock same-registry disclosure, duplicate
registration rejection, paired unknown-tool and malformed-argument failures,
and one-ToolCall-per-response enforcement. Session tests lock JSONL commit and
tail-repair rules, Core write-ahead ordering, final outcome durability, and the
two persistence-failure sides of a real Edit. Admission regressions inject errors
before and after each of the four Session append boundaries: the old Core stays
blocked, existing records are unchanged, and a freshly reopened Session can
continue from its actual durable state. Ink tests also prove terminal-save
failure removes interactive input and cannot create overlapping Turns.
A deterministic Ink TUI trajectory also
proves that Esc reaches the Core state machine, aborts the Provider signal, and
ends as `stopped: cancelled`. A separate in-flight Read test proves that its
completed Observation is retained while the next model request is suppressed.
Grep tests cover real ripgrep regex execution, bounded live pagination, signed
cursors, workspace and sensitive-file policy, long-line previews, timeout with
partial-result discard, and Runtime cancellation of the fixed ripgrep process.
Bash tests cover the approval gate, fixed cwd and environment, process-group
termination, unknown outcomes, complete private stdout/stderr persistence,
ref-based Read paging, restart reopening, and capability/path/cursor rejection.
Edit tests cover version-bound approval, explicit ambiguous-match evidence,
stale changes during approval, atomic replacement, permission preservation,
post-write verification, TUI diff display, the complete Core loop, stable
operation identities, restart reconciliation, duplicate delivery, cancelled
tombstones, and conflict fail-closed behavior.

Multi-Turn tests run two real TUI inputs through one private Session and prove
that the second model request receives the first Turn's user message, ToolCall,
Read Observation, and final answer without completed thinking. A separate fold
test interrupts the second Turn and rebuilds the same completed evidence from
the transcript before recovery.

A compiled-CLI recovery smoke opens an explicitly selected unfinished Session
in a fresh Node process while a second compiled CLI competes for the same ID.
The winner rebuilds the durable Read Observation, sends exactly one Provider
request, and persists the returned final answer; the loser exits with
`session_busy` and sends zero Provider requests. Store and TUI tests also prove
that opening an unknown Session does not create it and that an observed tool is
not executed again during resume. A separate real child-process test kills the
lock holder with `SIGKILL`, observes the lease remain busy until its 5-second
stale boundary, and then acquires it from a new process.

The same compiled-CLI smoke then starts another fresh process with
`--session <id> --prompt <text>`. It verifies that completed ToolCalls,
Observations, and final answers reach the Provider without old reasoning, and
exactly one new Turn is appended without changing previous records. Reopening a
busy Session or either unfinished position is rejected with zero extra Provider
requests; a pending Edit does not change its file. Conflicting Session flags are
also rejected. Core and Ink tests separately verify that opening history remains
idle and makes zero Provider calls until the user submits new input.

Run these deterministic fresh-process checks with `npm run smoke:session-resume`.
They use a local OpenAI-compatible SSE server, not a paid model request.

Run `npm run smoke:session-tools` for the missing-Observation crash window.
Four compiled CLI processes execute real Read, Grep, Edit, and Bash tools. A
test-only Node preload isolates all private stores in temporary directories,
approves only fixed test operations, and pauses after Runtime returns but before
Core receives the result. The smoke confirms the durable transcript still ends
at Tool Intent, kills each process with `SIGKILL`, waits for the real lease to
expire, and starts four new compiled `--continue` processes. No recovery policy
or transcript event is mocked; the initial approvals are fixtures, not keyboard
interaction tests.

- Read/Grep see a marker changed after the old process died, proving a fresh read.
- Applied Edit returns the original success with the same operation identity,
  no available approval handler, and unchanged file content, inode, mtime, and
  durable operation record.
- Bash has already appended one line before the crash. Recovery never calls
  Runtime for Bash, keeps exactly that one line, and sends the model a
  non-retryable `recovery_unknown_outcome` Observation.
- Every case preserves the transcript prefix and original Turn ID, appends one
  paired Observation and one terminal event, and delivers that exact Observation
  to the local SSE Provider before durably completing.

This is a repeatable process-death test at the post-tool/pre-Observation window,
not a DeepSeek request or proof of power-loss durability at every Edit write.

The real-provider Read, Grep, Bash, and Edit smokes passed with DeepSeek Thinking. Read
reconstructed two bounded pages; Grep followed two live result pages, found the
safe marker, and did not expose the `.env` marker. Both streamed reasoning,
tool-call arguments, and final text through 3 Provider attempts with 0 retries.
The Bash smoke completed in 4 steps and 4 Provider attempts with 0 retries:
DeepSeek proposed the single approved command, received a truncated preview,
used `Read(stdoutRef)` for two pages, reconstructed the complete output, and
returned the hidden marker plus `ProviderSecret: absent` without rerunning Bash.
This real run also caught that DeepSeek rejected a top-level `anyOf` Read schema
with HTTP 400. The model-visible contract now uses a compatible flat object,
while Runtime's Zod validation still enforces exactly one of `path` or `ref`.
The Edit smoke completed `read → edit → final` in 3 steps and 3 Provider attempts
with 0 retries. Runtime approved the exact diff, the old marker disappeared, a
fresh disk Read matched the returned after-version, and the final answer included
the new marker.
The compiled TUI also completed a real `package.json` Read,
retained `step 1 thinking › ...` in the visible trajectory, and displayed
`tool call read → observation success → final answer` before exiting normally.

This proves the current minimum chain, deterministic Edit side-effect recovery,
durable Session write-ahead ordering, and explicit same-Turn continuation from a
fresh CLI process with one active writer. It also proves later-Turn Context while
the same interactive TUI remains open and after folding an interrupted second
Turn, plus explicit reopening of a finished Session from a fresh process and
four-tool recovery after `SIGKILL` before Observation persistence. It does not yet
prove automatic latest-Session selection, power-loss durability at every write
boundary, hostile-process resistance for the cooperative lock, a
hostile-workspace sandbox, or the later complete production milestone.

## License

[MIT](LICENSE)
