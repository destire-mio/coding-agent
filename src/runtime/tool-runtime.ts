import type {
  Observation,
  ToolCall,
  ToolDefinition,
  ToolExecutionOptions,
  ToolExecutor,
} from "../core/contracts.js";
import { GrepTool } from "./grep-tool.js";
import { ReadTool, type ReadToolOptions } from "./read-tool.js";
import type { RuntimeTool } from "./tool.js";

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

    try {
      const outcome = await tool.execute(input, options);
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
    } catch {
      return errorObservation(
        call,
        "tool_internal_error",
        "The tool failed unexpectedly.",
      );
    }
  }
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
