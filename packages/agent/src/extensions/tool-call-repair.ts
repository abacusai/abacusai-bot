/**
 * Tool-call recovery for small models that write a tool call as text. A
 * `message_end` handler may replace the finalized assistant message before the
 * loop extracts tool calls, so rewriting the text into a `toolCall` block runs
 * it as if called natively. Recognised: json fences and <tool_call> tags,
 * bare JSON and OpenAI envelopes, `[TOOL_CALLS]`/`<|tool_call|>` markers, and
 * pythonic calls in tool_code fences, bare lists or after `<|python_tag|>`.
 * Only unambiguous calls that end the message and name a registered tool are
 * recovered; a plain ```python fence is code for the user, never a call.
 * Everything declined falls through to output-repair's nudge.
 */
import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type ContentBlock = { type: string } & Record<string, unknown>;

interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

/** A span of the text that might contain a tool call written as text. */
interface Candidate {
  start: number;
  end: number;
  body: string;
  /** Whether Python-syntax calls may be read from this span (see header). */
  pythonic: boolean;
}

const FENCE = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
const TAG =
  /<(tool_calls?|function_calls?|invoke|tool)\b[^>]*>([\s\S]*?)<\/\1>/gi;
/** Fence labels that mark the body as a tool call rather than code-for-the-user. */
const PYTHONIC_FENCE = /^tool_(?:code|calls?)$/i;
/** Leading tokens various chat templates use to introduce a tool call. */
const MARKER =
  /^\s*(?:\[TOOL_(?:CALLS?|REQUEST)\]|<\|tool_call\|>|<\|python_tag\|>)\s*/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** One call from one parsed JSON object, or null when it isn't one. */
function toCall(parsed: unknown, toolNames: Set<string>): ParsedCall | null {
  if (!isPlainObject(parsed)) return null;

  const fn = isPlainObject(parsed.function) ? parsed.function : undefined;
  const name = [parsed.name, parsed.tool, parsed.tool_name, fn?.name].find(
    (n): n is string => typeof n === "string" && n.length > 0
  );

  if (name == null || !toolNames.has(name)) return null;

  let args =
    parsed.arguments ??
    parsed.parameters ??
    parsed.input ??
    parsed.args ??
    fn?.arguments ??
    fn?.parameters ??
    {};

  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }

  if (!isPlainObject(args)) return null;

  return { name, args };
}

/**
 * The calls a JSON body describes, or null when it isn't any. Accepts the key
 * spellings models produce, including a JSON-encoded arguments string. An
 * array counts only when EVERY element is a valid call: executing half a batch
 * would leave the model believing the rest ran.
 */
function parseJsonCalls(
  raw: string,
  toolNames: Set<string>
): ParsedCall[] | null {
  const trimmed = raw.trim();
  const bracketed =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));

  if (!bracketed) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (isPlainObject(parsed) && Array.isArray(parsed.tool_calls)) {
    parsed = parsed.tool_calls;
  }

  const objects = Array.isArray(parsed) ? parsed : [parsed];

  if (objects.length === 0) return null;

  const calls = objects.map((o) => toCall(o, toolNames));

  return calls.every((c): c is ParsedCall => c != null) ? calls : null;
}

/**
 * The calls a pythonic body describes: `f(a=1)`, `[f(a=1), g(b='x')]`, or a
 * `print(...)` wrapper. Literal values and keyword arguments only; a positional
 * argument has no parameter name, and a real expression is code, not a call.
 */
