import type { ProviderError } from "./provider-error.js";

export interface ProviderRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
}

export interface ProviderRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
};

export function resolveProviderRetryPolicy(
  options: ProviderRetryOptions = {},
): ProviderRetryPolicy {
  const policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...options };

  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("providerRetry.maxAttempts must be a positive integer");
  }
  for (const [name, value] of [
    ["baseDelayMs", policy.baseDelayMs],
    ["maxDelayMs", policy.maxDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`providerRetry.${name} must be a non-negative number`);
    }
  }
  if (
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new RangeError("providerRetry.jitterRatio must be between 0 and 1");
  }

  return policy;
}

export function providerRetryDelayMs(
  error: ProviderError,
  failedAttempt: number,
  policy: ProviderRetryPolicy,
  random: () => number = Math.random,
): number {
  if (
    error.retryAfterMs !== undefined &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs > 0
  ) {
    return Math.min(Math.round(error.retryAfterMs), policy.maxDelayMs);
  }

  const exponential = Math.min(
    policy.baseDelayMs * 2 ** Math.max(failedAttempt - 1, 0),
    policy.maxDelayMs,
  );
  const jitter = exponential * policy.jitterRatio * clampRandom(random());
  return Math.round(Math.min(exponential + jitter, policy.maxDelayMs));
}

export async function waitForProviderRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(finish, delayMs);

    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    }

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
  });
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}
