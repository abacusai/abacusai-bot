/**
 * Tool text from an MCP server goes straight into the model's prompt, and the
 * server wrote it. This strips what a person reviewing that server cannot see:
 * invisible characters, and `<|...|>` chat-template tokens that forge a prompt
 * turn. Visible prose is left alone, so a clean server's tools are unchanged.
 */

// Explicit ranges, not the Cf category: Cf also holds ZWNJ and ZWJ, which
// Persian, Indic scripts and emoji sequences need.
const HIDDEN_TEXT =
  /(?![\t\n])\p{Cc}|[\u{AD}\u{115F}\u{1160}\u{180E}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{2800}\u{3164}\u{FFA0}\u{FEFF}\u{FFF9}-\u{FFFB}\uD800-\uDFFF\u{E000}-\u{F8FF}\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{F0000}-\u{10FFFF}]|<\|[^|>\n]{0,64}\|>/gu;

const MAX_CLEAN_PASSES = 8;

// Schema keys holding the server's data, not a schema: a change here would
// alter the values a call sends.
const SCHEMA_VALUE_KEYS = new Set(["const", "default", "enum", "examples"]);

const SCHEMA_TEXT_KEYS = new Set(["description", "title"]);

export function sanitizeMcpText(text: unknown, context: string): string {
  if (typeof text !== "string") return "";

  let clean = text;
  // Repeated because a removal can close a gap and rebuild a token the server
  // split on purpose.
  for (let pass = 0; pass < MAX_CLEAN_PASSES; pass += 1) {
    const next = clean.replace(HIDDEN_TEXT, "");
    if (next === clean) break;
    clean = next;
  }
  if (clean === text) return text;

  // Still rebuilding after every pass: nothing here is worth keeping.
  const dropped = clean.replace(HIDDEN_TEXT, "") !== clean;
  process.stderr.write(
    `[mcp] removed hidden text from ${context}${dropped ? " and dropped it" : ""}\n`
  );
  return dropped ? "" : clean;
}

/** A copy of the schema, cleaned at every depth the model reads. */
export function sanitizeMcpSchema<T>(schema: T, context: string): T {
  if (Array.isArray(schema))
    return schema.map((item) => sanitizeMcpSchema(item, context)) as T;
  if (schema == null || typeof schema !== "object") return schema;

  const clean = Object.entries(schema).map(([key, value]) => {
    if (SCHEMA_VALUE_KEYS.has(key)) return [key, value];
    if (SCHEMA_TEXT_KEYS.has(key) && typeof value === "string")
      return [key, sanitizeMcpText(value, `${context} ${key}`)];
    return [key, sanitizeMcpSchema(value, context)];
  });
  return Object.fromEntries(clean) as T;
}
