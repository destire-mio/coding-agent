import type {
  ProviderErrorKind,
  ProviderFailure,
} from "./contracts.js";

export interface ProviderErrorOptions {
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: ProviderErrorOptions,
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

export function asProviderError(
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  if (signal?.aborted === true || isAbortError(error)) {
    return new ProviderError("cancelled", "The provider request was cancelled.", {
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError("unknown", "The provider request failed.", {
    retryable: false,
    cause: error,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      error.constructor?.name === "APIUserAbortError")
  );
}

export function toProviderFailure(
  error: ProviderError,
  attempts: number,
): ProviderFailure {
  return {
    kind: error.kind,
    retryable: error.retryable,
    attempts,
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  };
}
