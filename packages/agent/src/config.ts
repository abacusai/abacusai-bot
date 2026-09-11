/**
 * AbacusAIBot's on-disk config: `~/.abacusai-bot/config.json`. Small and
 * hand-editable. API keys may live here, but the environment always wins, so a
 * shell profile or secrets manager can supply a key without it reaching disk.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CustomProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** An OpenAI-compatible endpoint: llama.cpp, vLLM, Ollama, LiteLLM, an OSS router. */
export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: CustomProviderModel[];
}

/**
 * The model a session starts on, per provider: each provider's cheap, fast
 * driver, because the harness carries quality here rather than the model tier.
 * Ordered; the order is the tie-break when someone has several keys. DeepSeek
 * V4 Flash leads because the guardrails were tuned and measured against it.
 */
export const PROVIDER_DEFAULTS: ReadonlyArray<{
  envVar: string;
  model: string;
}> = [
  { envVar: "DEEPSEEK_API_KEY", model: "deepseek/deepseek-v4-flash" },
  // OpenLLM, not the code router directly: the pool holds the same cheap
  // drivers and any free key added later widens it without another default.
  { envVar: "ABACUS_API_KEY", model: "openllm/auto" },
  { envVar: "ANTHROPIC_API_KEY", model: "anthropic/claude-haiku-4-5" },
  { envVar: "OPENAI_API_KEY", model: "openai/gpt-5.6-luna" },
  // OpenLLM rather than one model: these keys live on the free tier, where any
  // single model rate-limits (openllm.ts). A literal, not OPENLLM_ID: importing
  // openllm.ts here closes a cycle that breaks the declaration bundle.
  { envVar: "OPENROUTER_API_KEY", model: "openllm/auto" },
  { envVar: "GEMINI_API_KEY", model: "openllm/auto" },
  // The long tail, after the majors; ids verified against pi's catalog.
  { envVar: "GROQ_API_KEY", model: "groq/openai/gpt-oss-120b" },
  { envVar: "CEREBRAS_API_KEY", model: "cerebras/gpt-oss-120b" },
  { envVar: "XAI_API_KEY", model: "xai/grok-build-0.1" },
  { envVar: "MISTRAL_API_KEY", model: "mistral/devstral-medium-latest" },
  { envVar: "MINIMAX_API_KEY", model: "minimax/MiniMax-M3" },
  { envVar: "MOONSHOT_API_KEY", model: "moonshotai/kimi-k2.7-code" },
  { envVar: "ZAI_API_KEY", model: "zai/glm-5.2" },
  {
    envVar: "TOGETHER_API_KEY",
    model: "together/deepseek-ai/DeepSeek-V4-Flash-0731",
  },
  {
    envVar: "FIREWORKS_API_KEY",
    model: "fireworks/accounts/fireworks/models/deepseek-v4-flash",
  },
  {
    envVar: "BASETEN_API_KEY",
    model: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
  },
  { envVar: "HF_TOKEN", model: "huggingface/deepseek-ai/DeepSeek-V4-Flash" },
  {
    envVar: "NVIDIA_API_KEY",
    model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
  },
  {
    envVar: "AI_GATEWAY_API_KEY",
    model: "vercel-ai-gateway/deepseek/deepseek-v4-flash",
  },
  { envVar: "OPENCODE_API_KEY", model: "opencode/deepseek-v4-flash" },
];

/** A name to print when no provider is configured; nothing selects it. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/**
 * What a session starts on when nothing was asked for. Null rather than a guess
 * when no provider is configured, so both front ends can say "configure a
 * model first" instead of failing on the first token.
 */
export const defaultModelFor = (
  env: NodeJS.ProcessEnv = process.env
): string | null => {
  const configured = PROVIDER_DEFAULTS.find(
    (entry) => (env[entry.envVar] ?? "").trim().length > 0
  );

  return configured?.model ?? null;
};

export interface AbacusBotConfig {
  /** Model reference used when a session starts without an explicit one. */
  defaultModel?: string;
  /**
   * Browser sub-agent model; `ABACUSAI_BOT_BROWSER_MODEL` overrides, unset
   * means the chat's.
   */
  browserModel?: string;
  customProviders?: CustomProviderConfig[];
  /** Bash commands auto-approved without prompting, as literal prefixes. */
  allowedCommands?: string[];
  /** Extra directories the agent may read outside the workspace. */
  allowedReadPaths?: string[];
  /**
   * Output-token ceiling per request; raise it if a model is cut off mid-
   * answer.
   */
  maxOutputTokens?: number;
  /** Provider credentials keyed by environment variable name. */
  apiKeys?: Record<string, string>;
}

