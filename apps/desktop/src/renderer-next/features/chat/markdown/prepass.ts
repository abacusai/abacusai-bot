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
export const FILE_HASH = "#abacus-file=";

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

const displayBlock = (tex: string): string => {
  const fence = fenceFor(tex, "`");
  return `\n\n${fence}math\n${tex.trim()}\n${fence}\n\n`;
};

const inlineMath = (tex: string): string => inlineCode(MATH_SENTINEL + tex);

// ─── file links ────────────────────────────────────────────────────────

const isWindowsAbsolute = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path);

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

export const fileHref = (absPath: string): string =>
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

// ─── the scan ──────────────────────────────────────────────────────────

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
      const closeValid =
        close !== -1 && text[close + run.length] !== "`";
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
    if (char === "\\" && (text[index + 1] === "[" || text[index + 1] === "(")) {
      const display = text[index + 1] === "[";
      const closer = display ? "\\]" : "\\)";
      const close = text.indexOf(closer, index + 2);
      const body = close === -1 ? "" : text.slice(index + 2, close);
      if (close !== -1 && (display || !/\n\s*\n/.test(body))) {
        flushPlain();
        out += display ? displayBlock(body) : inlineMath(body);
        index = close + 2;
        continue;
      }
    }
    if (char === "$" && text[index + 1] === "$") {
      const close = text.indexOf("$$", index + 2);
      if (close !== -1) {
        flushPlain();
        out += displayBlock(text.slice(index + 2, close));
        index = close + 2;
        continue;
      }
    }
    if (char === "$" && text[index - 1] !== "\\") {
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

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Splits the source into code (fences, indented blocks) and prose, and
 * rewrites only the prose. An unclosed fence runs to the end, as the parser
 * does.
 */
export const prepass = (source: string, options: PrepassOptions): string => {
  if (!/[$\\]|\]\(/.test(source)) return source;
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
        const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
        if (closing.test(current)) break;
      }
      out.push(block.join("\n"));
      previousBlank = false;
      continue;
    }
    if (previousBlank && /^( {4}|\t)/.test(line) && line.trim() !== "") {
      flushProse();
      const block: string[] = [];
      while (
        index < lines.length &&
        (/^( {4}|\t)/.test(lines[index]!) || lines[index]!.trim() === "")
      ) {
        block.push(lines[index]!);
        index += 1;
      }
      out.push(block.join("\n"));
      previousBlank = block.at(-1)?.trim() === "";
      continue;
    }
    prose.push(line);
    previousBlank = line.trim() === "";
    index += 1;
  }
  flushProse();
  return out.join("\n");
};
