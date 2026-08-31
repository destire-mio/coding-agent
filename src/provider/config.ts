export interface ProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly thinking: "enabled";
}

export class ConfigurationError extends Error {}

export function loadProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const apiKey =
    environment.DEEPSEEK_API_KEY?.trim() ||
    environment.CODING_AGENT_API_KEY?.trim();
  const model = environment.CODING_AGENT_MODEL?.trim() || "deepseek-v4-flash";
  const baseURL =
    environment.CODING_AGENT_BASE_URL?.trim() || "https://api.deepseek.com";

  if (!apiKey) {
    throw new ConfigurationError(
      "Missing provider configuration: DEEPSEEK_API_KEY.",
    );
  }

  let parsedBaseURL: URL;
  try {
    parsedBaseURL = new URL(baseURL);
  } catch {
    throw new ConfigurationError("CODING_AGENT_BASE_URL must be a valid URL.");
  }
  if (parsedBaseURL.protocol !== "https:" && parsedBaseURL.protocol !== "http:") {
    throw new ConfigurationError(
      "CODING_AGENT_BASE_URL must use http or https.",
    );
  }

  return {
    apiKey,
    model,
    baseURL: parsedBaseURL.toString().replace(/\/$/, ""),
    thinking: "enabled",
  };
}
