/**
 * Environment variables handed to a spawning agent process: credentials,
 * feature flags, and settings resolved on the desktop side.
 */
import { excludedBuiltinTools, isToolsetEnabled } from "#shared/toolsets";

import { memorySnapshot } from "../agent-tools/memory-store";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { resolveBackend } from "../providers/exec-backend-service";
import {
  credentialEnv,
  hasCredential,
  readDockerImage,
  readExecBackend,
  readToolsetPreferences,
  readXaiSearchEnabled,
} from "./settings";

/**
 * Credentials handed to the agent process: the user's own provider keys from
 * ~/.abacusai-bot/config.json. A key already in the environment is left
 * alone, so a shell-exported key wins over a stored one.
 */
export function buildAgentAuthEnv(): Record<string, string> {
  return credentialEnv();
}

/** Everything besides auth and the MCP config path — see the call site. */
export function buildAgentConfigEnv(
  runtimeMcpPath: string | null
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (runtimeMcpPath != null) {
    // Built-in browser and device servers plus the user's own.
    envVars.ABACUSAI_BOT_MCP_CONFIG = runtimeMcpPath;
  }

  // Resolved here so the dev-host override is validated in exactly one place
  // (services/abacus-host).
  envVars.ABACUSAI_BOT_ABACUS_V1 = abacusRoutellmV1();

  // Decides which of the two X search tools the agent keeps; the choice lives
  // in Settings, which the agent cannot read.
  if (readXaiSearchEnabled() && hasCredential("XAI_API_KEY")) {
    envVars.ABACUSAI_BOT_XAI_SEARCH = "1";
  }

  // Toolsets the user switched off in Capabilities. Resolved here because
  // this process owns both the registry and the settings file.
  const preferences = readToolsetPreferences();
  const excluded = excludedBuiltinTools(preferences);
  if (excluded.length > 0) {
    envVars.ABACUSAI_BOT_EXCLUDED_TOOLS = excluded.join(",");
  }

  // Memory frozen at spawn rather than read live, so the system prompt stays
  // byte-identical for the session and the provider's prefix cache survives
  // memory writes.
  if (isToolsetEnabled("memory", preferences)) {
    const snapshot = memorySnapshot();
    if (snapshot != null) {
      envVars.ABACUSAI_BOT_MEMORY_SNAPSHOT = snapshot;
    }
  }

  // Where `bash` runs. Resolved rather than passed through so a stored choice
  // whose backend became unusable falls back to local.
  const backend = resolveBackend(readExecBackend());
  if (backend !== "local") {
    envVars.ABACUSAI_BOT_EXEC_BACKEND = backend;
    const image = readDockerImage();
    if (backend === "docker" && image != null) {
      envVars.ABACUSAI_BOT_DOCKER_IMAGE = image;
    }
  }

  return envVars;
}
