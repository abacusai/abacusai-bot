/**
 * Where the Abacus.AI sign-in and RouteLLM serving hosts resolve to.
 *
 * `ABACUSAI_BOT_ABACUS_HOST` is a developer override for preprod. The value
 * feeds `shell.openExternal` and the request carrying `ABACUS_API_KEY`, so it
 * is honored only in an unpackaged build or a test build (a `-test.` version),
 * over https, for an `*.abacus.ai` host; anything else silently falls back to
 * production.
 */
import { app } from "electron";

const DEFAULT_APP_HOST = "https://apps.abacus.ai";

/**
 * The User-Agent for every main-process request to an Abacus host. Cloudflare
 * 403s Node's default agent (error 1010); Electron's Chromium UA is what every
 * app window sends. The constant stands in when `app` is absent (tests).
 */
export const abacusUserAgent = (): string => {
  try {
    const ua = app.userAgentFallback;
    if (typeof ua === "string" && ua.length > 0) return ua;
  } catch {
    // Fall through to the constant.
  }
  return (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  );
};
const DEFAULT_ROUTELLM_V1 = "https://routellm.abacus.ai/v1";

/** Test builds carry a `-test.<run>` version; releases never do. */
export const isTestBuild = (version: string = app.getVersion()): boolean =>
  /-test\./.test(version);

const overrideHost = (): URL | null => {
  const raw = (process.env.ABACUSAI_BOT_ABACUS_HOST ?? "").trim();

  // Powerless in a released build: an env var an attacker can set must not
  // redirect a signed app's sign-in or key-bearing requests. A test build is
  // packaged too, but exists to be pointed at preprod, so it may read it.
  if (
    raw.length === 0 ||
    (import.meta.env.ABACUS_WEB_HOST !== true &&
      app.isPackaged &&
      !isTestBuild())
  )
    return null;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    if (url.protocol !== "https:") return null;
    if (host !== "abacus.ai" && !host.endsWith(".abacus.ai")) return null;

    return url;
  } catch {
    return null;
  }
};

/**
 * Origin of the RouteLLM host, for surfaces off its root rather than /v1
 * (the web search proxy, the service proxies at /api/services/*).
 */

/** Origin of the sign-in / connect pages (apps.abacus.ai in production). */
/** Whether the app is pointed away from production (see the override above). */
export const isHostOverridden = (): boolean => overrideHost() != null;

export const abacusAppHost = (): string => {
  const url = overrideHost();

  return url != null ? url.origin : DEFAULT_APP_HOST;
};

/** RouteLLM OpenAI-compatible base (routellm.abacus.ai/v1 in production). */
export const abacusRoutellmV1 = (): string => {
  const url = overrideHost();

  if (url == null) return DEFAULT_ROUTELLM_V1;

  // apps.abacus.ai -> routellm.abacus.ai. Rewrite the leading DNS label on a
  // parsed URL, never a substring replace (which matches `apps.abacus.ai.evil.com`).
  const labels = url.hostname.split(".");
  labels[0] = labels[0].includes("apps")
    ? labels[0].replace("apps", "routellm")
    : "routellm";
  const serving = new URL(url.origin);
  serving.hostname = labels.join(".");

  return `${serving.origin}/v1`;
};
