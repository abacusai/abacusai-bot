/**
 * The Markdown pre-pass (spec 02 §7.3, §7.5), pure and single-scan over the
 * raw string, outside fenced code, indented code and inline code spans:
 *
 * - closed math spans become forms the Markdown React renderer has hooks
 *   for: display math (`$$…$$`, `\[…\]`) a fenced block with language
 *   `math`; inline math (`\(…\)`, `$…$` by pandoc's rule) inline code with
 *   the U+2062 sentinel. Unclosed spans stay text until they close.
 * - link targets that name files become `#abacus-file=<encoded abs path>`,
 *   which survives `sanitizeUrl` (it keeps `#…` and strips whitespace).
 */
export const MATH_SENTINEL = "\u2062";
const FILE_HASH = "#abacus-file=";

export interface PrepassOptions {
  /** Resolves relative file links; null leaves them unchanged. */
  workspaceRoot: string | null;
}

const fenceFor = (body: string, char: "`"): string => {
  let longest = 0;
  for (const match of body.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length);
  return char.repeat(Math.max(3, longest + 1));
};

const inlineCode = (body: string): string => {
  let longest = 0;
  for (const match of body.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length);
  const ticks = "`".repeat(longest + 1);
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
  return `${ticks}${pad}${body}${pad}${ticks}`;
};

/**
 * The container a line sits in: blockquote markers, and a list item's
 * marker as spaces (its content indent). A display block keeps it on every
 * line, so math inside a quote or a list stays inside it.
 */
const containerPrefix = (line: string): string => {
  const quote = /^(?: {0,3}>[ ]?)+/.exec(line)?.[0] ?? "";
  const rest = line.slice(quote.length);
  const item = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4})/.exec(rest);
  if (item != null) return quote + " ".repeat(item[0].length);
  if (quote !== "") return quote;
  return /^\s*/.exec(rest)![0];
};

/** Removes a container prefix from a continuation line of a display body. */
const stripPrefix = (line: string, prefix: string): string => {
  if (prefix === "") return line;
  if (prefix.includes(">")) return line.replace(/^(?: {0,3}>[ ]?)+/, "");
  let at = 0;
  while (at < prefix.length && line[at] === " ") at += 1;
  return line.slice(at);
};

const containerOnly = (lineBefore: string): boolean =>
  /^(?: {0,3}>[ ]?)*(?: {0,3}(?:[-*+]|\d{1,9}[.)]) {1,4})?\s*$/.test(
    lineBefore
  );

const displayBlock = (tex: string, lineBefore = ""): string => {
  const prefix = containerPrefix(lineBefore);
  const body = tex
    .split("\n")
    .map((line, index) => (index === 0 ? line : stripPrefix(line, prefix)))
    .join("\n")
    .trim();
  const fence = fenceFor(body, "`");
  if (prefix === "") return `\n\n${fence}math\n${body}\n${fence}\n\n`;
  const fenced = [`${fence}math`, ...body.split("\n"), fence]
    .map((line, index) => (index === 0 ? line : prefix + line))
    .join("\n");
  // Only the container's marker precedes the math on its line: the fence
  // opens right there (a list item or quote that starts with the block).
  return containerOnly(lineBefore)
    ? `${fenced}\n${prefix}`
    : `\n${prefix}\n${prefix}${fenced}\n${prefix}`;
};

/** An odd run of backslashes before `at` escapes the character there. */
const escaped = (text: string, at: number): boolean => {
  let count = 0;
  for (let index = at - 1; index >= 0 && text[index] === "\\"; index -= 1)
    count += 1;
  return count % 2 === 1;
};

const inlineMath = (tex: string): string => inlineCode(MATH_SENTINEL + tex);

// ─── file links ────────────────────────────────────────────────────────

const isWindowsAbsolute = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path);

const hasScheme = (target: string): boolean =>
  /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !isWindowsAbsolute(target);

