import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import type {
  Observation,
  ToolCall,
  ToolDefinition,
  ToolExecutionOptions,
  ToolExecutor,
} from "../core/contracts.js";
import { BashTool } from "./bash-tool.js";
import {
  EditOperationStore,
  EditOperationStoreConfigurationError,
} from "./edit-operation-store.js";
import { EditTool } from "./edit-tool.js";
import { createFileVersionSecret } from "./file-version.js";
import { GrepTool } from "./grep-tool.js";
import { ReadTool, type ReadToolOptions } from "./read-tool.js";
import type { RuntimeTool } from "./tool.js";
import {
  ToolOutputStore,
  ToolOutputStoreConfigurationError,
} from "./tool-output-store.js";

export interface BashRuntimeOptions {
  readonly workspaceRoot: string;
  readonly maxReadBytes?: number;
  readonly toolOutputRoot?: string;
}

export interface EditRuntimeOptions extends BashRuntimeOptions {
  readonly editOperationRoot?: string;
}

export class ToolRuntime implements ToolExecutor {
  readonly #tools: ReadonlyMap<string, RuntimeTool>;

  constructor(tools: readonly RuntimeTool[]) {
    const registry = new Map<string, RuntimeTool>();
    for (const tool of tools) {
      if (registry.has(tool.definition.name)) {
        throw new Error(`Duplicate tool registration: ${tool.definition.name}`);
      }
      registry.set(tool.definition.name, tool);
    }
    this.#tools = registry;
  }

  static async readOnly(options: ReadToolOptions): Promise<ToolRuntime> {
    return new ToolRuntime([
      await ReadTool.create(options),
      await GrepTool.create({ workspaceRoot: options.workspaceRoot }),
    ]);
  }

  static async withBash(options: BashRuntimeOptions): Promise<ToolRuntime> {
    const outputStore = await ToolOutputStore.create({
      ...(options.toolOutputRoot === undefined
        ? {}
        : { root: options.toolOutputRoot }),
    });
    const workspaceRoot = await realpath(options.workspaceRoot).catch(
      () => options.workspaceRoot,
    );
    if (isWithin(workspaceRoot, outputStore.rootPath)) {
      throw new ToolOutputStoreConfigurationError(
        "The private tool output store must be outside the workspace.",
      );
    }
    return new ToolRuntime([
      await ReadTool.create({
        workspaceRoot: options.workspaceRoot,
        ...(options.maxReadBytes === undefined
          ? {}
          : { maxReadBytes: options.maxReadBytes }),
        toolOutputStore: outputStore,
      }),
      await GrepTool.create({ workspaceRoot: options.workspaceRoot }),
      await BashTool.create({
        workspaceRoot: options.workspaceRoot,
        outputStore,
      }),
    ]);
  }

  static async withEdit(options: EditRuntimeOptions): Promise<ToolRuntime> {
    const outputStore = await ToolOutputStore.create({
      ...(options.toolOutputRoot === undefined
        ? {}
        : { root: options.toolOutputRoot }),
    });
    const workspaceRoot = await realpath(options.workspaceRoot).catch(
      () => options.workspaceRoot,
    );
    if (isWithin(workspaceRoot, outputStore.rootPath)) {
      throw new ToolOutputStoreConfigurationError(
        "The private tool output store must be outside the workspace.",
      );
    }
    const operationStore = await EditOperationStore.create({
      ...(options.editOperationRoot === undefined
        ? {}
        : { root: options.editOperationRoot }),
    });
    if (isWithin(workspaceRoot, operationStore.rootPath)) {
      throw new EditOperationStoreConfigurationError(
        "The private Edit operation store must be outside the workspace.",
      );
    }
    const fileVersionSecret = createFileVersionSecret();
    return new ToolRuntime([
      await ReadTool.create({
        workspaceRoot: options.workspaceRoot,
        ...(options.maxReadBytes === undefined
          ? {}
          : { maxReadBytes: options.maxReadBytes }),
        toolOutputStore: outputStore,
        fileVersionSecret,
      }),
      await GrepTool.create({ workspaceRoot: options.workspaceRoot }),
      await BashTool.create({
        workspaceRoot: options.workspaceRoot,
        outputStore,
      }),
      await EditTool.create({
        workspaceRoot: options.workspaceRoot,
        fileVersionSecret,
        operationStore,
      }),
    ]);
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  async execute(
    call: ToolCall,
    options: ToolExecutionOptions = {},
  ): Promise<Observation> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return errorObservation(
        call,
        "unknown_tool",
        "The requested tool is not registered in this runtime.",
      );
    }

    let input: unknown;
    try {
      input = JSON.parse(call.rawArguments);
    } catch {
      return errorObservation(
        call,
        "invalid_arguments",
        "Tool arguments must be one complete JSON value.",
      );
    }

    if (tool.prepareApproval !== undefined) {
      let preparation;
      try {
        preparation = await tool.prepareApproval(input, options);
      } catch {
        return errorObservation(
          call,
          "tool_internal_error",
          "The tool failed unexpectedly while preparing approval.",
        );
      }
      if (preparation.status === "error") {
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "error",
          error: preparation.error,
        };
      }
      if (preparation.status === "resolved") {
        return observationFromOutcome(call, preparation.outcome);
      }

      if (options.requestApproval === undefined) {
        return errorObservation(
          call,
          "approval_required",
          "This tool requires explicit user approval before execution.",
        );
      }

      const decision = await options.requestApproval(
        {
          toolCallId: call.id,
          toolName: call.name,
          ...preparation.approval,
        },
        options.signal,
      );
      if (decision === "rejected") {
        if (tool.recordApprovalRejection !== undefined) {
          try {
            const rejectionError = await tool.recordApprovalRejection(
              input,
              options,
            );
            if (rejectionError !== undefined) {
              return {
                toolCallId: call.id,
                toolName: call.name,
                status: "error",
                error: rejectionError,
              };
            }
          } catch {
            return errorObservation(
              call,
              "tool_internal_error",
              "The tool failed unexpectedly while recording rejection.",
            );
          }
        }
        return errorObservation(
          call,
          "approval_rejected",
          "The user rejected this tool execution.",
        );
      }
      if (options.signal?.aborted === true) {
        throw options.signal.reason;
      }
    }

    try {
      const outcome = await tool.execute(input, options);
      return observationFromOutcome(call, outcome);
    } catch {
      return errorObservation(
        call,
        "tool_internal_error",
        "The tool failed unexpectedly.",
      );
    }
  }
}

function observationFromOutcome(
  call: ToolCall,
  outcome: Awaited<ReturnType<RuntimeTool["execute"]>>,
): Observation {
  if (outcome.status === "success") {
    return {
      toolCallId: call.id,
      toolName: call.name,
      status: "success",
      output: outcome.output,
    };
  }
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: "error",
    error: outcome.error,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function errorObservation(
  call: ToolCall,
  code: string,
  message: string,
): Observation {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: "error",
    error: { code, message, retryable: false },
  };
}
