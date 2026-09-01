import { describe, expect, it } from "vitest";

import type { ToolCall, ToolError } from "../src/core/contracts.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import type {
  RuntimeTool,
  ToolApprovalPreparation,
  ToolOutcome,
} from "../src/runtime/tool.js";

describe("ToolRuntime approval gate", () => {
  it("fails closed when no approval handler is available", async () => {
    const tool = new ApprovalProbeTool();
    const runtime = new ToolRuntime([tool]);

    const observation = await runtime.execute(bashCall("npm test"));

    expectError(observation, "approval_required");
    expect(tool.executionCount).toBe(0);
  });

  it("does not execute after the user rejects the exact command and cwd", async () => {
    const tool = new ApprovalProbeTool();
    const runtime = new ToolRuntime([tool]);
    const requests: unknown[] = [];

    const observation = await runtime.execute(bashCall("npm test"), {
      requestApproval: async (request) => {
        requests.push(request);
        return "rejected";
      },
    });

    expect(requests).toEqual([
      {
        toolCallId: "call-bash",
        toolName: "bash",
        command: "npm test",
        cwd: "/workspace",
      },
    ]);
    expectError(observation, "approval_rejected");
    expect(tool.executionCount).toBe(0);
  });

  it("executes exactly once after explicit approval", async () => {
    const tool = new ApprovalProbeTool();
    const runtime = new ToolRuntime([tool]);

    const observation = await runtime.execute(bashCall("npm test"), {
      requestApproval: async () => "approved",
    });

    expect(observation).toMatchObject({
      status: "success",
      output: { command: "npm test" },
    });
    expect(tool.executionCount).toBe(1);
  });

  it("rejects invalid parameters before asking for approval", async () => {
    const tool = new ApprovalProbeTool();
    const runtime = new ToolRuntime([tool]);
    let approvalCount = 0;

    const observation = await runtime.execute(
      {
        id: "call-bash",
        name: "bash",
        rawArguments: JSON.stringify({ command: "" }),
      },
      {
        requestApproval: async () => {
          approvalCount += 1;
          return "approved";
        },
      },
    );

    expectError(observation, "invalid_arguments");
    expect(approvalCount).toBe(0);
    expect(tool.executionCount).toBe(0);
  });
});

class ApprovalProbeTool implements RuntimeTool {
  readonly definition = {
    name: "bash",
    description: "Approval gate test tool.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  };
  executionCount = 0;

  prepareApproval(input: unknown): ToolApprovalPreparation {
    const command = commandFrom(input);
    if (command === undefined) {
      return {
        status: "error",
        error: invalidArguments(),
      };
    }
    return {
      status: "approval_required",
      command,
      cwd: "/workspace",
    };
  }

  async execute(input: unknown): Promise<ToolOutcome> {
    this.executionCount += 1;
    return {
      status: "success",
      output: { command: commandFrom(input) },
    };
  }
}

function bashCall(command: string): ToolCall {
  return {
    id: "call-bash",
    name: "bash",
    rawArguments: JSON.stringify({ command }),
  };
}

function commandFrom(input: unknown): string | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string" ||
    input.command.trim().length === 0
  ) {
    return undefined;
  }
  return input.command;
}

function invalidArguments(): ToolError {
  return {
    code: "invalid_arguments",
    message: "Bash expects one non-empty command.",
    retryable: false,
  };
}

function expectError(
  observation: Awaited<ReturnType<ToolRuntime["execute"]>>,
  code: string,
): void {
  expect(observation.status).toBe("error");
  if (observation.status === "error") {
    expect(observation.error.code).toBe(code);
  }
}
