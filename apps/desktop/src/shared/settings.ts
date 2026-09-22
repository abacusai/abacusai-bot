/**
 * User settings, mirroring `~/.abacusai-bot/config.json`. The agent reads the
 * same file (packages/agent/src/config.ts), so additions must stay compatible.
 */

/** One entry of `customProviders`, as the agent reads it (packages/agent config.ts). */
export interface CustomProviderEntry {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>;
}

export interface AbacusBotSettings {
  /** Last model the user selected. */
  defaultModel?: string;
  /** Provider credentials, keyed by environment-variable name. */
  apiKeys?: Record<string, string>;
  /**
   * Custom OpenAI-compatible endpoints. The user's own entries are never
   * rewritten; the app owns exactly one, `local`, for the models it serves.
   */
  customProviders?: CustomProviderEntry[];
  /**
   * Keyed by the ids in `shared/toolsets.ts`. Only explicitly toggled groups
   * appear; absent ones take the registry default, so a new toolset ships with
   * its intended state for people who already have a config file.
   */
  enabledToolsets?: Record<string, boolean>;
  /** See `shared/exec-backends.ts`. Absent means local. */
  execBackend?: string;
  /** Image used by the Docker backend. Absent means a small Debian base. */
  execDockerImage?: string;
  /**
   * Shell the terminal panel opens, by the ids in `shared/terminal-shells.ts`.
   * Absent means the platform default. Written whenever a shell is picked from
   * the panel's `+` menu, so an automatically opened terminal reopens the last
   * one used.
   */
  terminalShell?: string;
  /**
   * What a session, bot or routine starts in when nothing picks a mode:
   * "YOLO" (Full access, absent means this) or "AUTO" (the same, inside the
   * kernel sandbox). Set on the Profile page.
   */
  defaultMode?: string;
  /**
   * Stored as what the user turned OFF, so a settings file written before this
   * existed reads as "on".
   */
  notificationsDisabled?: boolean;
  /** Absent means on, for the same reason. */
  notificationSoundDisabled?: boolean;
  /**
   * Enable transcript, log, and diagnostic uploads when an Abacus key is stored.
   * Defaults to true. Retained for config compatibility; there is no settings UI.
   * The selected session provider does not affect this check.
   */
  serverDebugSync?: boolean;
}

/**
 * Providers the onboarding panel can collect a key for, and the env var each is
 * stored under. Keyed by provider id to line up with the model catalog.
 * `openai-codex` is absent: it authenticates through a ChatGPT subscription.
 */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  abacus: "ABACUS_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  // The long tail, under the names pi's own env discovery reads, so a stored
  // key lights the provider up with no further wiring.
  baseten: "BASETEN_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  groq: "GROQ_API_KEY",
  huggingface: "HF_TOKEN",
  minimax: "MINIMAX_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  opencode: "OPENCODE_API_KEY",
  together: "TOGETHER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  xai: "XAI_API_KEY",
  // Not a model provider: GH_TOKEN is the name the `gh` CLI reads natively.
  github: "GH_TOKEN",
  zai: "ZAI_API_KEY",
};

/**
 * Whether the Abacus.AI account is one this app can sign out of. Tests the
 * stored key, not whether an Abacus model resolves: a key exported in the
 * environment also lights the provider up, and nothing here can take it back.
 */
export const canSignOutOfAbacus = (
  settings: { apiKeys?: Record<string, string> } | null
): boolean =>
  (settings?.apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? "").trim().length > 0;

/**
 * Whether a pasted string could be an API key at all. A shape check only: the
 * authoritative test is a live call. It catches pasting the wrong thing (a
 * whole `export FOO=...` line, a URL, a fragment); what passes is stored as
 * unverified.
 */
