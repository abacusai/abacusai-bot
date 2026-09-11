/**
 * Looking at images and video through a provider the user already has a key
 * for; no separate vision vendor. A separate call rather than the main
 * conversation: the answer is usually a sentence, and a megabyte of image in
 * the transcript would cost context on every later turn.
 */
import { credentialFor } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { readAsBase64 } from "./generated-files";

interface AnalysisProvider {
  id: string;
  envVar: string;
  /** Video needs a model that accepts it; not every vision model does. */
  supportsVideo: boolean;
  analyze: (
    source: string,
    prompt: string,
    kind: "image" | "video"
  ) => Promise<string>;
}

// Environment first, then Settings → API keys: a Finder launch has an empty
// environment (see credentialFor).
const env = (name: string): string => credentialFor(name);

const asText = (
  body: unknown,
  extract: (value: never) => string | undefined
): string => {
  const text = extract(body as never);

  return text != null && text.trim().length > 0
    ? text
    : "The model returned nothing.";
};

const post = async (
  url: string,
  headers: Record<string, string>,
  payload: unknown
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      // The provider's message names the actual problem; the status line does
      // not.
      throw new Error(
        `${response.status} ${response.statusText}: ${(await response.text()).slice(0, 400)}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const anthropic: AnalysisProvider = {
  id: "anthropic",
  envVar: "ANTHROPIC_API_KEY",
  supportsVideo: false,
  analyze: async (source, prompt) => {
    const { base64, mediaType } = await readAsBase64(source);
    const body = await post(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": env("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
      },
      {
        model: env("ABACUSAI_BOT_VISION_MODEL") || "claude-sonnet-5",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }
    );

    return asText(body, (value: { content?: Array<{ text?: string }> }) =>
      (value.content ?? []).map((block) => block.text ?? "").join("\n")
    );
  },
};

const openaiCompatible = (
  id: string,
  envVar: string,
  url: string,
  defaultModel: string
): AnalysisProvider => ({
  id,
  envVar,
  supportsVideo: false,
  analyze: async (source, prompt) => {
    const { base64, mediaType } = await readAsBase64(source);
    const body = await post(
      url,
      { Authorization: `Bearer ${env(envVar)}` },
      {
        model: env("ABACUSAI_BOT_VISION_MODEL") || defaultModel,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${mediaType};base64,${base64}` },
              },
            ],
          },
        ],
      }
    );

    return asText(
      body,
      (value: { choices?: Array<{ message?: { content?: string } }> }) =>
        value.choices?.[0]?.message?.content
    );
  },
});

/** The only provider here that accepts video. */
const gemini: AnalysisProvider = {
  id: "gemini",
  envVar: "GEMINI_API_KEY",
  supportsVideo: true,
  analyze: async (source, prompt) => {
    const { base64, mediaType } = await readAsBase64(source);
    const model = env("ABACUSAI_BOT_VISION_MODEL") || "gemini-3.5-flash-lite";
    const body = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env("GEMINI_API_KEY")}`,
      {},
      {
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mediaType, data: base64 } },
              { text: prompt },
            ],
          },
        ],
      }
    );

    return asText(
      body,
      (value: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }) =>
        (value.candidates?.[0]?.content?.parts ?? [])
          .map((part) => part.text ?? "")
          .join("\n")
    );
  },
};

const PROVIDERS: AnalysisProvider[] = [
  anthropic,
  openaiCompatible(
    "openai",
    "OPENAI_API_KEY",
    "https://api.openai.com/v1/chat/completions",
    "gpt-5.6-luna"
  ),
  openaiCompatible(
    "openrouter",
    "OPENROUTER_API_KEY",
    "https://openrouter.ai/api/v1/chat/completions",
    "google/gemini-3.5-flash-lite"
  ),
  gemini,
  // Last on purpose: a dedicated vision key above wins, but an Abacus-only
  // account still gets working eyes through RouteLLM.
  openaiCompatible(
    "abacus",
    "ABACUS_API_KEY",
    `${abacusRoutellmV1()}/chat/completions`,
    "route-llm"
  ),
];

const configured = (provider: AnalysisProvider): boolean =>
  env(provider.envVar).length > 0;

export interface AnalysisOutcome {
  /** The provider that actually answered, or null when none is configured. */
  provider: string | null;
  /** The answer, or setup guidance when `provider` is null. */
  answer: string;
}

export const analyze = async (
  source: string,
  prompt: string,
  kind: "image" | "video"
): Promise<AnalysisOutcome> => {
  const usable = PROVIDERS.filter(
    (provider) =>
      configured(provider) && (kind === "image" || provider.supportsVideo)
  );

  if (usable.length === 0) {
    const wanted = PROVIDERS.filter(
      (entry) => kind === "image" || entry.supportsVideo
    )
      .map((entry) => entry.envVar)
      .join(", ");

    // Video failing when images work is worth spelling out.
    const note =
      kind === "video" && PROVIDERS.some(configured)
        ? " Your configured provider can analyse images but not video."
        : "";

    return {
      provider: null,
      answer:
        `No provider is configured for ${kind} analysis.${note} The user can add one of these keys in ` +
        `Settings → API keys (or the environment): ${wanted}. Verify another way, or tell the user ` +
        "visual checking is unavailable.",
    };
  }

  // A failing provider falls through to the next configured one; the error
  // surfaces only when every one has failed, naming each attempt.
  const failures: string[] = [];

  for (const provider of usable) {
    try {
      return {
        provider: provider.id,
        answer: await provider.analyze(source, prompt, kind),
      };
    } catch (error) {
      failures.push(
        `${provider.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new Error(
    `Every configured ${kind} analysis provider failed. ${failures.join("; ")}`
  );
};

/** Which provider a call would use, so the tool can say so in its result. */
export const analysisProviderId = (kind: "image" | "video"): string | null =>
  PROVIDERS.find(
    (provider) =>
      configured(provider) && (kind === "image" || provider.supportsVideo)
  )?.id ?? null;
