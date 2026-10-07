/**
 * The GitHub token from the bot's GitHub connector (a one-tap sign-in that acts
 * as the user), kept in this process's environment as GH_TOKEN the way a
 * stored key is, so `gh` and git in every shell use it and the GitHub prompt
 * names it. Asked for at start, on every credentials refresh and every few
 * minutes; held in memory only. A connection replaces a token pasted on the
 * card; disconnecting hands GH_TOKEN back to it.
 */
import { abacusV1BaseUrl } from "./abacus-endpoint.js";
import { applyStoredApiKeys } from "./config.js";

const REFRESH_EVERY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** The token this module put in GH_TOKEN, so it never clears one it did not set. */
let held: string | null = null;

export async function refreshGithubToken(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const key = (env.ABACUS_API_KEY ?? "").trim();
  if (key.length === 0) return;
  let answer: { connected?: unknown; token?: unknown };
  try {
    const response = await fetch(
      `${abacusV1BaseUrl(env)}/abacusaibot_github_token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "user-agent": "abacusai-bot",
        },
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    // A platform without the endpoint, or a hiccup: keep what is there.
    if (!response.ok) return;
    answer = (await response.json()) as typeof answer;
  } catch {
    return;
  }
  if (answer.connected === true && typeof answer.token === "string") {
    held = answer.token;
    env.GH_TOKEN = answer.token;
    return;
  }
  if (held != null && env.GH_TOKEN === held) {
    delete env.GH_TOKEN;
    // A token pasted on the card, if there is one, is GitHub again.
    applyStoredApiKeys(env);
  }
  held = null;
}

/** Keep GH_TOKEN current for this process's life; returns a stop. */
export function followGithubToken(): () => void {
  void refreshGithubToken();
  const timer = setInterval(() => void refreshGithubToken(), REFRESH_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
