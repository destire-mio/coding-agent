import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Observation, ToolCall } from "../src/core/contracts.js";
import { GrepTool } from "../src/runtime/grep-tool.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("GrepTool", () => {
  it("searches a workspace path with ripgrep regex syntax", async () => {
    const { workspace } = await createWorkspace();
    await mkdir(join(workspace, "logs"));
    await writeFile(
      join(workspace, "logs", "app.log"),
      [
        "INFO order-100 completed",
        "ERROR payment failed for order-123",
        "ERROR payment failed for order-abc",
        "",
      ].join("\n"),
      "utf8",
    );
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const page = readGrepPage(
      await runtime.execute(
        grepCall(String.raw`^ERROR.*order-\d+$`, "logs", "call-regex"),
      ),
    );

    expect(page).toEqual({
      pattern: String.raw`^ERROR.*order-\d+$`,
      path: "logs",
      matches: [
        {
          path: "logs/app.log",
          line: 2,
          text: "ERROR payment failed for order-123",
          truncated: false,
        },
      ],
      complete: true,
    });
  });

  it("returns a successful empty result when nothing matches", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "app.log"), "INFO ready\n", "utf8");
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const page = readGrepPage(
      await runtime.execute(grepCall("ERROR", undefined, "call-no-match")),
    );

    expect(page).toMatchObject({
      path: ".",
      matches: [],
      complete: true,
    });
  });

  it("treats a leading-dash pattern as data instead of a ripgrep option", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "flags.txt"), "--version\n", "utf8");
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const page = readGrepPage(
      await runtime.execute(
        grepCall("--version", "flags.txt", "call-leading-dash"),
      ),
    );

    expect(page.matches).toMatchObject([
      { path: "flags.txt", line: 1, text: "--version" },
    ]);
  });

  it("pages live results with a signed cursor", async () => {
    const { workspace } = await createWorkspace();
    const path = join(workspace, "app.log");
    await writeFile(path, "MATCH A\nMATCH B\nMATCH C\n", "utf8");
    const runtime = await grepRuntime({
      workspaceRoot: workspace,
      maxMatches: 1,
    });

    const first = readGrepPage(
      await runtime.execute(grepCall("^MATCH", "app.log", "call-page-1")),
    );
    expect(first).toMatchObject({
      matches: [{ line: 1, text: "MATCH A" }],
      complete: false,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    await writeFile(path, "MATCH X\nMATCH A\nMATCH B\nMATCH C\n", "utf8");
    const second = readGrepPage(
      await runtime.execute(
        grepCall("^MATCH", "app.log", "call-page-2", first.nextCursor),
      ),
    );

    expect(second).toMatchObject({
      matches: [{ line: 2, text: "MATCH A" }],
      complete: false,
    });
  });

  it("rejects edited or cross-search cursors", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "app.log"), "MATCH A\nMATCH B\n", "utf8");
    const runtime = await grepRuntime({
      workspaceRoot: workspace,
      maxMatches: 1,
    });
    const first = readGrepPage(
      await runtime.execute(grepCall("MATCH", "app.log", "call-cursor")),
    );

    const edited = await runtime.execute(
      grepCall(
        "MATCH",
        "app.log",
        "call-edited-cursor",
        alterCursorPayload(first.nextCursor),
      ),
    );
    expectError(edited, "call-edited-cursor", "invalid_cursor");

    const changedPattern = await runtime.execute(
      grepCall("OTHER", "app.log", "call-cross-search", first.nextCursor),
    );
    expectError(changedPattern, "call-cross-search", "invalid_cursor");
  });

  it("always filters sensitive files but permits .env.example", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, ".env"), "TOKEN=DO_NOT_LEAK\n", "utf8");
    await writeFile(
      join(workspace, ".env.production"),
      "TOKEN=DO_NOT_LEAK_EITHER\n",
      "utf8",
    );
    await writeFile(
      join(workspace, ".env.example"),
      "TOKEN=VISIBLE_EXAMPLE\n",
      "utf8",
    );
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const page = readGrepPage(
      await runtime.execute(grepCall("TOKEN", undefined, "call-sensitive")),
    );

    expect(page.matches).toEqual([
      {
        path: ".env.example",
        line: 1,
        text: "TOKEN=VISIBLE_EXAMPLE",
        truncated: false,
      },
    ]);
    expect(JSON.stringify(page)).not.toContain("DO_NOT_LEAK");

    const explicitSensitive = await runtime.execute(
      grepCall("TOKEN", ".env", "call-explicit-sensitive"),
    );
    expectError(explicitSensitive, "call-explicit-sensitive", "sensitive_path");
  });

  it("rejects traversal and symlink escapes before spawning ripgrep", async () => {
    const { root, workspace } = await createWorkspace();
    await writeFile(join(root, "secret.log"), "SECRET\n", "utf8");
    await symlink(join(root, "secret.log"), join(workspace, "outside.log"));
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const traversal = await runtime.execute(
      grepCall("SECRET", "../secret.log", "call-traversal"),
    );
    expectError(traversal, "call-traversal", "path_outside_workspace");

    const symlinkEscape = await runtime.execute(
      grepCall("SECRET", "outside.log", "call-symlink"),
    );
    expectError(symlinkEscape, "call-symlink", "path_outside_workspace");
  });

  it("returns invalid_pattern and grep_unavailable as explicit errors", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "app.log"), "hello\n", "utf8");
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const invalid = await runtime.execute(
      grepCall("[invalid", "app.log", "call-invalid-pattern"),
    );
    expectError(invalid, "call-invalid-pattern", "invalid_pattern");

    const unavailable = await grepRuntime({
      workspaceRoot: workspace,
      rgPath: join(workspace, "missing-rg"),
    });
    const missing = await unavailable.execute(
      grepCall("hello", "app.log", "call-missing-rg"),
    );
    expectError(missing, "call-missing-rg", "grep_unavailable");
  });

  it("returns bounded previews for extremely long matching lines", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(
      join(workspace, "long.log"),
      `ERROR ${"x".repeat(5_000)}\n`,
      "utf8",
    );
    const runtime = await grepRuntime({ workspaceRoot: workspace });

    const page = readGrepPage(
      await runtime.execute(grepCall("ERROR", "long.log", "call-long")),
    );

    expect(page.matches).toHaveLength(1);
    expect(page.matches[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(page.matches[0]?.text ?? "", "utf8")).toBeLessThan(
      2_100,
    );
  });

  it("discards partial results and returns search_timeout", async () => {
    const { workspace } = await createWorkspace();
    const fakeRg = await createHangingRipgrep(workspace);
    const runtime = await grepRuntime({
      workspaceRoot: workspace,
      rgPath: fakeRg,
      timeoutMs: 25,
    });

    const observation = await runtime.execute(
      grepCall("MATCH", undefined, "call-timeout"),
    );

    expectError(observation, "call-timeout", "search_timeout");
    expect(JSON.stringify(observation)).not.toContain("matches");
  });

  it("terminates ripgrep when the runtime signal is cancelled", async () => {
    const { workspace } = await createWorkspace();
    const fakeRg = await createHangingRipgrep(workspace);
    const runtime = await grepRuntime({
      workspaceRoot: workspace,
      rgPath: fakeRg,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();

    const pending = runtime.execute(
      grepCall("MATCH", undefined, "call-cancel"),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 25);

    const observation = await pending;
    expectError(observation, "call-cancel", "cancelled");
  });
});

