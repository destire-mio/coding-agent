import type {
  ToolApprovalDetails,
  ToolDefinition,
  ToolError,
  ToolExecutionOptions,
} from "../core/contracts.js";

export type ToolOutcome =
  | { readonly status: "success"; readonly output: unknown }
  | { readonly status: "error"; readonly error: ToolError };

export type ToolApprovalPreparation =
  | {
      readonly status: "approval_required";
      readonly approval: ToolApprovalDetails;
    }
  | { readonly status: "resolved"; readonly outcome: ToolOutcome }
  | { readonly status: "error"; readonly error: ToolError };

export interface RuntimeTool {
  readonly definition: ToolDefinition;
  prepareApproval?(
    input: unknown,
    options?: ToolExecutionOptions,
  ): ToolApprovalPreparation | Promise<ToolApprovalPreparation>;
  recordApprovalRejection?(
    input: unknown,
    options?: ToolExecutionOptions,
  ): Promise<ToolError | undefined>;
  execute(input: unknown, options?: ToolExecutionOptions): Promise<ToolOutcome>;
}

export function toolError(
  code: string,
  message: string,
  retryable = false,
  details?: unknown,
): ToolOutcome {
  return {
    status: "error",
    error: {
      code,
      message,
      retryable,
      ...(details === undefined ? {} : { details }),
    },
  };
}
