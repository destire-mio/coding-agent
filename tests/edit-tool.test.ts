import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Observation,
  ToolApprovalRequest,
  ToolCall,
} from "../src/core/contracts.js";
import {
  EditOperationStore,
  EditOperationStoreConfigurationError,
  type PendingEditOperationRecord,
} from "../src/runtime/edit-operation-store.js";
import type { EditResult } from "../src/runtime/edit-tool.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const temporaryRoots: string[] = [];
const DEFAULT_EDIT_OPERATION_ID = "operation-edit-default";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("EditTool", () => {
  it("refuses to place private Edit operation state inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-agent-edit-boundary-"));
    temporaryRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(
      ToolRuntime.withEdit({
        workspaceRoot: workspace,
        toolOutputRoot: join(root, "tool-output"),
        editOperationRoot: join(workspace, ".private-edit-state"),
      }),
    ).rejects.toThrow(EditOperationStoreConfigurationError);
  });

  it("publishes one exact replacement contract without replace_all", async () => {
    const harness = await createHarness();
    const definition = harness.runtime
      .definitions()
      .find((candidate) => candidate.name === "edit");

    expect(definition).toMatchObject({
      name: "edit",
      inputSchema: {
        type: "object",
        required: ["path", "old_string", "new_string", "expected_version"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(definition?.inputSchema)).not.toContain("replace_all");
  });

  it("shows the Runtime-generated diff, atomically replaces one match, and reads it back", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "const timeoutMs = 120000;\n", {
      encoding: "utf8",
      mode: 0o744,
    });
    const version = await readVersion(harness.runtime, "config.ts");
    const approvals: ToolApprovalRequest[] = [];

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "const timeoutMs = 120000;",
        newString: "const timeoutMs = 180000;",
        expectedVersion: version,
      }),
      {
        operationId: DEFAULT_EDIT_OPERATION_ID,
        requestApproval: async (request) => {
          approvals.push(request);
          return "approved";
        },
      },
    );

    expect(approvals).toEqual([
      {
        toolCallId: "call-edit",
        toolName: "edit",
        kind: "file_edit",
        path: "config.ts",
        beforeVersion: version,
        diff: [
          "--- a/config.ts",
          "+++ b/config.ts",
          "@@ line 1 @@",
          "-const timeoutMs = 120000;",
          "+const timeoutMs = 180000;",
        ].join("\n"),
      },
    ]);
    const result = successResult(observation);
    expect(result).toMatchObject({
      path: "config.ts",
      replacements: 1,
      beforeVersion: version,
      afterVersion: expect.stringMatching(/^file-version-v1:/),
      verified: true,
    });
    expect(result.afterVersion).not.toBe(version);
    await expect(readFile(path, "utf8")).resolves.toBe(
      "const timeoutMs = 180000;\n",
    );
    expect((await stat(path)).mode & 0o777).toBe(0o744);
    expect(
      (await readdir(harness.workspace)).filter((name) =>
        name.includes(".coding-agent-")
      ),
    ).toEqual([]);
    await expect(readVersion(harness.runtime, "config.ts")).resolves.toBe(
      result.afterVersion,
    );
  });

  it("fails closed without approval and preserves the original file", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "timeout=120",
        newString: "timeout=180",
        expectedVersion: version,
      }),
      { operationId: DEFAULT_EDIT_OPERATION_ID },
    );

    expectError(observation, "approval_required");
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=120\n");
  });

  it("returns approval_rejected with zero writes", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "timeout=120",
        newString: "timeout=180",
        expectedVersion: version,
      }),
      {
        operationId: DEFAULT_EDIT_OPERATION_ID,
        requestApproval: async () => "rejected",
      },
    );

    expectError(observation, "approval_rejected");
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=120\n");
  });

  it("requires Core to provide a stable operation identity", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    let approvalCount = 0;

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "timeout=120",
        newString: "timeout=180",
        expectedVersion: version,
      }),
      {
        requestApproval: async () => {
          approvalCount += 1;
          return "approved";
        },
      },
    );

    expectError(observation, "missing_operation_id");
    expect(approvalCount).toBe(0);
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=120\n");
  });

  it("does not write when the private operation store disappears after approval", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "timeout=120",
        newString: "timeout=180",
        expectedVersion: version,
      }),
      {
        operationId: "operation-checkpoint-failure",
        requestApproval: async () => {
          await rm(harness.editOperationRoot, {
            recursive: true,
            force: true,
          });
          await writeFile(harness.editOperationRoot, "blocked", "utf8");
          return "approved";
        },
      },
    );

    expectError(observation, "operation_store_failed");
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=120\n");
  });

  it("returns the stored success for a duplicate applied operation without writing again", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    const call = editCall({
      path: "config.ts",
      oldString: "timeout=120",
      newString: "timeout=180",
      expectedVersion: version,
    });
    const operationId = "operation-applied-replay";

    const first = await harness.runtime.execute(call, {
      operationId,
      requestApproval: async () => "approved",
    });
    const firstResult = successResult(first);
    const inodeAfterFirst = (await stat(path, { bigint: true })).ino;
    const restarted = await restartRuntime(harness);
    let replayApprovalCount = 0;

    const replay = await restarted.execute(call, {
      operationId,
      requestApproval: async () => {
        replayApprovalCount += 1;
        return "approved";
      },
    });

    expect(successResult(replay)).toEqual(firstResult);
    expect(replayApprovalCount).toBe(0);
    expect((await stat(path, { bigint: true })).ino).toBe(inodeAfterFirst);
  });

  it("recovers pending as applied when the file already has the intended content", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    const call = editCall({
      path: "config.ts",
      oldString: "timeout=120",
      newString: "timeout=180",
      expectedVersion: version,
    });
    const operationId = "operation-crash-after-rename";
    successResult(
      await harness.runtime.execute(call, {
        operationId,
        requestApproval: async () => "approved",
      }),
    );
    await forcePending(harness, operationId);
    const inodeBeforeRecovery = (await stat(path, { bigint: true })).ino;
    const restarted = await restartRuntime(harness);
    let approvalCount = 0;

    const recovered = await restarted.execute(call, {
      operationId,
      requestApproval: async () => {
        approvalCount += 1;
        return "approved";
      },
    });

    expect(successResult(recovered)).toMatchObject({ path: "config.ts" });
    expect(approvalCount).toBe(0);
    expect((await stat(path, { bigint: true })).ino).toBe(inodeBeforeRecovery);
    await expect(operationState(harness, operationId)).resolves.toBe("applied");
  });

  it("re-asks approval and applies when pending still has the before content", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    const call = editCall({
      path: "config.ts",
      oldString: "timeout=120",
      newString: "timeout=180",
      expectedVersion: version,
    });
    const operationId = "operation-crash-before-rename";
    successResult(
      await harness.runtime.execute(call, {
        operationId,
        requestApproval: async () => "approved",
      }),
    );
    await forcePending(harness, operationId);
    await writeFile(path, "timeout=120\n", "utf8");
    const restarted = await restartRuntime(harness);
    const approvals: ToolApprovalRequest[] = [];

    const recovered = await restarted.execute(call, {
      operationId,
      requestApproval: async (request) => {
        approvals.push(request);
        return "approved";
      },
    });

    expect(successResult(recovered)).toMatchObject({ path: "config.ts" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "file_edit",
      path: "config.ts",
      diff: expect.stringContaining("+timeout=180"),
    });
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=180\n");
    await expect(operationState(harness, operationId)).resolves.toBe("applied");
  });

  it("returns operation_conflict when pending content is neither before nor after", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    const call = editCall({
      path: "config.ts",
      oldString: "timeout=120",
      newString: "timeout=180",
      expectedVersion: version,
    });
    const operationId = "operation-recovery-conflict";
    successResult(
      await harness.runtime.execute(call, {
        operationId,
        requestApproval: async () => "approved",
      }),
    );
    await forcePending(harness, operationId);
    await writeFile(path, "timeout=external-change\n", "utf8");
    const restarted = await restartRuntime(harness);
    let approvalCount = 0;

    const recovered = await restarted.execute(call, {
      operationId,
      requestApproval: async () => {
        approvalCount += 1;
        return "approved";
      },
    });

    expectError(recovered, "operation_conflict");
    expect(approvalCount).toBe(0);
    await expect(readFile(path, "utf8")).resolves.toBe(
      "timeout=external-change\n",
    );
    await expect(operationState(harness, operationId)).resolves.toBe("conflict");
  });

  it("keeps a minimal cancelled tombstone and refuses the same operation after restart", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    const call = editCall({
      path: "config.ts",
      oldString: "timeout=120",
      newString: "timeout=180",
      expectedVersion: version,
    });
    const operationId = "operation-cancelled-replay";

    const rejected = await harness.runtime.execute(call, {
      operationId,
      requestApproval: async () => "rejected",
    });
    expectError(rejected, "approval_rejected");
    const store = await EditOperationStore.create({
      root: harness.editOperationRoot,
    });
    const cancelled = await store.read(operationId);
    expect(cancelled).toMatchObject({ state: "cancelled", operationId });
    expect(JSON.stringify(cancelled)).not.toContain("timeout=120");
    expect(JSON.stringify(cancelled)).not.toContain("timeout=180");

    const restarted = await restartRuntime(harness);
    let approvalCount = 0;
    const replay = await restarted.execute(call, {
      operationId,
      requestApproval: async () => {
        approvalCount += 1;
        return "approved";
      },
    });

    expectError(replay, "operation_cancelled");
    expect(approvalCount).toBe(0);
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=120\n");
  });

  it("rejects different arguments that reuse an applied operation identity", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    const operationId = "operation-argument-conflict";
    successResult(
      await harness.runtime.execute(
        editCall({
          path: "config.ts",
          oldString: "timeout=120",
          newString: "timeout=180",
          expectedVersion: version,
        }),
        { operationId, requestApproval: async () => "approved" },
      ),
    );
    const restarted = await restartRuntime(harness);
    let approvalCount = 0;

    const replay = await restarted.execute(
      editCall({
        path: "config.ts",
        oldString: "timeout=120",
        newString: "timeout=240",
        expectedVersion: version,
      }),
      {
        operationId,
        requestApproval: async () => {
          approvalCount += 1;
          return "approved";
        },
      },
    );

    expectError(replay, "operation_conflict");
    expect(approvalCount).toBe(0);
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=180\n");
  });

  it("invalidates approval when the file changes while the user is deciding", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\nmode=prod\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    let approvalCount = 0;

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "timeout=120",
        newString: "timeout=180",
        expectedVersion: version,
      }),
      {
        operationId: DEFAULT_EDIT_OPERATION_ID,
        requestApproval: async () => {
          approvalCount += 1;
          await writeFile(path, "timeout=120\nmode=debug\n", "utf8");
          return "approved";
        },
      },
    );

    expect(approvalCount).toBe(1);
    expectError(observation, "stale_file");
    await expect(readFile(path, "utf8")).resolves.toBe(
      "timeout=120\nmode=debug\n",
    );
  });

  it("returns explicit locations and bounded content when old_string is ambiguous", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(
      path,
      "const timeoutMs = 120000;\n// default timeoutMs = 120000\n",
      "utf8",
    );
    const version = await readVersion(harness.runtime, "config.ts");
    let approvalCount = 0;

    const observation = await harness.runtime.execute(
      editCall({
        path: "config.ts",
        oldString: "timeoutMs = 120000",
        newString: "timeoutMs = 180000",
        expectedVersion: version,
      }),
      {
        operationId: DEFAULT_EDIT_OPERATION_ID,
        requestApproval: async () => {
          approvalCount += 1;
          return "approved";
        },
      },
    );

    expect(approvalCount).toBe(0);
    expectError(observation, "ambiguous_match");
    if (observation.status === "error") {
      expect(observation.error.details).toEqual({
        path: "config.ts",
        matchCount: 2,
        matches: [
          {
            line: 1,
            column: 7,
            preview: "const timeoutMs = 120000;",
            previewTruncated: false,
          },
          {
            line: 2,
            column: 12,
            preview: "// default timeoutMs = 120000",
            previewTruncated: false,
          },
        ],
        matchesTruncated: false,
      });
    }
    await expect(readFile(path, "utf8")).resolves.toContain("120000");
  });

  it("rejects missing text, no-op edits, and workspace escapes before approval", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "timeout=120\n", "utf8");
    const version = await readVersion(harness.runtime, "config.ts");
    let approvalCount = 0;
    const approval = async (): Promise<"approved"> => {
      approvalCount += 1;
      return "approved";
    };

    expectError(
      await harness.runtime.execute(
        editCall({
          path: "config.ts",
          oldString: "missing",
          newString: "replacement",
          expectedVersion: version,
        }),
        { operationId: DEFAULT_EDIT_OPERATION_ID, requestApproval: approval },
      ),
      "old_string_not_found",
    );
    expectError(
      await harness.runtime.execute(
        editCall({
          path: "config.ts",
          oldString: "timeout=120",
          newString: "timeout=120",
          expectedVersion: version,
        }),
        { operationId: DEFAULT_EDIT_OPERATION_ID, requestApproval: approval },
      ),
      "invalid_arguments",
    );
    expectError(
      await harness.runtime.execute(
        editCall({
          path: "../outside.txt",
          oldString: "outside",
          newString: "changed",
          expectedVersion: version,
        }),
        { operationId: DEFAULT_EDIT_OPERATION_ID, requestApproval: approval },
      ),
      "path_outside_workspace",
    );
    expect(approvalCount).toBe(0);
    await expect(readFile(path, "utf8")).resolves.toBe("timeout=120\n");
  });

  it("rejects a symlink that resolves outside the workspace", async () => {
    const harness = await createHarness();
    const outside = join(harness.root, "outside.txt");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(harness.workspace, "link.txt"));

    const observation = await harness.runtime.execute(
      editCall({
        path: "link.txt",
        oldString: "outside",
        newString: "changed",
        expectedVersion: "file-version-v1:invalid",
      }),
      {
        operationId: DEFAULT_EDIT_OPERATION_ID,
        requestApproval: async () => "approved",
      },
    );

    expectError(observation, "path_outside_workspace");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  it("completes the Core Read -> Edit -> Observation -> final answer loop", async () => {
    const harness = await createHarness();
    const path = join(harness.workspace, "config.ts");
    await writeFile(path, "export const timeoutMs = 120000;\n", "utf8");
    const provider = new EditFlowProvider();
    const core = new AgentCore(provider, harness.runtime, { maxSteps: 4 });
    const approvals: ToolApprovalRequest[] = [];

    const result = await core.run("把 config.ts 的超时改为 180000", {
      requestApproval: async (request) => {
        approvals.push(request);
        return "approved";
      },
    });

    expect(result).toMatchObject({
      kind: "final_answer",
      answer: "config.ts now uses timeoutMs = 180000.",
      steps: 3,
    });
    expect(provider.requests).toHaveLength(3);
    expect(
      result.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolName),
    ).toEqual(["read", "edit"]);
    const editMessage = result.messages.find(
      (message) => message.role === "tool" && message.toolName === "edit",
    );
    if (editMessage?.role !== "tool") {
      throw new Error("Expected the Core Edit tool message.");
    }
    expect(editMessage.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(
      operationState(harness, editMessage.operationId),
    ).resolves.toBe("applied");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "file_edit",
      path: "config.ts",
    });
    await expect(readFile(path, "utf8")).resolves.toBe(
      "export const timeoutMs = 180000;\n",
    );
  });
});

class EditFlowProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    if (toolMessages.length === 0) {
      return {
        kind: "tool_calls",
        content: [],
        calls: [readCall("config.ts")],
      };
    }
    if (toolMessages.length === 1) {
      const readObservation = toolMessages[0]?.observation;
      const version = versionFromObservation(readObservation);
      return {
        kind: "tool_calls",
        content: [],
        calls: [
          editCall({
            path: "config.ts",
            oldString: "timeoutMs = 120000",
            newString: "timeoutMs = 180000",
            expectedVersion: version,
          }),
        ],
      };
    }
    return {
      kind: "final",
      content: [
        { type: "text", text: "config.ts now uses timeoutMs = 180000." },
      ],
    };
  }
}

async function createHarness(): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly toolOutputRoot: string;
  readonly editOperationRoot: string;
  readonly runtime: ToolRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-edit-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const toolOutputRoot = join(root, "tool-output");
  const editOperationRoot = join(root, "edit-operations");
  return {
    root,
    workspace,
    toolOutputRoot,
    editOperationRoot,
    runtime: await ToolRuntime.withEdit({
      workspaceRoot: workspace,
      toolOutputRoot,
      editOperationRoot,
    }),
  };
}

async function restartRuntime(harness: {
  readonly workspace: string;
  readonly toolOutputRoot: string;
  readonly editOperationRoot: string;
}): Promise<ToolRuntime> {
  return ToolRuntime.withEdit({
    workspaceRoot: harness.workspace,
    toolOutputRoot: harness.toolOutputRoot,
    editOperationRoot: harness.editOperationRoot,
  });
}

