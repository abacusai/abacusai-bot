/** Forgiving single-pass XML reader for OOXML parts; tags keep their prefix. */

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content (whitespace preserved). */
  text: string;
};

const EMPTY_NODE: XmlNode = Object.freeze({
  name: "",
  attrs: {},
  children: [],
  text: "",
}) as XmlNode;

export function parseXml(source: string): XmlNode {
  const root: XmlNode = {
    name: "#document",
    attrs: {},
    children: [],
    text: "",
  };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;

    if (lt > i) {
      const text = decodeEntities(source.slice(i, lt));
      if (text.length > 0) stack[stack.length - 1].text += text;
    }

    // Comments, CDATA and processing instructions carry nothing we need.
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt);
      const body = source.slice(lt + 9, end < 0 ? len : end);
      stack[stack.length - 1].text += body;
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) {
      const end = source.indexOf(">", lt);
      i = end < 0 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt < 0) break;
    const raw = source.slice(lt + 1, gt);

    if (raw.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const node = parseTag(body);
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/** Finds the `>` that closes a tag, skipping any inside quoted attributes. */
function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote != null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function parseTag(body: string): XmlNode {
  let cursor = 0;
  while (cursor < body.length && !/\s/.test(body[cursor])) cursor++;
  const name = body.slice(0, cursor);
  const attrs: Record<string, string> = {};

  const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  attrRe.lastIndex = cursor;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(body)) != null) {
    attrs[match[1]] = decodeEntities(match[3] ?? match[4] ?? "");
  }

  return { name, attrs, children: [], text: "" };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  // References above U+10FFFF make fromCodePoint throw; keep the raw entity.
  const codePoint = (code: number): string | null =>
    Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : null;
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return codePoint(Number.parseInt(entity.slice(2), 16)) ?? whole;
    }
    if (entity.startsWith("#")) {
      return codePoint(Number.parseInt(entity.slice(1), 10)) ?? whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

/** First direct child with this tag name, or null. */
export function child(
  node: XmlNode | null | undefined,
  name: string
): XmlNode | null {
  if (node == null) return null;
  for (const c of node.children) {
    if (c.name === name) return c;
  }
  return null;
}

/** Direct children with this tag name (empty when none). */
export function children(
  node: XmlNode | null | undefined,
  name: string
): XmlNode[] {
  if (node == null) return [];
  return node.children.filter((c) => c.name === name);
}

/** Walks a chain of direct children, e.g. `path(sp, 'p:spPr', 'a:xfrm')`. */
export function path(
  node: XmlNode | null | undefined,
  ...names: string[]
): XmlNode | null {
  let current = node ?? null;
  for (const name of names) {
    current = child(current, name);
    if (current == null) return null;
  }
  return current;
}

/** First descendant with this tag name, depth-first, or null. */
export function find(
  node: XmlNode | null | undefined,
  name: string
): XmlNode | null {
  if (node == null) return null;
  for (const c of node.children) {
    if (c.name === name) return c;
    const nested = find(c, name);
    if (nested != null) return nested;
  }
  return null;
}

/** All descendants with this tag name, depth-first. */
export function findAll(
  node: XmlNode | null | undefined,
  name: string,
  out: XmlNode[] = []
): XmlNode[] {
  if (node == null) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function attr(
  node: XmlNode | null | undefined,
  name: string
): string | null {
  const value = node?.attrs[name];
  return value == null || value === "" ? null : value;
}

export function attrInt(
  node: XmlNode | null | undefined,
  name: string
): number | null {
  const raw = attr(node, name);
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** OOXML booleans are `1`/`0` or `true`/`false`; absent means "inherit". */
export function attrBool(
  node: XmlNode | null | undefined,
  name: string
): boolean | null {
  const raw = attr(node, name);
  if (raw == null) return null;
  return raw === "1" || raw === "true";
}

export const emptyNode = (): XmlNode => EMPTY_NODE;
