import os from "os";
import path from "path";

/**
 * Where AbacusAI Bot keeps everything: `~/.abacusai-bot/`. Config, credentials,
 * the model catalog, skills and session state live under this one folder.
 * `ABACUSAI_BOT_HOME` overrides it, which is how tests get an isolated
 * directory. The agent subprocess computes the same path independently in
 * packages/agent/src/config.ts; the two must stay in step.
 */
export const ABACUSAI_BOT_DIR_NAME = ".abacusai-bot";

/**
 * Per-project directory: `<workspace>/.abacusai-bot/`, for skills, plans and
 * scratch files. Matches what the agent scans (packages/agent/src/config.ts).
 */
export const WORKSPACE_DIR_NAME = ".abacusai-bot";

export const abacusBotHome = (): string =>
  process.env.ABACUSAI_BOT_HOME ||
  path.join(os.homedir(), ABACUSAI_BOT_DIR_NAME);

/**
 * Where a bot works when nobody said where. A bot that reads mail or watches a
 * Slack has no repository, but pointing it at the user's home would grant it
 * everything the user owns; a directory under the app's own home is per
 * profile and needs nobody's permission. An explicit project still wins.
 */
export const botDefaultWorkspace = (): string =>
  path.join(abacusBotHome(), "bot-home");

/**
 * The folder a session lands in when the user never picked one. Made on first
 * send, offered in the workspace picker as "Auto workspace", never asked about.
 */
export const sessionDefaultWorkspace = (): string =>
  path.join(abacusBotHome(), "session-home");

/**
 * The temp area the app admits files from. `os.tmpdir()` is per-user on macOS
 * and Windows but `/tmp` on Linux, shared with every local account; it is still
 * the right root (the agent puts scratch files there), so local-open-guard
 * narrows it by file ownership instead of inventing a directory of our own.
 */
export const userTempDir = (): string => os.tmpdir();