/** Environment variable names, so a stray config key can't become one. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The key each provider is stored under. Mirrors PROVIDER_ENV_VARS in the
 * desktop's shared settings — this package cannot import from the app's source
 * tree, the same split `abacusBotDir` lives with. Only providers pi discovers
 * from the environment: gemini and abacus register themselves, and `github` is
 * not a model provider.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
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
  zai: "ZAI_API_KEY",
};

/**
 * Put the keys stored on disk into the environment, so the terminal client sees
 * the keys the desktop saved to `apiKeys`. The environment still wins: only
 * absent or empty names are filled. Returns the names it set, for tests.
 */
export function applyStoredApiKeys(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const stored = loadConfig().apiKeys;

  if (stored == null || typeof stored !== "object") return [];

  const applied: string[] = [];

  for (const [name, value] of Object.entries(stored)) {
    if (!ENV_NAME.test(name)) continue;
    if (typeof value !== "string") continue;

    const key = value.trim();

    if (key.length === 0) continue;
    if ((env[name] ?? "").trim().length > 0) continue;

    env[name] = key;
    applied.push(name);
  }

  return applied;
}

export function abacusBotDir(): string {
  // Must match ABACUSAI_BOT_DIR_NAME in apps/desktop/src/main/paths.ts, which
  // this package can't import.
  return (
    process.env.ABACUSAI_BOT_HOME || path.join(os.homedir(), ".abacusai-bot")
  );
}

export function agentDir(): string {
  return path.join(abacusBotDir(), "agent");
}

/**
 * The MCP server list when nobody handed us one (the desktop passes
 * `ABACUSAI_BOT_MCP_CONFIG`; a terminal run has no such file). Reads the user's
 * servers from `mcp-code.json`, falling back to the older `mcp.json`; OAuth
 * records in `mcp-auth.json` attach on their own. Null when nothing is there.
 */
export function desktopMcpConfigPath(): string | null {
  for (const name of ["mcp-code.json", "mcp.json"]) {
    const candidate = path.join(abacusBotDir(), name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there, or not readable — try the next name.
    }
  }

  return null;
}

export function configPath(): string {
  return path.join(abacusBotDir(), "config.json");
}

export function loadConfig(): AbacusBotConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);

    return parsed && typeof parsed === "object"
      ? (parsed as AbacusBotConfig)
      : {};
  } catch {
    // No config, or a corrupt one: env-var keys alone are enough to run.
    return {};
  }
}

export function saveConfig(config: AbacusBotConfig): void {
  fs.mkdirSync(abacusBotDir(), { recursive: true });
  fs.writeFileSync(
    configPath(),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
}

export function accountPath(): string {
  return path.join(abacusBotDir(), "account.json");
}

/**
 * What the app knows about the person on the other end (`account.json`, written
 * at onboarding), as a prompt fragment; undefined when both halves are absent.
 * Facts only, no instruction to greet: this sits in the system prompt, which is
 * identical on every turn, so "greet once" cannot be enforced from here and
 * comes out as a greeting before every tool call.
 */
export function userProfilePrompt(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountPath(), "utf8")) as {
      account?: { username?: string } | null;
      apps?: Array<{ name?: string }>;
    };

    const name = parsed.account?.username?.trim();
    const apps = (parsed.apps ?? [])
      .map((app) => app?.name?.trim())
      .filter((label): label is string => label != null && label.length > 0);

    const hasName = name != null && name.length > 0;
    const appList = apps.join(", ");
    const lines: string[] = [];

    if (hasName) {
      lines.push(`The person you are working with is called ${name}.`);
    }

    if (apps.length > 0) {
      lines.push(`They have said they work day to day with: ${appList}.`);
    }

    if (lines.length === 0) return undefined;

    lines.push(
      'This is background, not something to announce. Do not open replies by restating their name or their tools, and never let it displace what they actually asked for. Bring this up only where it is genuinely relevant, and remember that an app they told us they use is not by itself something you are connected to — what you are connected to is stated separately, under "Connected services".'
    );

    return lines.join("\n\n");
  } catch {
    // No account file, or an unreadable one. The agent is fine without it.
    return undefined;
  }
}

/**
 * The two skill directories, named, so `skill_add` can say which one it wrote
 * to without indexing into a list whose order may change.
 */
export function skillDirsByScope(cwd: string): {
  project: string;
  global: string;
} {
  return {
    project: path.join(cwd, ".abacusai-bot", "skills"),
    global: path.join(abacusBotDir(), "skills"),
  };
}

/** Skill directories, workspace-local first so a project can override a global skill. */
export function skillDirs(cwd: string): string[] {
  const dirs = skillDirsByScope(cwd);

  return [dirs.project, dirs.global];
}
