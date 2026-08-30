import type { ToolDefinition, ToolError } from "../core/contracts.js";

export type ToolOutcome =
  | { readonly status: "success"; readonly output: unknown }
  | { readonly status: "error"; readonly error: ToolError };

export interface RuntimeTool {
  readonly definition: ToolDefinition;
  execute(input: unknown): Promise<ToolOutcome>;
}

export function toolError(
  code: string,
  message: string,
  retryable = false,
): ToolOutcome {
  return { status: "error", error: { code, message, retryable } };
}
