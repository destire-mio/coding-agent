import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadProviderConfig,
} from "../src/provider/config.js";

describe("provider configuration", () => {
  it("fails closed when credentials are missing", () => {
    expect(() => loadProviderConfig({})).toThrow(ConfigurationError);
  });

  it("loads provider-neutral OpenAI-compatible settings", () => {
    expect(
      loadProviderConfig({
        DEEPSEEK_API_KEY: "test-key",
      }),
    ).toEqual({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      thinking: "enabled",
    });
  });

  it("allows explicit model and base URL overrides", () => {
    expect(
      loadProviderConfig({
        DEEPSEEK_API_KEY: "test-key",
        CODING_AGENT_MODEL: "deepseek-v4-pro",
        CODING_AGENT_BASE_URL: "https://provider.example/v1/",
      }),
    ).toEqual({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      baseURL: "https://provider.example/v1",
      thinking: "enabled",
    });
  });
});
