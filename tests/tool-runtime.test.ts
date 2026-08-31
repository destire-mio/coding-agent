import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Observation, ToolCall } from "../src/core/contracts.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import type { RuntimeTool } from "../src/runtime/tool.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ToolRuntime Read", () => {
  it("discloses the same strict Read argument contract to the model", async () => {
    const { workspace } = await createWorkspace();
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    expect(runtime.definitions()).toEqual([
      {
        name: "read",
        description:
          "Read one UTF-8 text file inside the workspace. The path must be relative to the workspace root.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              description:
                "A path relative to the workspace root, for example README.md.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("reads a UTF-8 file inside the workspace", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "README.md"), "hello from workspace\n", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute(readCall("README.md"));

    expect(observation.status).toBe("success");
    if (observation.status === "success") {
      expect(observation.output).toEqual({
        path: "README.md",
        bytes: 21,
        content: "hello from workspace\n",
      });
    }
  });

  it("returns a corresponding error Observation for path traversal", async () => {
    const { root, workspace } = await createWorkspace();
    await writeFile(join(root, "secret.txt"), "DO_NOT_LEAK", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute(readCall("../secret.txt", "call-denied"));

    expectError(observation, "call-denied", "path_outside_workspace");
    expect(JSON.stringify(observation)).not.toContain("DO_NOT_LEAK");
  });

  it("rejects an absolute path outside the workspace", async () => {
    const { root, workspace } = await createWorkspace();
    const secret = join(root, "secret.txt");
    await writeFile(secret, "DO_NOT_LEAK", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute(readCall(secret));

    expectError(observation, "call-read", "path_outside_workspace");
  });

  it("rejects a symlink that resolves outside the workspace", async () => {
    const { root, workspace } = await createWorkspace();
    const secret = join(root, "secret.txt");
    await writeFile(secret, "DO_NOT_LEAK", "utf8");
    await symlink(secret, join(workspace, "outside-link.txt"));
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute(readCall("outside-link.txt"));

    expectError(observation, "call-read", "path_outside_workspace");
    expect(JSON.stringify(observation)).not.toContain("DO_NOT_LEAK");
  });

  it("returns an invalid_arguments Observation instead of throwing", async () => {
    const { workspace } = await createWorkspace();
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute({
      id: "call-invalid",
      name: "read",
      rawArguments: "{}",
    });

    expectError(observation, "call-invalid", "invalid_arguments");
  });

  it("returns a not_found Observation", async () => {
    const { workspace } = await createWorkspace();
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute(readCall("missing.md"));

    expectError(observation, "call-read", "not_found");
  });

  it("returns a paired, sanitized Observation when a tool throws", async () => {
    const throwingTool: RuntimeTool = {
      definition: {
        name: "throwing_tool",
        description: "A deterministic failing tool double.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      execute: async () => {
        throw new Error("private implementation detail");
      },
    };
    const runtime = new ToolRuntime([throwingTool]);

    const observation = await runtime.execute({
      id: "call-throwing",
      name: "throwing_tool",
      rawArguments: "{}",
    });

    expectError(observation, "call-throwing", "tool_internal_error");
    expect(JSON.stringify(observation)).not.toContain(
      "private implementation detail",
    );
  });
});

async function createWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-runtime-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

function readCall(path: string, id = "call-read"): ToolCall {
  return { id, name: "read", rawArguments: JSON.stringify({ path }) };
}

function expectError(
  observation: Observation,
  toolCallId: string,
  code: string,
): void {
  expect(observation.toolCallId).toBe(toolCallId);
  expect(observation.status).toBe("error");
  if (observation.status === "error") {
    expect(observation.error.code).toBe(code);
  }
}
