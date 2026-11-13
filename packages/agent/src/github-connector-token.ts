/**
 * The GitHub connector's token, asked of the platform with the user's Abacus
 * key. Its own module (it imports nothing heavy) so the desktop's main
 * process reads it too: the GitHub watcher, beside the agent's GH_TOKEN.
 */
import { abacusV1BaseUrl } from "./abacus-endpoint.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The connector's token for `key`: the token, null when GitHub is not
 * connected, undefined when the platform could not say (keep what is there).
 */
export async function fetchGithubConnectorToken(
  key: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null | undefined> {
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
    // A platform without the endpoint, or a hiccup: unknown.
    if (!response.ok) return undefined;
    answer = (await response.json()) as typeof answer;
  } catch {
    return undefined;
  }
  return answer.connected === true && typeof answer.token === "string"
    ? answer.token
    : null;
}
