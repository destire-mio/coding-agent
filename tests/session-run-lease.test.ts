import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { SessionBusyError } from "../src/session/session-run-lease.js";
import { SessionTranscriptStore } from "../src/session/session-transcript-store.js";

const temporaryRoots: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

it.skipIf(process.platform === "win32")(
  "allows a new process to acquire a stale lease after the holder is killed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-agent-session-lease-"));
    temporaryRoots.push(root);
    const workspace = join(root, "workspace");
    const sessionRoot = join(root, "sessions");
    await mkdir(workspace);
    const session = await SessionTranscriptStore.create({
      workspaceRoot: workspace,
      root: sessionRoot,
      sessionId: "session-killed-holder",
    });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "tests/helpers/session-run-lease-holder.ts"),
        workspace,
        sessionRoot,
        session.sessionId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    childProcesses.push(child);
    await waitForOutput(child, "locked\n");

    child.kill("SIGKILL");
    await waitForExit(child);
    await expect(session.acquireRunLease()).rejects.toBeInstanceOf(SessionBusyError);

    // proper-lockfile rounds mtimes for filesystem precision, so leave a full
    // precision interval beyond the 5-second stale policy.
    await delay(6_500);
    const recovered = await SessionTranscriptStore.openForRun({
      workspaceRoot: workspace,
      root: sessionRoot,
      sessionId: session.sessionId,
    });
    await recovered.lease.release();
  },
  14_000,
);

async function waitForOutput(
  child: ChildProcess,
  expected: string,
): Promise<void> {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error("The lease-holder child has no stdout pipe.");
  }
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the lease-holder child."));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("The lease-holder child exited before acquiring the lock."));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      child.off("exit", onExit);
    };
    stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