interface GrepPage {
  readonly pattern: string;
  readonly path: string;
  readonly matches: readonly GrepMatch[];
  readonly complete: boolean;
  readonly nextCursor?: string;
}

interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly truncated: boolean;
}

async function createWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-grep-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

async function grepRuntime(
  options: Parameters<typeof GrepTool.create>[0],
): Promise<ToolRuntime> {
  return new ToolRuntime([await GrepTool.create(options)]);
}

function grepCall(
  pattern: string,
  path?: string,
  id = "call-grep",
  cursor?: string,
): ToolCall {
  return {
    id,
    name: "grep",
    rawArguments: JSON.stringify({
      pattern,
      ...(path === undefined ? {} : { path }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  };
}

function readGrepPage(observation: Observation): GrepPage {
  expect(observation.status).toBe("success");
  if (observation.status !== "success") {
    throw new Error("Expected a successful Grep page.");
  }
  return observation.output as GrepPage;
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

function alterCursorPayload(cursor: string | undefined): string {
  if (cursor === undefined) {
    throw new Error("Expected a Grep continuation cursor.");
  }
  const [payload, signature] = cursor.split(".");
  if (payload === undefined || signature === undefined) {
    throw new Error("Expected a signed Grep cursor.");
  }
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { offset: number };
  decoded.offset += 1;
  const edited = Buffer.from(JSON.stringify(decoded), "utf8").toString(
    "base64url",
  );
  return `${edited}.${signature}`;
}

async function createHangingRipgrep(workspace: string): Promise<string> {
  const path = join(workspace, "fake-rg.mjs");
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "process.stdout.write('fake\\u00001:MATCH partial\\n');",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}
