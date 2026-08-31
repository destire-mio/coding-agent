import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

describe("ToolRuntime", () => {
  it("discloses the same strict Read argument contract to the model", async () => {
    const { workspace } = await createWorkspace();
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    expect(runtime.definitions()).toEqual([
      {
        name: "read",
        description:
          "Read one bounded UTF-8 text page inside the workspace. The path must be relative to the workspace root. When complete is false, call Read again with the same path and pass the returned nextCursor value as the cursor argument.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              description:
                "A path relative to the workspace root, for example README.md.",
            },
            cursor: {
              type: "string",
              minLength: 1,
              maxLength: 2048,
              description:
                "The exact nextCursor returned by a previous Read page for the same file. Omit to start from the beginning.",
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
        fileBytes: 21,
        content: "hello from workspace\n",
        startLine: 1,
        endLine: 1,
        continuedFromPreviousLine: false,
        continuesOnNextPage: false,
        complete: true,
      });
    }
  });

  it("pages a multi-line file without losing content", async () => {
    const { workspace } = await createWorkspace();
    const content = "alpha\nbeta\ngamma\n";
    await writeFile(join(workspace, "large.log"), content, "utf8");
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 11,
    });

    const first = readPage(await runtime.execute(readCall("large.log", "call-page-1")));
    expect(first).toMatchObject({
      content: "alpha\nbeta\n",
      startLine: 1,
      endLine: 2,
      complete: false,
      continuesOnNextPage: false,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = readPage(
      await runtime.execute(
        readCall("large.log", "call-page-2", first.nextCursor),
      ),
    );
    expect(second).toMatchObject({
      content: "gamma\n",
      startLine: 3,
      endLine: 3,
      complete: true,
      continuedFromPreviousLine: false,
    });
    expect(first.content + second.content).toBe(content);
  });

  it("continues one long UTF-8 line without losing or splitting characters", async () => {
    const { workspace } = await createWorkspace();
    const content = "你".repeat(6);
    await writeFile(join(workspace, "one-line.txt"), content, "utf8");
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 5,
    });

    const pages: ReadPage[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 10; index += 1) {
      const page = readPage(
        await runtime.execute(
          readCall("one-line.txt", `call-long-${index}`, cursor),
        ),
      );
      pages.push(page);
      cursor = page.nextCursor;
      if (page.complete) {
        break;
      }
    }

    expect(pages).toHaveLength(6);
    expect(pages.map((page) => page.content).join("")).toBe(content);
    expect(pages[0]).toMatchObject({
      startLine: 1,
      endLine: 1,
      continuedFromPreviousLine: false,
      continuesOnNextPage: true,
    });
    expect(pages[1]).toMatchObject({
      startLine: 1,
      endLine: 1,
      continuedFromPreviousLine: true,
    });
    expect(pages.at(-1)).toMatchObject({
      complete: true,
      continuesOnNextPage: false,
    });
  });

  it("rejects a continuation cursor after the file changes", async () => {
    const { workspace } = await createWorkspace();
    const path = join(workspace, "changing.log");
    await writeFile(path, "first\nsecond\n", "utf8");
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 6,
    });
    const first = readPage(
      await runtime.execute(readCall("changing.log", "call-before-change")),
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    const replacement = join(workspace, "replacement.log");
    await writeFile(replacement, "third\nfourth\n", "utf8");
    await rename(replacement, path);
    const observation = await runtime.execute(
      readCall("changing.log", "call-after-change", first.nextCursor),
    );

    expectError(observation, "call-after-change", "file_changed");
  });

  it("rejects a structurally valid cursor after the model alters it", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "large.log"), "alpha\nbeta\ngamma\n", "utf8");
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 6,
    });
    const first = readPage(
      await runtime.execute(readCall("large.log", "call-before-tamper")),
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    const observation = await runtime.execute(
      readCall(
        "large.log",
        "call-after-tamper",
        alterCursorPayload(first.nextCursor),
      ),
    );

    expectError(observation, "call-after-tamper", "invalid_cursor");
  });

  it("rejects a cursor issued for another file", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "first.log"), "a\nmore\n", "utf8");
    await writeFile(join(workspace, "second.log"), "a\nmore\n", "utf8");
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 2,
    });
    const first = readPage(
      await runtime.execute(readCall("first.log", "call-first-file")),
    );

    const observation = await runtime.execute(
      readCall("second.log", "call-second-file", first.nextCursor),
    );

    expectError(observation, "call-second-file", "invalid_cursor");
  });

  it("rejects a malformed continuation cursor", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "README.md"), "first\nsecond\n", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute(
      readCall("README.md", "call-bad-cursor", "not-a-runtime-cursor"),
    );

    expectError(observation, "call-bad-cursor", "invalid_cursor");
  });

  it("fails when the page limit cannot contain one UTF-8 character", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "unicode.txt"), "你", "utf8");
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 1,
    });

    const observation = await runtime.execute(
      readCall("unicode.txt", "call-tiny-page"),
    );

    expectError(observation, "call-tiny-page", "page_limit_too_small");
  });

  it("returns a complete empty page for an empty file", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "empty.txt"), "", "utf8");
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const page = readPage(
      await runtime.execute(readCall("empty.txt", "call-empty")),
    );

    expect(page).toMatchObject({
      content: "",
      startLine: 0,
      endLine: 0,
      complete: true,
    });
    expect(page.nextCursor).toBeUndefined();
  });

  it("rejects invalid UTF-8 encountered on a later page", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(
      join(workspace, "invalid.txt"),
      Buffer.from([0x61, 0x0a, 0xff]),
    );
    const runtime = await ToolRuntime.readOnly({
      workspaceRoot: workspace,
      maxReadBytes: 2,
    });
    const first = readPage(
      await runtime.execute(readCall("invalid.txt", "call-valid-page")),
    );

    const observation = await runtime.execute(
      readCall("invalid.txt", "call-invalid-page", first.nextCursor),
    );

    expectError(observation, "call-invalid-page", "invalid_utf8");
  });

  it("rejects duplicate tool registrations", () => {
    const duplicateTool: RuntimeTool = {
      definition: {
        name: "duplicate",
        description: "A duplicate registration test double.",
        inputSchema: { type: "object", additionalProperties: false },
      },
      execute: async () => ({ status: "success", output: null }),
    };

    expect(() => new ToolRuntime([duplicateTool, duplicateTool])).toThrow(
      "Duplicate tool registration: duplicate",
    );
  });

  it("returns a paired unknown_tool Observation before parsing arguments", async () => {
    const runtime = new ToolRuntime([]);

    const observation = await runtime.execute({
      id: "call-unknown",
      name: "edit",
      rawArguments: "not-json",
    });

    expectError(observation, "call-unknown", "unknown_tool");
    expect(observation.toolName).toBe("edit");
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

  it("returns invalid_arguments for malformed JSON", async () => {
    const { workspace } = await createWorkspace();
    const runtime = await ToolRuntime.readOnly({ workspaceRoot: workspace });

    const observation = await runtime.execute({
      id: "call-malformed",
      name: "read",
      rawArguments: '{"path":',
    });

    expectError(observation, "call-malformed", "invalid_arguments");
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

interface ReadPage {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly continuedFromPreviousLine: boolean;
  readonly continuesOnNextPage: boolean;
  readonly complete: boolean;
  readonly nextCursor?: string;
}

function readCall(path: string, id = "call-read", cursor?: string): ToolCall {
  return {
    id,
    name: "read",
    rawArguments: JSON.stringify({
      path,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  };
}

function readPage(observation: Observation): ReadPage {
  expect(observation.status).toBe("success");
  if (observation.status !== "success") {
    throw new Error("Expected a successful Read page.");
  }
  return observation.output as ReadPage;
}

function alterCursorPayload(cursor: string | undefined): string {
  if (cursor === undefined) {
    throw new Error("Expected a continuation cursor.");
  }
  const [payload, signature] = cursor.split(".");
  if (payload === undefined || signature === undefined) {
    throw new Error("Expected a signed continuation cursor.");
  }
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { offset: number };
  decoded.offset += 1;
  const alteredPayload = Buffer.from(JSON.stringify(decoded), "utf8").toString(
    "base64url",
  );
  return `${alteredPayload}.${signature}`;
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