async function forcePending(
  harness: { readonly editOperationRoot: string },
  operationId: string,
): Promise<void> {
  const store = await EditOperationStore.create({
    root: harness.editOperationRoot,
  });
  const record = await store.read(operationId);
  if (record?.state !== "applied") {
    throw new Error("Expected an applied Edit operation record.");
  }
  const {
    afterVersion: _afterVersion,
    state: _state,
    ...pendingFields
  } = record;
  const pending: PendingEditOperationRecord = {
    ...pendingFields,
    state: "pending",
  };
  await store.write(pending);
}

async function operationState(
  harness: { readonly editOperationRoot: string },
  operationId: string,
): Promise<string | undefined> {
  const store = await EditOperationStore.create({
    root: harness.editOperationRoot,
  });
  return (await store.read(operationId))?.state;
}

function readCall(path: string, id = "call-read"): ToolCall {
  return {
    id,
    name: "read",
    rawArguments: JSON.stringify({ path }),
  };
}

function editCall(input: {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly expectedVersion: string;
}): ToolCall {
  return {
    id: "call-edit",
    name: "edit",
    rawArguments: JSON.stringify({
      path: input.path,
      old_string: input.oldString,
      new_string: input.newString,
      expected_version: input.expectedVersion,
    }),
  };
}

async function readVersion(runtime: ToolRuntime, path: string): Promise<string> {
  return versionFromObservation(await runtime.execute(readCall(path)));
}

function versionFromObservation(observation: Observation | undefined): string {
  if (observation?.status !== "success") {
    throw new Error("Expected a successful Read Observation.");
  }
  const output = observation.output;
  if (
    typeof output !== "object" ||
    output === null ||
    !("version" in output) ||
    typeof output.version !== "string"
  ) {
    throw new Error("Read did not return a file version.");
  }
  return output.version;
}

function successResult(observation: Observation): EditResult {
  expect(observation.status).toBe("success");
  if (observation.status !== "success") {
    throw new Error("Expected a successful Edit Observation.");
  }
  return observation.output as EditResult;
}

function expectError(observation: Observation, code: string): void {
  expect(observation.status).toBe("error");
  if (observation.status === "error") {
    expect(observation.error.code).toBe(code);
  }
}