export const isPlausibleApiKey = (value: string): boolean => {
  const key = value.trim();

  if (key.length < 8) return false;
  // Printable ASCII, no spaces: every provider here mints keys out of that set.
  if (!/^[\u0021-\u007E]+$/.test(key)) return false;
  // Same for a pasted shell assignment or a URL from the console address bar.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(key)) return false;
  if (/^https?:\/\//i.test(key)) return false;

  return true;
};

export interface ProviderKeyField {
  provider: string;
  label: string;
  envVar: string;
  /** Where to get one, shown as a link next to the field. */
  signupUrl: string;
  hint: string;
  /**
   * `model` keys appear in the model catalog; `capability` keys (web search,
   * vision) light up individual tools and are checked against stored settings.
   */
  kind: "model" | "capability";
  /** Names the browser sign-in flow the Connect button starts. */
  connect?: "openrouter" | "abacus";
  /** Leads the connect page; the rest sit under "More providers". */
  featured?: boolean;
}

export const PROVIDER_KEY_FIELDS: ProviderKeyField[] = [
  {
    provider: "abacus",
    kind: "model",
    featured: true,
    connect: "abacus",
    label: "Abacus.AI",
    envVar: "ABACUS_API_KEY",
    // The API-keys page, not the `AbacusAIBot=1` sign-in page: that one expects
    // the loopback handshake only abacus-auth-service.ts can mint and refuses
    // without it. Connecting is what the Connect button beside it is for.
    signupUrl: "https://abacus.ai/app/profile/apikey",
    hint: "Hosted models, web search, image generation, and speech generation",
  },
  {
    provider: "deepseek",
    kind: "model",
    featured: true,
    label: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    signupUrl: "https://platform.deepseek.com",
    hint: "DeepSeek chat and reasoning models",
  },
  {
    provider: "anthropic",
    kind: "model",
    featured: true,
    label: "Claude",
    envVar: "ANTHROPIC_API_KEY",
    signupUrl: "https://console.anthropic.com/settings/keys",
    hint: "Claude Sonnet and Opus models",
  },
  {
    provider: "openai",
    kind: "model",
    featured: true,
    label: "OpenAI / Codex",
    envVar: "OPENAI_API_KEY",
    signupUrl: "https://platform.openai.com/api-keys",
    hint: "GPT and Codex models",
  },
  {
    provider: "gemini",
    kind: "model",
    featured: true,
    label: "Google Gemini (AI Studio)",
    envVar: "GEMINI_API_KEY",
    signupUrl: "https://aistudio.google.com/apikey",
    hint: "Gemini models with image and video input",
  },
  {
    provider: "openrouter",
    kind: "model",
    featured: true,
    connect: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    signupUrl: "https://openrouter.ai/keys",
    hint: "Free and paid models through one account",
  },
  // ── The long tail ─────────────────────────────────────────────────────────
  // Every provider pi can drive with nothing but an API key, alphabetically.
  // Providers needing more than one setting (Bedrock, Vertex, Azure) are
  // absent; they still work through the environment (docs/models.md).
  {
    provider: "baseten",
    kind: "model",
    label: "Baseten",
    envVar: "BASETEN_API_KEY",
    signupUrl: "https://app.baseten.co/settings/api_keys",
    hint: "Hosted DeepSeek, Kimi, and GLM models",
  },
  {
    provider: "cerebras",
    kind: "model",
    label: "Cerebras",
    envVar: "CEREBRAS_API_KEY",
    signupUrl: "https://cloud.cerebras.ai",
    hint: "Fast hosted inference for GPT-OSS and GLM models",
  },
  {
    provider: "fireworks",
    kind: "model",
    label: "Fireworks AI",
    envVar: "FIREWORKS_API_KEY",
    signupUrl: "https://app.fireworks.ai/settings/users/api-keys",
    hint: "Hosted inference for open models",
  },
  {
    provider: "groq",
    kind: "model",
    label: "Groq",
    envVar: "GROQ_API_KEY",
    signupUrl: "https://console.groq.com/keys",
    hint: "Fast hosted inference for open models",
  },
  {
    provider: "huggingface",
    kind: "model",
    label: "Hugging Face",
    envVar: "HF_TOKEN",
    signupUrl: "https://huggingface.co/settings/tokens",
    hint: "Inference Providers available through Hugging Face",
  },
  {
    provider: "minimax",
    kind: "model",
    label: "MiniMax",
    envVar: "MINIMAX_API_KEY",
    signupUrl: "https://platform.minimax.io",
    hint: "MiniMax models with long context windows",
  },
  {
    provider: "mistral",
    kind: "model",
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    signupUrl: "https://console.mistral.ai/api-keys",
    hint: "Devstral and Mistral models hosted in the EU",
  },
  {
    provider: "moonshotai",
    kind: "model",
    label: "Moonshot AI",
    envVar: "MOONSHOT_API_KEY",
    signupUrl: "https://platform.moonshot.ai/console/api-keys",
    hint: "Kimi K2.7 Code and Kimi K3",
  },
  {
    provider: "nvidia",
    kind: "model",
    label: "NVIDIA NIM",
    envVar: "NVIDIA_API_KEY",
    signupUrl: "https://build.nvidia.com",
    hint: "Hosted Nemotron and other open models",
  },
  {
    provider: "opencode",
    kind: "model",
    label: "OpenCode Zen",
    envVar: "OPENCODE_API_KEY",
    signupUrl: "https://opencode.ai/zen",
    hint: "Curated coding models behind one key",
  },
  {
    provider: "together",
    kind: "model",
    label: "Together AI",
    envVar: "TOGETHER_API_KEY",
    signupUrl: "https://api.together.ai/settings/api-keys",
    hint: "DeepSeek, Kimi, GLM, and Qwen on one key",
  },
  {
    provider: "vercel-ai-gateway",
    kind: "model",
    label: "Vercel AI Gateway",
    envVar: "AI_GATEWAY_API_KEY",
    signupUrl: "https://vercel.com/ai-gateway",
    hint: "Model access through Vercel AI Gateway",
  },
  {
    provider: "xai",
    kind: "model",
    label: "xAI",
    envVar: "XAI_API_KEY",
    signupUrl: "https://console.x.ai",
    hint: "Grok models for general and coding tasks",
  },
  {
    provider: "zai",
    kind: "model",
    label: "Z.ai",
    envVar: "ZAI_API_KEY",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    hint: "GLM models through the GLM Coding Plan",
  },
  // Web-search keys (Tavily, Exa, Brave, Firecrawl) are absent: an Abacus
  // subscription already covers search. web-providers.ts still reads their env
  // vars directly.
];
