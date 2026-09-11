/**
 * Take the secrets and the user's name out of anything on its way to disk.
 * Omission cannot cover a key that reached a console.error or a home
 * directory in every path; this runs over whole texts so a new stream is
 * covered by default. Shared by log-dump.ts and log-store.ts.
 */
import os from "node:os";
import path from "node:path";

/** Scrub one text: key shapes, named secrets, and the user's own name. */
export function scrub(text: string, homeDir?: string): string {
  let out = text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1<redacted>")
    // The common key shapes: sk-…, ghp_…, AIza…, xox….
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "<redacted-key>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-key>")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "<redacted-key>")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<redacted-key>")
    // Anything that names itself: api_key=…, "token": "…".
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)["'\s]*[:=]["'\s]*)([^\s"',}]{6,})/gi,
      "$1<redacted>"
    );

  // The user's name is the parent of `~/.abacusai-bot`; the OS's answer is
  // read too, because either can be the one that appears in the paths.
  const candidates = new Set<string>();

  for (const name of [
    homeDir != null ? path.basename(path.dirname(homeDir)) : "",
    safely(() => path.basename(os.homedir())),
    safely(() => os.userInfo().username),
  ]) {
    if (name.length > 2 && name !== "unknown") candidates.add(name);
  }

  for (const name of candidates) out = out.split(name).join("<user>");

  return out;
}

function safely(read: () => string): string {
  try {
    return read();
  } catch {
    return "unknown";
  }
}
