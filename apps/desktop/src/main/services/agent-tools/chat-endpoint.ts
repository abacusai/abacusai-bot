/**
 * Which OpenAI-compatible chat/completions endpoint the document components
 * (pdf, ppt, design) write with. First preference is the main agent's picked
 * model when its provider can be driven directly with a key; otherwise the
 * first provider in a fixed quality order whose key exists. Model choice has
 * one home, the picker: no per-component override env vars.
 */
import { credentialFor, readSettings } from "../config/settings";

export interface ChatEndpoint {
  /** OpenAI-compatible chat/completions URL. */
  url: string;
  key: string;
  /** Model id in the resolved provider's own naming. */
  model: string;
  /** False for Anthropic: Claude 5 models 400 on `temperature`, so it is omitted. */
  supportsTemperature: boolean;
  /**
   * Whether `response_format: json_object` is honored. Anthropic's layer
   * ignores it, so JSON components rely on prompt and validation there.
   */
  supportsJsonMode: boolean;
}

const CHAT_PROVIDERS = [
  {
    provider: "abacus",
    envVar: "ABACUS_API_KEY",
    url: "https://routellm.abacus.ai/v1/chat/completions",
    defaultModel: "claude-haiku-4-5-20251001",
    // Serves Claude models, so the Anthropic caveats apply.
    supportsTemperature: false,
    supportsJsonMode: false,
  },
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/chat/completions",
    defaultModel: "claude-haiku-4-5",
    supportsTemperature: false,
    supportsJsonMode: false,
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-5.6-luna",
    supportsTemperature: true,
    supportsJsonMode: true,
  },
  {
    provider: "gemini",
    envVar: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-3.5-flash-lite",
    supportsTemperature: true,
    supportsJsonMode: true,
  },
  {
    provider: "deepseek",
    envVar: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-v4-flash",
    supportsTemperature: true,
    supportsJsonMode: true,
  },
  {
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "deepseek/deepseek-v4-flash",
    supportsTemperature: true,
    supportsJsonMode: true,
  },
] as const;

/**
 * The main agent's picked model, when its provider is ours and keyed. The id
 * is `provider/model-id`; OpenRouter model ids legitimately contain slashes.
 */
const topAgentEndpoint = (): ChatEndpoint | null => {
  const chosen = (readSettings().defaultModel ?? "").trim();
  const slash = chosen.indexOf("/");

  if (slash <= 0 || slash === chosen.length - 1) return null;

  const provider = CHAT_PROVIDERS.find(
    (entry) => entry.provider === chosen.slice(0, slash)
  );

  if (provider == null) return null;

  const key = credentialFor(provider.envVar);

  if (key.length === 0) return null;

  const { url, supportsTemperature, supportsJsonMode } = provider;

  return {
    url,
    key,
    model: chosen.slice(slash + 1),
    supportsTemperature,
    supportsJsonMode,
  };
};

/** @param purpose  Starts the error sentence: "Writing a document", "Building a deck". */
export const resolveChatEndpoint = (purpose: string): ChatEndpoint => {
  const top = topAgentEndpoint();

  if (top != null) return top;

  for (const provider of CHAT_PROVIDERS) {
    const key = credentialFor(provider.envVar);

    if (key.length > 0) {
      const { url, defaultModel, supportsTemperature, supportsJsonMode } =
        provider;

      return {
        url,
        key,
        model: defaultModel,
        supportsTemperature,
        supportsJsonMode,
      };
    }
  }

  // Read by the model as a tool error, so it steers away from improvising.
  const accepted = CHAT_PROVIDERS.map((provider) => provider.envVar).join(", ");
  throw new Error(
    `${purpose} needs a model provider key. The user can add one in Settings → API keys — any of ` +
      `${accepted} works, in the environment or the store. ` +
      "Until then this tool is unavailable: tell the user exactly what is missing and ask how they " +
      "want to proceed — do not improvise a replacement pipeline."
  );
};
