import path from "path";

/**
 * Names Windows resolves to a device rather than to a file, with or without an
 * extension: `CON.txt` is still the console.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Where a pasted attachment may be written. The name arrives from the renderer,
 * so only its final path segment is used, and the result is still verified to
 * be a direct child of `tempDir`. Windows reads more into a name than POSIX:
 * `a.txt:b` is an alternate data stream, trailing dots and spaces are stripped
 * (so `x.txt ` silently replaces `x.txt`), and reserved device names open a
 * device. Those spellings are rejected rather than renamed.
 */
export const resolvePastedFilePath = (
  tempDir: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string => {
  const p = platform === "win32" ? path.win32 : path.posix;
  const invalid = (): Error =>
    new Error(`Invalid pasted file name: ${JSON.stringify(name)}`);

  const base = typeof name === "string" ? p.basename(name) : "";
  if (base === "" || base === "." || base === "..") throw invalid();

  if (platform === "win32") {
    if (base.includes(":")) throw invalid();
    if (/[. ]$/.test(base)) throw invalid();
    const stem = base.split(".")[0]?.toLowerCase() ?? "";
    if (WINDOWS_RESERVED_NAMES.has(stem)) throw invalid();
  }

  const dest = p.join(tempDir, base);
  // join(dir, ".") is `dir` normalized, without a trailing separator.
  if (p.dirname(dest) !== p.join(tempDir, ".")) throw invalid();

  return dest;
};