function parsePythonicCalls(
  raw: string,
  toolNames: Set<string>
): ParsedCall[] | null {
  const src = raw.trim();
  let pos = 0;

  const fail = (): never => {
    throw new Error("not a pythonic call");
  };
  const ws = () => {
    while (pos < src.length && /\s/.test(src[pos] as string)) pos++;
  };
  const eat = (ch: string) => {
    ws();
    if (src[pos] !== ch) fail();
    pos++;
  };

  const ident = (): string => {
    ws();
    const m = /^[A-Za-z_]\w*/.exec(src.slice(pos));

    if (m == null) fail();
    pos += (m as RegExpExecArray)[0].length;

    return (m as RegExpExecArray)[0];
  };

  const dottedName = (): string => {
    let name = ident();

    while (src[pos] === ".") {
      pos++;
      name += `.${ident()}`;
    }

    return name;
  };

  const string = (): string => {
    const quote = src[pos] as string;
    let out = "";

    pos++;
    while (pos < src.length && src[pos] !== quote) {
      if (src[pos] === "\\") {
        pos++;
        const c = src[pos] as string;

        if (c === "u") {
          // \uXXXX decodes as a UTF-16 unit; falling through would emit a
          // literal "uXXXX".
          const hex = src.slice(pos + 1, pos + 5);

          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else {
          out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
        }
      } else {
        out += src[pos] as string;
      }
      pos++;
    }
    if (src[pos] !== quote) fail();
    pos++;

    return out;
  };

  const value = (): unknown => {
    ws();
    const c = src[pos];

    if (c === '"' || c === "'") return string();
    if (c === "[") {
      pos++;
      const items: unknown[] = [];

      ws();
      if (src[pos] === "]") {
        pos++;

        return items;
      }
      for (;;) {
        items.push(value());
        ws();
        if (src[pos] === ",") {
          pos++;
          continue;
        }
        eat("]");

        return items;
      }
    }
    if (c === "{") {
      pos++;
      const obj: Record<string, unknown> = {};

      ws();
      if (src[pos] === "}") {
        pos++;

        return obj;
      }
      for (;;) {
        ws();
        const key = src[pos] === '"' || src[pos] === "'" ? string() : ident();

        eat(":");
        obj[key] = value();
        ws();
        if (src[pos] === ",") {
          pos++;
          continue;
        }
        eat("}");

        return obj;
      }
    }

    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(pos));

    if (num != null) {
      pos += num[0].length;

      return Number(num[0]);
    }

    const word = /^[A-Za-z_]\w*/.exec(src.slice(pos));

    if (word != null) {
      const literals: Record<string, unknown> = {
        True: true,
        true: true,
        False: false,
        false: false,
        None: null,
        null: null,
      };

      if (word[0] in literals) {
        pos += word[0].length;

        return literals[word[0]];
      }
    }

    return fail();
  };

  const callExpr = (): { name: string; args: Record<string, unknown> } => {
    const name = dottedName();

    eat("(");
    // Gemma wraps the real call in print(); unwrap exactly that shape.
    if (name === "print") {
      const inner = callExpr();

      eat(")");

      return inner;
    }

    const args: Record<string, unknown> = {};

    ws();
    if (src[pos] === ")") {
      pos++;

      return { name, args };
    }
    for (;;) {
      const key = ident();

      eat("=");
      args[key] = value();
      ws();
      if (src[pos] === ",") {
        pos++;
        continue;
      }
      eat(")");

      return { name, args };
    }
  };

  /** The roster name a (possibly dotted or `.call`-suffixed) name reaches. */
  const resolve = (name: string): string | null => {
    const stripped = name.replace(/\.call$/, "");
    const last = stripped.split(".").at(-1) ?? stripped;

    for (const candidate of [name, stripped, last])
      if (toolNames.has(candidate)) return candidate;

    return null;
  };

  try {
    const raws: Array<{ name: string; args: Record<string, unknown> }> = [];

    ws();
    if (src[pos] === "[") {
      pos++;
      for (;;) {
        raws.push(callExpr());
        ws();
        if (src[pos] === ",") {
          pos++;
          continue;
        }
        eat("]");
        break;
      }
    } else {
      raws.push(callExpr());
    }
    ws();
    if (pos !== src.length || raws.length === 0) return null;

    const calls = raws.map(({ name, args }) => {
      const resolved = resolve(name);

      return resolved == null ? null : { name: resolved, args };
    });

    return calls.every((c): c is ParsedCall => c != null) ? calls : null;
  } catch {
    return null;
  }
}

function parseCalls(c: Candidate, toolNames: Set<string>): ParsedCall[] | null {
  return (
    parseJsonCalls(c.body, toolNames) ??
    (c.pythonic ? parsePythonicCalls(c.body, toolNames) : null)
  );
}

/** Every fenced block, pseudo-tag block, and the whole-message bare body. */
function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];

  FENCE.lastIndex = 0;
  for (const match of text.matchAll(FENCE)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      body: match[2] ?? "",
      pythonic: PYTHONIC_FENCE.test(match[1] ?? ""),
    });
  }

  TAG.lastIndex = 0;
  for (const match of text.matchAll(TAG)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      body: match[2] ?? "",
      pythonic: true,
    });
  }

  // The whole message as a bare call, tolerating the chat-template marker
  // some models leak in front of it.
  const marker = MARKER.exec(text);
  const body = text.slice(marker?.[0].length ?? 0).trim();

  if (body.length > 0) {
    found.push({ start: 0, end: text.length, body, pythonic: true });
  }

  return found;
}

/**
 * A block introduced as an illustration ("for example:", "like this:"). A
 * message can END with one, so "nothing follows it" alone does not clear it.
 */
function looksLikeExample(text: string, start: number): boolean {
  const before = text.slice(0, start).trimEnd();

  if (!before.endsWith(":")) return false;

  const line = before.slice(before.lastIndexOf("\n") + 1);

  return /\b(?:example|for instance|like this|you would|you could|e\.g)\b/i.test(
    line
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event: MessageEndEvent) => {
    const msg = event.message as {
      role?: string;
      content?: unknown;
      stopReason?: string;
    };

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
    // An errored call pi will retry itself, and an abort is the user's doing.
    if (msg.stopReason === "error" || msg.stopReason === "aborted") return;

    const blocks = msg.content as ContentBlock[];

    // A native call is present: rewriting risks executing the same call twice.
    if (blocks.some((b) => b.type === "toolCall")) return;

    const text = blocks
      .filter((b): b is TextBlock & ContentBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (text.trim().length === 0) return;

    const toolNames = new Set(pi.getAllTools().map((t) => t.name));

    // The last parseable candidate, and only if nothing follows it: a call is
    // the model's final word, an example has prose after it.
    const found = candidates(text)
      .filter((c) => text.slice(c.end).trim().length === 0)
      .filter((c) => !looksLikeExample(text, c.start))
      .map((c) => ({ c, parsed: parseCalls(c, toolNames) }))
      .filter(
        (x): x is { c: Candidate; parsed: ParsedCall[] } => x.parsed != null
      )
      .at(-1);

    if (found == null) return;

    const leading = text.slice(0, found.c.start).trim();
    const toolCalls: ToolCallBlock[] = found.parsed.map((call) => ({
      type: "toolCall",
      id: `repaired-${randomUUID()}`,
      name: call.name,
      arguments: call.args,
    }));
    const content: ContentBlock[] = [
      // Thinking blocks stay; text collapses to the prose before the call.
      ...blocks.filter((b) => b.type !== "text" && b.type !== "toolCall"),
      ...(leading.length > 0
        ? [{ type: "text", text: leading } as ContentBlock]
        : []),
      ...(toolCalls as unknown as ContentBlock[]),
    ];

    return {
      message: {
        ...msg,
        content,
        stopReason: "toolUse",
      } as unknown as MessageEndEvent["message"],
    };
  });
}
