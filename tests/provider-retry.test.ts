import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/core/provider-error.js";
import {
  providerRetryDelayMs,
  resolveProviderRetryPolicy,
  waitForProviderRetry,
} from "../src/core/provider-retry.js";

describe("provider retry policy", () => {
  it("uses three visible attempts by default", () => {
    expect(resolveProviderRetryPolicy()).toMatchObject({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterRatio: 0.25,
    });
  });

  it("uses bounded exponential backoff with jitter", () => {
    const policy = resolveProviderRetryPolicy({
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 1_100,
      jitterRatio: 0.25,
    });
    const error = new ProviderError("unavailable", "temporary", {
      retryable: true,
    });

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBe(500);
    expect(providerRetryDelayMs(error, 2, policy, () => 0)).toBe(1_000);
    expect(providerRetryDelayMs(error, 3, policy, () => 1)).toBe(1_100);
  });

  it("honors Retry-After within the local interactive cap", () => {
    const policy = resolveProviderRetryPolicy({ maxDelayMs: 30_000 });
    const short = new ProviderError("rate_limit", "slow down", {
      retryable: true,
      retryAfterMs: 2_000,
    });
    const long = new ProviderError("rate_limit", "slow down", {
      retryable: true,
      retryAfterMs: 90_000,
    });

    expect(providerRetryDelayMs(short, 1, policy)).toBe(2_000);
    expect(providerRetryDelayMs(long, 1, policy)).toBe(30_000);
  });

  it("interrupts backoff immediately when the user cancels", async () => {
    const controller = new AbortController();
    const waiting = waitForProviderRetry(60_000, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
