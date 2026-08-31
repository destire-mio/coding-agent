import OpenAI, { type APIError } from "openai";
import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/core/provider-error.js";
import type { ProviderConfig } from "../src/provider/config.js";
import {
  buildOpenAIClientOptions,
  normalizeOpenAICompatibleError,
} from "../src/provider/openai-compatible-provider.js";

describe("OpenAI-compatible provider errors", () => {
  it("disables hidden SDK retries so Core owns the attempt budget", () => {
    const config: ProviderConfig = {
      apiKey: "not-sent-by-this-test",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      thinking: "enabled",
    };

    expect(buildOpenAIClientOptions(config)).toMatchObject({
      maxRetries: 0,
      timeout: 60_000,
    });
  });

  it("classifies authentication as non-retryable", () => {
    const error = normalizeOpenAICompatibleError(
      statusError(401, "invalid api key"),
    );

    expect(error).toMatchObject({
      kind: "authentication",
      retryable: false,
      statusCode: 401,
    });
  });

  it("classifies rate limits as retryable and keeps Retry-After", () => {
    const error = normalizeOpenAICompatibleError(
      statusError(429, "too many requests", {
        "retry-after": "2",
        "x-request-id": "req-rate-limit",
      }),
    );

    expect(error).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      retryAfterMs: 2_000,
      requestId: "req-rate-limit",
      statusCode: 429,
    });
  });

  it("does not retry a 429 caused by exhausted quota", () => {
    const error = normalizeOpenAICompatibleError(
      statusError(429, "insufficient balance; please recharge"),
    );

    expect(error).toMatchObject({
      kind: "quota_exhausted",
      retryable: false,
      statusCode: 429,
    });
  });

  it("classifies timeout and 5xx failures as retryable", () => {
    expect(
      normalizeOpenAICompatibleError(
        new OpenAI.APIConnectionTimeoutError(),
      ),
    ).toMatchObject({ kind: "timeout", retryable: true });
    expect(
      normalizeOpenAICompatibleError(statusError(503, "provider unavailable")),
    ).toMatchObject({
      kind: "unavailable",
      retryable: true,
      statusCode: 503,
    });
  });

  it("classifies user abort as cancelled and non-retryable", () => {
    expect(
      normalizeOpenAICompatibleError(new OpenAI.APIUserAbortError()),
    ).toMatchObject({ kind: "cancelled", retryable: false });
  });

  it("lets an active user cancellation override a simultaneous retryable error", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      normalizeOpenAICompatibleError(
        new ProviderError("interrupted", "stream closed", { retryable: true }),
        controller.signal,
      ),
    ).toMatchObject({ kind: "cancelled", retryable: false });
  });
});

function statusError(
  status: number,
  message: string,
  headers: HeadersInit = {},
): APIError {
  return OpenAI.APIError.generate(
    status,
    { error: { message } },
    undefined,
    new Headers(headers),
  );
}
