/**
 * Canonical camelCase key for each file-operation wire alias the cards
 * zod-require (docs/deep-agent-sse.md §6). Display-side only: the agent's
 * execution path re-parses the raw wire args on its own.
 */
// Keyed by the already-camelCased alias; `path` is the only path alias left
// after `filepath`/`file_path`/`filePath` collapse to `filePath`.
const FILE_OP_ALIASES: Record<string, string> = {
  path: "filePath",
  fileText: "content",
  oldStr: "oldString",
  newStr: "newString",
};

/**
 * camelCase every key, then project file-operation aliases onto their
 * canonical names. A present canonical key is never overwritten by an alias.
 * Pure: returns a fresh object, so the execution copy of the args is untouched.
 */
export function normalizeToolArgs(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeToolArgs);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase()
    );
    result[normalizedKey] = normalizeToolArgs(value);
  }

  for (const [aliasKey, canonical] of Object.entries(FILE_OP_ALIASES)) {
    if (result[canonical] === undefined && result[aliasKey] !== undefined) {
      result[canonical] = result[aliasKey];
    }
  }

  return result;
}
