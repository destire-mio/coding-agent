import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Observation, ToolCall } from "../src/core/contracts.js";
import {
  BashTool,
  type BashResult,
} from "../src/runtime/bash-tool.js";
import { ReadTool } from "../src/runtime/read-tool.js";
import { ToolOutputStore } from "../src/runtime/tool-output-store.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("Bash output refs through Read", () => {
  it("publishes a Provider-compatible flat Read schema while Runtime enforces XOR", async () => {
    const harness = await createHarness();
    const readDefinition = harness.runtime.definitions().find(
      (definition) => definition.name === "read",
    );

    expect(readDefinition?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
        ref: { type: "string" },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    });
    expect(readDefinition?.inputSchema).not.toHaveProperty("anyOf");
  });

  it("refuses to place private output storage inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-agent-private-boundary-"));
    temporaryRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(
      ToolRuntime.withBash({
        workspaceRoot: workspace,
        toolOutputRoot: join(workspace, ".private-output"),
      }),
    ).rejects.toThrow(
      "The private tool output store must be outside the workspace.",
    );
  });

  it("keeps bounded previews and reconstructs complete stdout/stderr separately", async () => {
    const harness = await createHarness({
      maxOutputChars: 5,
      maxReadBytes: 4,
    });

    const result = successResult(
      await harness.runtime.execute(
        bashCall("printf '123456789'; printf 'abcdefghi' >&2"),
        { requestApproval: async () => "approved" },
      ),
    );

    expect(result).toMatchObject({
      stdout: "12345",
      stderr: "abcde",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(result.stdoutRef).toMatch(/^tool-output-v1:[A-Za-z0-9_-]{43}$/);
    expect(result.stderrRef).toMatch(/^tool-output-v1:[A-Za-z0-9_-]{43}$/);
    expect(result.stdoutRef).not.toBe(result.stderrRef);
    await expect(readAll(harness.runtime, result.stdoutRef)).resolves.toBe(
      "123456789",
    );
    await expect(readAll(harness.runtime, result.stderrRef)).resolves.toBe(
      "abcdefghi",
    );
  });

  it("rejects forged refs, direct private paths, mixed sources, and cross-ref cursors", async () => {
    const harness = await createHarness({ maxReadBytes: 4 });
    const result = successResult(
      await harness.runtime.execute(
        bashCall("printf 'stdout-long'; printf 'stderr-long' >&2"),
        { requestApproval: async () => "approved" },
      ),
    );
    const firstStdoutPage = readPage(
      await harness.runtime.execute(readRefCall(result.stdoutRef)),
    );
    expect(firstStdoutPage.nextCursor).toEqual(expect.any(String));

    expectError(
      await harness.runtime.execute(
        readRefCall(`tool-output-v1:${"A".repeat(43)}`, "call-forged"),
      ),
      "invalid_ref",
    );
    expectError(
      await harness.runtime.execute({
        id: "call-private-path",
        name: "read",
        rawArguments: JSON.stringify({
          path: join(harness.outputRoot, "private.log"),
        }),
      }),
      "path_outside_workspace",
    );
    expectError(
      await harness.runtime.execute({
        id: "call-mixed-source",
        name: "read",
        rawArguments: JSON.stringify({
          path: "README.md",
          ref: result.stdoutRef,
        }),
      }),
      "invalid_arguments",
    );
    expectError(
      await harness.runtime.execute(
        readRefCall(
          result.stderrRef,
          "call-cross-ref",
          firstStdoutPage.nextCursor,
        ),
      ),
      "invalid_cursor",
    );
  });

  it("reopens a completed output ref after Runtime restart", async () => {
    const harness = await createHarness({ maxReadBytes: 5 });
    const result = successResult(
      await harness.runtime.execute(bashCall("printf 'survives-restart'"), {
        requestApproval: async () => "approved",
      }),
    );

    const reopenedStore = await ToolOutputStore.create({
      root: harness.outputRoot,
    });
    const restartedRuntime = new ToolRuntime([
      await ReadTool.create({
        workspaceRoot: harness.workspace,
        maxReadBytes: 5,
        toolOutputStore: reopenedStore,
      }),
    ]);

    await expect(readAll(restartedRuntime, result.stdoutRef)).resolves.toBe(
      "survives-restart",
    );
  });

  it("preserves emitted log evidence after timeout and cancellation", async () => {
    const timeoutHarness = await createHarness({
      timeoutMs: 150,
      terminationGraceMs: 250,
    });
    const timedOut = errorResult(
      await timeoutHarness.runtime.execute(
        bashCall("printf 'before-timeout'; sleep 30"),
        { requestApproval: async () => "approved" },
      ),
      "command_timeout",
    );
    await expect(
      readAll(timeoutHarness.runtime, timedOut.stdoutRef),
    ).resolves.toBe("before-timeout");

    const cancelHarness = await createHarness({
      timeoutMs: 30_000,
      terminationGraceMs: 250,
    });
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 100);
    const cancelled = errorResult(
      await cancelHarness.runtime.execute(
        bashCall("printf 'before-cancel'; sleep 30"),
        {
          signal: controller.signal,
          requestApproval: async () => "approved",
        },
      ),
      "cancelled",
    );
    clearTimeout(cancellation);
    await expect(
      readAll(cancelHarness.runtime, cancelled.stdoutRef),
    ).resolves.toBe("before-cancel");
  });
});

