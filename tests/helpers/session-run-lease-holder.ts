import { SessionTranscriptStore } from "../../src/session/session-transcript-store.js";

const [workspaceRoot, root, sessionId] = process.argv.slice(2);
if (workspaceRoot === undefined || root === undefined || sessionId === undefined) {
  throw new Error("Expected workspace root, Session root, and Session ID.");
}

await SessionTranscriptStore.openForRun({ workspaceRoot, root, sessionId });
process.stdout.write("locked\n");
setInterval(() => undefined, 60_000);
