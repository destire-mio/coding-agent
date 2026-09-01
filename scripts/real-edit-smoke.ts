import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCore } from "../src/core/agent-core.js";
import type {
  Observation,
  ToolApprovalRequest,
} from "../src/core/contracts.js";
import { loadProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";
import type { EditResult } from "../src/runtime/edit-tool.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const oldMarker = `EDIT_OLD_${randomBytes(8).toString("hex")}`;
const newMarker = `EDIT_NEW_${randomBytes(8).toString("hex")}`;
const oldLine = `export const marker = "${oldMarker}";`;
const newLine = `export const marker = "${newMarker}";`;
const originalContent = `${oldLine}\nexport const mode = "smoke";\n`;
const expectedContent = `${newLine}\nexport const mode = "smoke";\n`;
const root = await mkdtemp(join(tmpdir(), "coding-agent-real-edit-"));
const workspace = join(root, "workspace");
const configPath = join(workspace, "config.ts");

try {
  await mkdir(workspace);
  await writeFile(configPath, originalContent, "utf8");

  const provider = new OpenAICompatibleProvider(loadProviderConfig());
  const runtime = await ToolRuntime.withEdit({
    workspaceRoot: workspace,
    toolOutputRoot: join(root, "tool-output"),
    editOperationRoot: join(root, "edit-operations"),
  });
  const core = new AgentCore(provider, runtime, { maxSteps: 6 });
  const approvals: ToolApprovalRequest[] = [];
  let sawToolCallDelta = false;
  let sawThinkingDelta = false;
  let sawTextDelta = false;
  let providerAttempts = 0;
  let providerRetries = 0;

  const result = await core.run(
    [
      "Complete the exact Edit acceptance task.",
      "First call read on config.ts and use the exact returned version.",
      "Then call edit exactly once; do not use bash or grep.",
      `Use this exact old_string: ${JSON.stringify(oldLine)}.`,
      `Use this exact new_string: ${JSON.stringify(newLine)}.`,
      "Pass the Read version unchanged as expected_version.",
      "After the successful Edit Observation, return a final answer containing the new marker.",
    ].join(" "),
    {
      requestApproval: async (request) => {
        approvals.push(request);
        process.stderr.write(
          `${JSON.stringify({
            event: "approval_requested",
            tool: request.toolName,
            kind: request.kind,
            ...(request.kind === "file_edit"
              ? { path: request.path, diff: request.diff }
              : {}),
          })}\n`,
        );
        return approvals.length === 1 &&
          request.toolName === "edit" &&
          request.kind === "file_edit" &&
          request.path === "config.ts" &&
          request.diff.includes(`-${oldLine}`) &&
          request.diff.includes(`+${newLine}`)
          ? "approved"
          : "rejected";
      },
      onEvent: (event) => {
        sawToolCallDelta ||= event.type === "model_tool_call_delta";
        sawThinkingDelta ||= event.type === "model_thinking_delta";
        sawTextDelta ||= event.type === "model_text_delta";
        providerAttempts += event.type === "model_request" ? 1 : 0;
        providerRetries += event.type === "provider_retry" ? 1 : 0;
      },
    },
  );

  const toolMessages = result.messages.filter(
    (message) => message.role === "tool",
  );
  if (result.kind !== "final_answer") {
    throw smokeFailure(`Expected final_answer, received ${result.kind}.`, toolMessages);
  }
  if (toolMessages.map((message) => message.toolName).join(",") !== "read,edit") {
    throw smokeFailure("Expected exactly Read -> Edit before the final answer.", toolMessages);
  }
  if (approvals.length !== 1 || approvals[0]?.kind !== "file_edit") {
    throw smokeFailure("Expected exactly one file Edit approval.", toolMessages);
  }

  const readObservation = toolMessages[0]?.observation;
  const editObservation = toolMessages[1]?.observation;
  const readVersion = versionFromRead(readObservation);
  const editResult = resultFromEdit(editObservation);
  if (
    editResult.beforeVersion !== readVersion ||
    editResult.afterVersion === readVersion ||
    editResult.verified !== true
  ) {
    throw smokeFailure("Edit did not preserve the Read version contract.", toolMessages);
  }
  if ((await readFile(configPath, "utf8")) !== expectedContent) {
    throw smokeFailure("The real workspace file does not contain the exact approved edit.", toolMessages);
  }
  const verifiedVersion = versionFromRead(
    await runtime.execute({
      id: "call-post-smoke-read",
      name: "read",
      rawArguments: JSON.stringify({ path: "config.ts" }),
    }),
  );
  if (verifiedVersion !== editResult.afterVersion) {
    throw smokeFailure("A fresh Read did not confirm Edit's afterVersion.", toolMessages);
  }
  if (!result.answer.includes(newMarker)) {
    throw smokeFailure("The final answer omitted the new marker.", toolMessages);
  }
  if (!sawToolCallDelta || !sawThinkingDelta || !sawTextDelta) {
    throw smokeFailure(
      "The Provider did not expose thinking, tool-call, and final-text streaming.",
      toolMessages,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        steps: result.steps,
        toolSequence: toolMessages.map((message) => message.toolName),
        approvalVerified: true,
        staleVersionProtected: true,
        diskReadBackVerified: true,
        oldMarkerRemoved: !(await readFile(configPath, "utf8")).includes(oldMarker),
        newMarkerVerified: true,
        thinkingVerified: true,
        streamingVerified: true,
        providerAttempts,
        providerRetries,
        answer: result.answer,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function versionFromRead(observation: Observation | undefined): string {
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
    throw new Error("Read did not return a version.");
  }
  return output.version;
}

function resultFromEdit(observation: Observation | undefined): EditResult {
  if (observation?.status !== "success") {
    throw new Error("Expected a successful Edit Observation.");
  }
  return observation.output as EditResult;
}

function smokeFailure(
  message: string,
  observations: readonly {
    readonly toolName: string;
    readonly observation: Observation;
  }[],
): Error {
  return new Error(
    `${message}\n${JSON.stringify(
      observations.map(({ toolName, observation }) => ({
        tool: toolName,
        status: observation.status,
        ...(observation.status === "error"
          ? { error: observation.error.code }
          : {}),
      })),
      null,
      2,
    )}`,
  );
}
