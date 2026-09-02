import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import type {
  Observation,
  ToolApprovalRequest,
  ToolCall,
} from "../../src/core/contracts.js";

export interface RecoveryFixture {
  readonly tool: "read" | "grep" | "edit" | "bash";
  readonly phase: "crash" | "resume";
  readonly root: string;
  readonly workspace: string;
}

export type RecoveryProbe =
  | { readonly type: "approval"; readonly request: ToolApprovalRequest }
  | {
      readonly type: "execute";
      readonly call: ToolCall;
      readonly operationId: string;
    }
  | {
      readonly type: "checkpoint";
      readonly call: ToolCall;
      readonly operationId: string;
      readonly observation: Observation;
    };

// Loaded ONLY by the smoke's Node --import flag. No production test switch,
// fake Core, transcript injection, or recovery-policy replacement is involved.
assert(process.send, "The recovery fixture requires the smoke's IPC channel.");
assert(process.env.CODING_AGENT_RECOVERY_FIXTURE);
const fixture = JSON.parse(
  process.env.CODING_AGENT_RECOVERY_FIXTURE,
) as RecoveryFixture;
const workspace = await realpath(fixture.workspace);

// Import the same compiled class as dist/cli.js. A dynamic URL keeps typecheck
// independent of a pre-existing dist directory; the source import is type-only.
const { ToolRuntime } = await import(
  new URL("../../dist/runtime/tool-runtime.js", import.meta.url).href
) as typeof import("../../src/runtime/tool-runtime.js");
const createRuntime = ToolRuntime.withEdit.bind(ToolRuntime);
ToolRuntime.withEdit = async (options) => {
  // Only isolate private storage. Do not change HOME or touch real user data.
  const runtime = await createRuntime({
    ...options,
    toolOutputRoot: join(fixture.root, "tool-output"),
    editOperationRoot: join(fixture.root, "edit-operations"),
  });
  const execute = runtime.execute.bind(runtime);
  runtime.execute = async (call, options = {}) => {
    assert(options.operationId);
    await report({ type: "execute", call, operationId: options.operationId });
    const observation = await execute(call, {
      ...options,
      // Only the first process gets a fixed-fixture approval handler. Resume
      // has the normal non-interactive CLI behavior: no approval available.
      ...(fixture.phase === "crash" ? {
        requestApproval: async (request: ToolApprovalRequest) => {
          await report({ type: "approval", request });
          if (request.kind === "command") {
            assert.equal(fixture.tool, "bash");
            assert.equal(request.cwd, workspace);
            assert.equal(request.command, "printf 'BASH_ONCE\\n' >> bash-runs.txt");
          } else {
            assert.equal(fixture.tool, "edit");
            assert.equal(request.path, "config.ts");
            const args = JSON.parse(call.rawArguments);
            assert.equal(args.path, "config.ts");
            assert.equal(args.old_string, "EDIT_BEFORE");
            assert.equal(args.new_string, "EDIT_AFTER");
            assert.equal(args.expected_version, request.beforeVersion);
            assert.equal(request.diff, "--- a/config.ts\n+++ b/config.ts\n@@ line 1 @@\n-EDIT_BEFORE\n+EDIT_AFTER");
          }
          return "approved" as const;
        },
      } : {}),
    });
    if (fixture.phase === "crash" && call.name === fixture.tool) {
      await report({
        type: "checkpoint", call, operationId: options.operationId, observation,
      });
      // The REAL tool has returned, but Core has not received its Observation.
      // Keep the process and lease alive until the parent sends SIGKILL.
      await new Promise<never>(() => { setInterval(() => undefined, 1_000); });
    }
    return observation;
  };
  return runtime;
};

async function report(probe: RecoveryProbe): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send!(probe, (error) => error ? reject(error) : resolve());
  });
}
