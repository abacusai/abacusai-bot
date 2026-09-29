// An ABACUSAI_BOT_ABACUS_V1 override is honored only when it is https on an
// abacus.ai host, else production, so a planted value can't redirect the key.
export const DEFAULT_ABACUS_V1 = "https://routellm.abacus.ai/v1";

const isAbacusHost = (host: string): boolean =>
  host === "abacus.ai" || host.endsWith(".abacus.ai");

export const abacusV1BaseUrl = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const raw = (env.ABACUSAI_BOT_ABACUS_V1 ?? "").trim();
  if (!raw) return DEFAULT_ABACUS_V1;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && isAbacusHost(url.hostname.toLowerCase())) {
      return raw;
    }
  } catch {
    return DEFAULT_ABACUS_V1;
  }
  return DEFAULT_ABACUS_V1;
};

/**
 * The desktop marks a session the platform serves on the house (the Chief of
 * Staff's first run) with this env var; every request to Abacus carries it as
 * a header, and the platform decides whether the run still qualifies. The
 * value is a short token, so a planted env cannot smuggle anything else in.
 */
export const SPONSORED_RUN_HEADER = "X-Abacus-Sponsored-Run";
const SPONSORED_RUN_RE = /^[a-z0-9-]{1,40}$/;

export const sponsoredRunHeaders = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const value = (env.ABACUSAI_BOT_SPONSORED_RUN ?? "").trim();
  return SPONSORED_RUN_RE.test(value) ? { [SPONSORED_RUN_HEADER]: value } : {};
};
