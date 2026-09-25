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
