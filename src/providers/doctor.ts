import {
  chat,
  DEFAULT_BIG_MODEL,
  providers,
} from "./index.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactSecrets(message: string): string {
  let redacted = message;
  for (const key of [process.env.GROQ_API_KEY, process.env.OPENROUTER_API_KEY]) {
    if (key !== undefined && key.length >= 6) {
      redacted = redacted.split(key).join("[redacted]");
    }
  }
  return redacted;
}

function ollamaOrigin(): string {
  return new URL(providers.ollama.baseURL).origin;
}

async function checkOllamaServer(): Promise<{
  check: DoctorCheck;
  reachable: boolean;
}> {
  try {
    const response = await fetch(`${ollamaOrigin()}/api/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return {
        check: {
          name: "Ollama server",
          ok: false,
          detail: `HTTP ${response.status}`,
        },
        reachable: false,
      };
    }
    const payload: unknown = await response.json();
    const version =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).version === "string"
        ? ((payload as Record<string, unknown>).version as string)
        : "unknown";
    return {
      check: { name: "Ollama server", ok: true, detail: `v${version}` },
      reachable: true,
    };
  } catch (error) {
    return {
      check: {
        name: "Ollama server",
        ok: false,
        detail: redactSecrets(errorMessage(error)),
      },
      reachable: false,
    };
  }
}

async function checkGemmaInstalled(reachable: boolean): Promise<DoctorCheck> {
  if (!reachable) {
    return {
      name: "gemma4 installed",
      ok: false,
      detail: "skipped: Ollama server unreachable",
    };
  }

  try {
    const response = await fetch(`${ollamaOrigin()}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return {
        name: "gemma4 installed",
        ok: false,
        detail: `HTTP ${response.status}`,
      };
    }

    const payload: unknown = await response.json();
    const models =
      typeof payload === "object" &&
      payload !== null &&
      Array.isArray((payload as Record<string, unknown>).models)
        ? ((payload as Record<string, unknown>).models as unknown[])
        : [];

    const gemma = models
      .map((model) =>
        typeof model === "object" &&
        model !== null &&
        typeof (model as Record<string, unknown>).name === "string"
          ? ((model as Record<string, unknown>).name as string)
          : "",
      )
      .find((name) => name.toLowerCase().startsWith("gemma4"));

    return gemma === undefined
      ? {
          name: "gemma4 installed",
          ok: false,
          detail: "not installed (run: ollama pull gemma4)",
        }
      : { name: "gemma4 installed", ok: true, detail: gemma };
  } catch (error) {
    return {
      name: "gemma4 installed",
      ok: false,
      detail: redactSecrets(errorMessage(error)),
    };
  }
}

async function checkGroqKey(): Promise<DoctorCheck> {
  const key = process.env.GROQ_API_KEY;
  if (key === undefined || key.trim() === "") {
    return {
      name: "Groq API key",
      ok: false,
      detail: "GROQ_API_KEY is not set",
    };
  }

  try {
    const result = await chat(DEFAULT_BIG_MODEL, {
      messages: [{ role: "user", content: "Reply with ok." }],
      maxTokens: 1,
      temperature: 0,
    });
    return {
      name: "Groq API key",
      ok: true,
      detail: `works (${result.latencyMs}ms)`,
    };
  } catch (error) {
    return {
      name: "Groq API key",
      ok: false,
      detail: redactSecrets(errorMessage(error)),
    };
  }
}

function checkOpenRouterKey(): DoctorCheck {
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined || key.trim() === "") {
    return {
      name: "OpenRouter API key",
      ok: false,
      detail: "OPENROUTER_API_KEY is not set",
    };
  }
  return {
    name: "OpenRouter API key",
    ok: true,
    detail: "set (no request sent)",
  };
}

/** Probe the free-tier stack. Never returns or prints key values. */
export async function runDoctor(): Promise<DoctorCheck[]> {
  const ollama = await checkOllamaServer();
  return [
    ollama.check,
    await checkGemmaInstalled(ollama.reachable),
    await checkGroqKey(),
    checkOpenRouterKey(),
  ];
}