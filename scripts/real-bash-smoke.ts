import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Observation,
  ToolApprovalRequest,
} from "../src/core/contracts.js";
import { AgentCore } from "../src/core/agent-core.js";
import { loadProviderConfig } from "../src/provider/config.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible-provider.js";
import type { BashResult } from "../src/runtime/bash-tool.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const outputPrefixLength = 33_000;
const maxReadBytes = 20_000;
const approvedCommand = "./emit-smoke.sh";
const marker = `CODING_AGENT_REAL_BASH_REF_${randomBytes(12).toString("base64url")}`;
const root = await realpath(
  await mkdtemp(join(tmpdir(), "coding-agent-real-bash-")),
);
const workspace = join(root, "workspace");
const outputRoot = join(root, "private-output");
const scriptPath = join(workspace, "emit-smoke.sh");
const expectedOutput = [
  "A".repeat(outputPrefixLength),
  `Marker: ${marker}`,
  "ProviderSecret: absent",
  "",
].join("\n");

try {
  await mkdir(workspace);
  await writeFile(
    scriptPath,
    [
      "#!/bin/bash",
      "set -eu",
      `printf '%*s' ${outputPrefixLength} '' | tr ' ' A`,
      `printf '\\nMarker: %s\\n' '${marker}'`,
      "if [[ -z ${DEEPSEEK_API_KEY+x} ]]; then",
      "  printf 'ProviderSecret: absent\\n'",
      "else",
      "  printf 'ProviderSecret: present\\n'",
      "fi",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(scriptPath, 0o700);

  const provider = new OpenAICompatibleProvider(loadProviderConfig());
  const runtime = await ToolRuntime.withBash({
    workspaceRoot: workspace,
    maxReadBytes,
    toolOutputRoot: outputRoot,
  });
  const core = new AgentCore(provider, runtime, { maxSteps: 12 });
  const approvalRequests: ToolApprovalRequest[] = [];
  let sawToolCallDelta = false;
  let sawThinkingDelta = false;
  let sawTextDelta = false;
  let providerAttempts = 0;
  let providerRetries = 0;

  const result = await core.run(
    [
      "Run the Bash output-reference acceptance task.",
      `Your first tool call must be bash with exactly this command: ${approvedCommand}`,
      "Do not call read or grep on any workspace path.",
      "After Bash returns, do not call Bash again.",
      "Its stdout preview is intentionally truncated. Use read with stdoutRef.",
      "When a Read page has complete=false, call read again with the same ref and the exact nextCursor unchanged.",
      "Copy the nextCursor property value itself; do not include JSON quotation marks or backslash escapes as part of the cursor.",
      "Continue until complete=true, then report the exact value after 'Marker:' and whether ProviderSecret is absent.",
      "Never infer either value from the prompt or truncated preview.",
    ].join(" "),
    {
      requestApproval: async (request) => {
        approvalRequests.push(request);
        process.stderr.write(
          `${JSON.stringify({
            event: "approval_requested",
            tool: request.toolName,
            command: request.command,
            cwd: request.cwd,
          })}\n`,
        );
        return approvalRequests.length === 1 &&
          request.toolName === "bash" &&
          request.command === approvedCommand &&
          request.cwd === workspace
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

  const toolObservations = result.messages.filter(
    (message) => message.role === "tool",
  );
  const bashMessages = toolObservations.filter(
    (message) => message.toolName === "bash",
  );
  const readMessages = toolObservations.filter(
    (message) => message.toolName === "read",
  );
  const successfulReadMessages = readMessages.filter(
    (message) => message.observation.status === "success",
  );
  const rejectedReadMessages = readMessages.filter(
    (message) => message.observation.status === "error",
  );
  const unexpectedTools = toolObservations.filter(
    (message) => message.toolName !== "bash" && message.toolName !== "read",
  );

  if (result.kind !== "final_answer") {
    const failure = result.kind === "failed"
      ? {
          reason: result.reason,
          message: result.message,
          ...(result.providerFailure === undefined
            ? {}
            : { providerFailure: result.providerFailure }),
        }
      : { reason: result.reason };
    throw smokeFailure(
      `Expected final_answer, received ${result.kind}: ${JSON.stringify(failure)}.`,
      toolObservations,
    );
  }
  if (approvalRequests.length !== 1) {
    throw smokeFailure(
      `Expected exactly one approval request, received ${approvalRequests.length}.`,
      toolObservations,
    );
  }
  if (bashMessages.length !== 1) {
    throw smokeFailure(
      `Expected exactly one Bash execution, received ${bashMessages.length}.`,
      toolObservations,
    );
  }
  if (unexpectedTools.length > 0) {
    throw smokeFailure("The model called an unexpected tool.", toolObservations);
  }

  const bashObservation = bashMessages[0]?.observation;
  if (bashObservation?.status !== "success") {
    throw smokeFailure("The approved Bash command did not succeed.", toolObservations);
  }
  const bashResult = bashObservation.output as BashResult;
  if (
    bashResult.command !== approvedCommand ||
    bashResult.cwd !== workspace ||
    bashResult.exitCode !== 0 ||
    bashResult.stdoutTruncated !== true ||
    bashResult.stdout.includes(marker) ||
    !bashResult.stdoutRef.startsWith("tool-output-v1:")
  ) {
    throw smokeFailure(
      "Bash did not return the expected bounded preview and private stdout ref.",
      toolObservations,
    );
  }

  if (successfulReadMessages.length < 2) {
    throw smokeFailure(
      "The model did not page the truncated stdout ref to completion.",
      toolObservations,
    );
  }
  for (const message of rejectedReadMessages) {
    if (
      message.observation.status !== "error" ||
      !["invalid_arguments", "invalid_cursor"].includes(
        message.observation.error.code,
      )
    ) {
      throw smokeFailure(
        "Read returned an unexpected failure while the model was correcting its request.",
        toolObservations,
      );
    }
  }
  let reconstructed = "";
  for (const [index, message] of successfulReadMessages.entries()) {
    const page = asReadPage(message.observation);
    if (page.ref !== bashResult.stdoutRef) {
      throw smokeFailure(
        "Read used a workspace path or a different output ref.",
        toolObservations,
      );
    }
    if (index < successfulReadMessages.length - 1 && page.complete) {
      throw smokeFailure(
        "The model continued reading after a complete page.",
        toolObservations,
      );
    }
    if (
      index < successfulReadMessages.length - 1 &&
      page.nextCursor === undefined
    ) {
      throw smokeFailure(
        "An incomplete Read page omitted its continuation cursor.",
        toolObservations,
      );
    }
    reconstructed += page.content;
  }
  const finalPage = asReadPage(successfulReadMessages.at(-1)!.observation);
  if (!finalPage.complete || reconstructed !== expectedOutput) {
    throw smokeFailure(
      "Read pages did not reconstruct the complete Bash stdout exactly.",
      toolObservations,
    );
  }
  if (!result.answer.includes(marker) || !/ProviderSecret[^\n]*absent/i.test(result.answer)) {
    throw smokeFailure(
      "The final answer omitted the recovered marker or secret-isolation result.",
      toolObservations,
    );
  }
  if (!sawToolCallDelta || !sawThinkingDelta || !sawTextDelta) {
    throw smokeFailure(
      "The real Provider did not expose thinking, tool-call, and final-text streaming.",
      toolObservations,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        steps: result.steps,
        toolSequence: toolObservations.map((message) => message.toolName),
        approvalVerified: true,
        approvedCommand,
        approvedCwdWasTemporaryWorkspace: approvalRequests[0]?.cwd === workspace,
        bashExecutedOnce: bashMessages.length === 1,
        stdoutTruncated: bashResult.stdoutTruncated,
        readPages: successfulReadMessages.length,
        rejectedReadCalls: rejectedReadMessages.length,
        completeOutputReconstructed: true,
        providerSecretIsolated: reconstructed.includes("ProviderSecret: absent"),
        markerVerified: true,
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

interface ReadPage {
  readonly ref: string;
  readonly content: string;
  readonly complete: boolean;
  readonly nextCursor?: string;
}

function asReadPage(observation: Observation): ReadPage {
  if (observation.status !== "success") {
    throw new Error("Expected a successful Read Observation.");
  }
  const output = observation.output;
  if (typeof output !== "object" || output === null) {
    throw new Error("Read did not return a structured page.");
  }
  const page = output as Record<string, unknown>;
  if (
    typeof page["ref"] !== "string" ||
    typeof page["content"] !== "string" ||
    typeof page["complete"] !== "boolean"
  ) {
    throw new Error("Read page omitted ref, content, or completion state.");
  }
  return {
    ref: page["ref"],
    content: page["content"],
    complete: page["complete"],
    ...(typeof page["nextCursor"] === "string"
      ? { nextCursor: page["nextCursor"] }
      : {}),
  };
}

function smokeFailure(
  message: string,
  observations: readonly {
    readonly toolName: string;
    readonly observation: Observation;
  }[],
): Error {
  const trace = observations.map(({ toolName, observation }) => ({
    tool: toolName,
    status: observation.status,
    ...(observation.status === "error"
      ? { error: observation.error.code }
      : {
          source:
            typeof observation.output === "object" &&
            observation.output !== null &&
            "ref" in observation.output
              ? "ref"
              : "other",
          complete:
            typeof observation.output === "object" &&
            observation.output !== null &&
            "complete" in observation.output
              ? observation.output.complete
              : undefined,
        }),
  }));
  return new Error(`${message} Trace: ${JSON.stringify(trace)}`);
}