const joinPath = (root: string, relative: string): string => {
  const windows = isWindowsAbsolute(root) || root.includes("\\");
  const separator = windows ? "\\" : "/";
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const segment of relative.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join(separator);
  return windows || joined.startsWith("/") ? joined : `/${joined}`;
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The absolute path a link target names, or null when it is not a file. */
export const fileTarget = (
  rawTarget: string,
  workspaceRoot: string | null
): string | null => {
  const target = rawTarget.trim();
  if (target === "" || target.startsWith("#")) return null;
  if (/^file:\/\//i.test(target)) {
    const path = safeDecode(target.replace(/^file:\/\//i, ""));
    // file:///C:/x → C:/x
    return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
  }
  if (isWindowsAbsolute(target)) return safeDecode(target);
  if (target.startsWith("//")) return null;
  if (target.startsWith("/")) return safeDecode(target);
  if (hasScheme(target)) return null;
  if (workspaceRoot == null) return null;
  return joinPath(workspaceRoot, safeDecode(target));
};

const fileHref = (absPath: string): string =>
  FILE_HASH + encodeURIComponent(absPath);

export const pathFromHref = (href: string | undefined): string | null =>
  href?.startsWith(FILE_HASH) === true
    ? safeDecode(href.slice(FILE_HASH.length))
    : null;

/** `](target "title")` → rewrite the target when it names a file. */
const rewriteLinks = (text: string, workspaceRoot: string | null): string =>
  text.replace(
    /\]\((<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(\s+(?:"[^"]*"|'[^']*'))?\)/g,
    (whole, target: string, title: string | undefined) => {
      const bare = target.startsWith("<") ? target.slice(1, -1) : target;
      const abs = fileTarget(bare, workspaceRoot);
      if (abs == null) return whole;
      return `](${fileHref(abs)}${title ?? ""})`;
    }
  );

/**
 * Reference definitions (`[x]: /abs/path "title"`) are link targets too;
 * footnote definitions (`[^1]: text`) are not.
 */
const REFERENCE_DEFINITION =
  /^( {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*)(<[^>]*>|\S+)(.*)$/;

const rewriteDefinition = (
  line: string,
  workspaceRoot: string | null
): string => {
  const match = REFERENCE_DEFINITION.exec(line);
  if (match == null) return line;
  const [, head, target, tail] = match;
  const bare = target!.startsWith("<") ? target!.slice(1, -1) : target!;
  const abs = fileTarget(bare, workspaceRoot);
  return abs == null ? line : `${head}${fileHref(abs)}${tail}`;
};

// ─── the scan ──────────────────────────────────────────────────────────

/** The current (unfinished) output line, for a display block's container. */
const lineBefore = (out: string): string =>
  out.slice(out.lastIndexOf("\n") + 1);

/** Text outside code: math spans, then links in what stays text. */
const rewriteProse = (text: string, options: PrepassOptions): string => {
  let out = "";
  let index = 0;
  let plain = "";
  const flushPlain = () => {
    out += rewriteLinks(plain, options.workspaceRoot);
    plain = "";
  };
  while (index < text.length) {
    const char = text[index]!;
    // Inline code span: copy verbatim up to its matching backtick run.
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      const closeValid = close !== -1 && text[close + run.length] !== "`";
      if (closeValid) {
        // Code is never rewritten (neither math nor links).
        flushPlain();
        out += text.slice(index, close + run.length);
        index = close + run.length;
        continue;
      }
      plain += run;
      index += run.length;
      continue;
    }
    if (
      char === "\\" &&
      (text[index + 1] === "[" || text[index + 1] === "(") &&
      !escaped(text, index)
    ) {
      const display = text[index + 1] === "[";
      const closer = display ? "\\]" : "\\)";
      const close = text.indexOf(closer, index + 2);
      const body = close === -1 ? "" : text.slice(index + 2, close);
      if (close !== -1 && (display || !/\n\s*\n/.test(body))) {
        flushPlain();
        out += display ? displayBlock(body, lineBefore(out)) : inlineMath(body);
        index = close + 2;
        continue;
      }
    }
    if (char === "$" && text[index + 1] === "$" && !escaped(text, index)) {
      const close = text.indexOf("$$", index + 2);
      if (close !== -1) {
        flushPlain();
        out += displayBlock(text.slice(index + 2, close), lineBefore(out));
        index = close + 2;
        continue;
      }
    }
    if (char === "$" && !escaped(text, index)) {
      // Pandoc: `$` then a non-space; closing `$` after a non-space, on the
      // same line, not followed by a digit.
      const next = text[index + 1];
      if (next != null && next !== "$" && !/\s/.test(next)) {
        const lineEnd = text.indexOf("\n", index);
        const limit = lineEnd === -1 ? text.length : lineEnd;
        let close = -1;
        for (let at = index + 1; at < limit; at += 1) {
          if (text[at] !== "$" || text[at - 1] === "\\") continue;
          if (/\s/.test(text[at - 1]!)) continue;
          if (/[0-9]/.test(text[at + 1] ?? "")) continue;
          close = at;
          break;
        }
        if (close !== -1) {
          flushPlain();
          out += inlineMath(text.slice(index + 1, close));
          index = close + 1;
          continue;
        }
      }
    }
    plain += char;
    index += 1;
  }
  flushPlain();
  return out;
};

const indentOf = (line: string): number => {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
};

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Splits the source into code (fences, indented blocks) and prose, and
 * rewrites only the prose. An unclosed fence runs to the end, as the parser
 * does.
 */
export const prepass = (source: string, options: PrepassOptions): string => {
  if (!/[$\\]|\]\(|\]:/.test(source)) return source;
  const lines = source.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    out.push(rewriteProse(prose.join("\n"), options));
    prose = [];
  };
  let index = 0;
  let previousBlank = true;
  // The content indent of the list item the prose is in (0 outside lists):
  // after a blank line, a line indented less than that + 4 continues the
  // item; only deeper indentation is indented code (CommonMark).
  let listIndent = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence != null && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      flushProse();
      const marker = fence[2]!;
      const block = [line];
      index += 1;
      while (index < lines.length) {
        const current = lines[index]!;
        block.push(current);
        index += 1;
        const closing = new RegExp(
          `^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`
        );
        if (closing.test(current)) break;
      }
      out.push(block.join("\n"));
      previousBlank = false;
      continue;
    }
    if (
      previousBlank &&
      line.trim() !== "" &&
      indentOf(line) >= listIndent + 4
    ) {
      flushProse();
      const block: string[] = [];
      while (
        index < lines.length &&
        (indentOf(lines[index]!) >= listIndent + 4 ||
          lines[index]!.trim() === "")
      ) {
        block.push(lines[index]!);
        index += 1;
      }
      out.push(block.join("\n"));
      previousBlank = block.at(-1)?.trim() === "";
      continue;
    }
    if (line.trim() !== "") {
      const item = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}|$)/.exec(line);
      if (item != null) listIndent = item[0].length;
      else if (previousBlank && indentOf(line) < listIndent) listIndent = 0;
    }
    prose.push(rewriteDefinition(line, options.workspaceRoot));
    previousBlank = line.trim() === "";
    index += 1;
  }
  flushProse();
  return out.join("\n");
};
