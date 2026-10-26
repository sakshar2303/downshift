import { afterEach, describe, expect, it } from "vitest";
import {
  assertModelAllowed,
  chat,
  configureProviders,
  DEFAULT_BIG_MODEL,
  DEFAULT_SMALL_MODEL,
  OPENROUTER_DAILY_LIMIT,
  parseModelRef,
  providers,
} from "../src/providers/index.js";

afterEach(() => {
  configureProviders({ allowPaid: false });
});

describe("parseModelRef", () => {
  it("splits provider from the first colon", () => {
    expect(parseModelRef("groq:openai/gpt-oss-120b")).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-120b",
    });
  });

  it("keeps colons inside the model id", () => {
    expect(parseModelRef("ollama:gemma4:latest")).toEqual({
      provider: "ollama",
      model: "gemma4:latest",
    });
    expect(
      parseModelRef("openrouter:deepseek/deepseek-v4.1-flash:free"),
    ).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash:free",
    });
  });

  it("rejects malformed references", () => {
    expect(() => parseModelRef("gemma4:latest")).toThrow(/Unknown provider/);
    expect(() => parseModelRef("gemma4")).toThrow(/provider:model/);
    expect(() => parseModelRef("groq:")).toThrow(/provider:model/);
    expect(() => parseModelRef(":gemma4")).toThrow(/provider:model/);
    expect(() => parseModelRef("mystery:model")).toThrow(/Unknown provider/);
  });

  it("keeps the documented defaults parseable", () => {
    expect(parseModelRef(DEFAULT_SMALL_MODEL).model).toBe("gemma4:latest");
    expect(parseModelRef(DEFAULT_BIG_MODEL).model).toBe("openai/gpt-oss-120b");
  });
});

describe("OpenRouter free guard", () => {
  it("allows :free models", () => {
    expect(() =>
      assertModelAllowed("openrouter:deepseek/deepseek-v4.1-flash:free"),
    ).not.toThrow();
  });

  it("refuses paid models by default with a clear message", () => {
    expect(() =>
      assertModelAllowed("openrouter:anthropic/claude-sonnet-4.5"),
    ).toThrow(/Refusing paid OpenRouter model.*--allow-paid/);
  });

  it("allows paid models only when explicitly opted in", () => {
    expect(() =>
      assertModelAllowed("openrouter:anthropic/claude-sonnet-4.5", {
        allowPaid: true,
      }),
    ).not.toThrow();
  });

  it("honours the process-wide --allow-paid setting", () => {
    configureProviders({ allowPaid: true });
    expect(() =>
      assertModelAllowed("openrouter:anthropic/claude-sonnet-4.5"),
    ).not.toThrow();
  });

  it("does not affect non-OpenRouter providers", () => {
    expect(() =>
      assertModelAllowed("groq:openai/gpt-oss-120b"),
    ).not.toThrow();
    expect(() => assertModelAllowed("ollama:gemma4:latest")).not.toThrow();
  });

  it("stops chat before any network or key lookup", async () => {
    await expect(
      chat("openrouter:anthropic/claude-sonnet-4.5", {
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/--allow-paid/);
  });
});

describe("provider registry", () => {
  it("describes the Ollama local provider", () => {
    expect(providers.ollama).toMatchObject({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
      maxContextTokens: 16_000,
      concurrency: 1,
      priceUsdPerToken: 0,
      defaultModel: "gemma4:latest",
    });
  });

  it("describes the Groq free tier", () => {
    expect(providers.groq).toMatchObject({
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      maxContextTokens: 6_000,
      priceUsdPerToken: 0,
      defaultModel: "openai/gpt-oss-120b",
      limits: { requestsPerMinute: 25, tokensPerMinute: 7_000 },
    });
  });

  it("describes the OpenRouter free tier and headers", () => {
    expect(providers.openrouter).toMatchObject({
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      maxContextTokens: 24_000,
      priceUsdPerToken: 0,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/sakshar2303/downshift",
        "X-Title": "Downshift",
      },
      limits: { requestsPerMinute: 15, dailyRequests: 45 },
    });
    expect(OPENROUTER_DAILY_LIMIT).toBe(45);
  });

  it("exports the documented default models", () => {
    expect(DEFAULT_SMALL_MODEL).toBe("ollama:gemma4:latest");
    expect(DEFAULT_BIG_MODEL).toBe("groq:openai/gpt-oss-120b");
  });
});