async function createHarness(
  options: {
    readonly maxOutputChars?: number;
    readonly maxReadBytes?: number;
    readonly timeoutMs?: number;
    readonly terminationGraceMs?: number;
  } = {},
): Promise<{
  readonly workspace: string;
  readonly outputRoot: string;
  readonly runtime: ToolRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-output-read-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const outputRoot = join(root, "private-output");
  await mkdir(workspace);
  const outputStore = await ToolOutputStore.create({ root: outputRoot });
  return {
    workspace,
    outputRoot,
    runtime: new ToolRuntime([
      await ReadTool.create({
        workspaceRoot: workspace,
        ...(options.maxReadBytes === undefined
          ? {}
          : { maxReadBytes: options.maxReadBytes }),
        toolOutputStore: outputStore,
      }),
      await BashTool.create({
        workspaceRoot: workspace,
        outputStore,
        ...(options.maxOutputChars === undefined
          ? {}
          : { maxOutputChars: options.maxOutputChars }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...(options.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: options.terminationGraceMs }),
      }),
    ]),
  };
}

async function readAll(runtime: ToolRuntime, ref: string): Promise<string> {
  let content = "";
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = readPage(
      await runtime.execute(
        readRefCall(ref, `call-read-${pageIndex}`, cursor),
      ),
    );
    expect(page.ref).toBe(ref);
    content += page.content;
    if (page.complete) {
      return content;
    }
    cursor = page.nextCursor;
  }
  throw new Error("Read did not complete within the test page bound.");
}

interface RefReadPage {
  readonly ref: string;
  readonly content: string;
  readonly complete: boolean;
  readonly nextCursor?: string;
}

function readPage(observation: Observation): RefReadPage {
  expect(observation.status).toBe("success");
  if (observation.status !== "success") {
    throw new Error("Expected a successful Read Observation.");
  }
  return observation.output as RefReadPage;
}

function successResult(observation: Observation): BashResult {
  expect(observation.status).toBe("success");
  if (observation.status !== "success") {
    throw new Error("Expected a successful Bash Observation.");
  }
  return observation.output as BashResult;
}

function errorResult(observation: Observation, code: string): BashResult {
  expectError(observation, code);
  if (observation.status !== "error") {
    throw new Error("Expected an error Bash Observation.");
  }
  return observation.error.details as BashResult;
}

function expectError(observation: Observation, code: string): void {
  expect(observation.status).toBe("error");
  if (observation.status === "error") {
    expect(observation.error.code).toBe(code);
  }
}

function bashCall(command: string): ToolCall {
  return {
    id: "call-bash-output",
    name: "bash",
    rawArguments: JSON.stringify({ command }),
  };
}

function readRefCall(
  ref: string,
  id = "call-read-ref",
  cursor?: string,
): ToolCall {
  return {
    id,
    name: "read",
    rawArguments: JSON.stringify({
      ref,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  };
}
