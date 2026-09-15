/**
 * The model writes mail in markdown, and Gmail shows markdown raw. A body
 * headed for send_email or a draft goes out as HTML; a reply body, which the
 * connector only takes as plain text, is flattened to readable text.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GMAIL_TOOL = "abacus-connectors_Gmail_Tool";

const HTML_BODY_ACTIONS = new Set(["send_email", "create_draft_email"]);
const BULK_ACTIONS = new Set(["send_bulk_emails", "create_bulk_draft_emails"]);
const TEXT_REPLY_ACTIONS = new Set(["reply_to_email", "create_draft_reply"]);

const MARKDOWN_RE =
  /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|(-{3,}|\*{3,})\s*$)|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/m;

export const looksLikeMarkdown = (text: string): boolean =>
  MARKDOWN_RE.test(text);

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const inlineHtml = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

const inlineText = (text: string): string =>
  text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "rule" }
  | { kind: "paragraph"; lines: string[] };

/** Markdown into blocks. Enough of the grammar for a brief or a reply. */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  const close = (): void => {
    if (open != null) blocks.push(open);
    open = null;
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      close();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading != null) {
      close();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      continue;
    }
    if (/^\s{0,3}([-*_]){3,}\s*$/.test(line)) {
      close();
      blocks.push({ kind: "rule" });
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item != null) {
      const ordered = numbered != null;
      if (open?.kind !== "list" || open.ordered !== ordered) {
        close();
        open = { kind: "list", ordered, items: [] };
      }
      open.items.push(item[1]!);
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote != null) {
      if (open?.kind !== "quote") {
        close();
        open = { kind: "quote", lines: [] };
      }
      open.lines.push(quote[1]!);
      continue;
    }
    // An indented line under a list item continues that item.
    if (open?.kind === "list" && /^\s{2,}/.test(raw)) {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (open?.kind !== "paragraph") {
      close();
      open = { kind: "paragraph", lines: [] };
    }
    open.lines.push(line.trim());
  }
  close();

  return blocks;
}

/** Email-safe HTML: no h1 (it is huge in mail clients), no styles. */
export function markdownToHtml(markdown: string): string {
  const parts = parseBlocks(markdown).map((block) => {
    switch (block.kind) {
      case "heading": {
        const level = Math.min(block.level + 1, 4);
        return `<h${level}>${inlineHtml(block.text)}</h${level}>`;
      }
      case "rule":
        return "<hr>";
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items
          .map((item) => `<li>${inlineHtml(item)}</li>`)
          .join("");
        return `<${tag}>${items}</${tag}>`;
      }
      case "quote":
        return `<blockquote>${block.lines.map(inlineHtml).join("<br>")}</blockquote>`;
      case "paragraph":
        return `<p>${block.lines.map(inlineHtml).join("<br>")}</p>`;
    }
  });

  return `<div>${parts.join("\n")}</div>`;
}

/** Plain text that reads the way the markdown was meant to. */
export function markdownToText(markdown: string): string {
  const parts = parseBlocks(markdown).map((block) => {
    switch (block.kind) {
      case "heading":
        return inlineText(block.text).toUpperCase();
      case "rule":
        return "";
      case "list":
        return block.items
          .map((item, i) =>
            block.ordered
              ? `${i + 1}. ${inlineText(item)}`
              : `- ${inlineText(item)}`
          )
          .join("\n");
      case "quote":
        return block.lines.map((line) => `> ${inlineText(line)}`).join("\n");
      case "paragraph":
        return block.lines.map(inlineText).join("\n");
    }
  });

  return parts.filter((part) => part.length > 0).join("\n\n");
}

interface GmailInput {
  action?: unknown;
  body?: unknown;
  is_html?: unknown;
  reply_body?: unknown;
  emails?: unknown;
}

/** A bulk item's body: `{"text": …}` or `{"html": …}`, as a JSON string or object. */
const bulkBodyToHtml = (body: unknown): unknown => {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return looksLikeMarkdown(body)
        ? JSON.stringify({ html: markdownToHtml(body) })
        : body;
    }
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { text?: unknown }).text !== "string"
  )
    return body;
  const text = (parsed as { text: string }).text;
  if (!looksLikeMarkdown(text)) return body;
  const html = { html: markdownToHtml(text) };

  return typeof body === "string" ? JSON.stringify(html) : html;
};

/** Rewrite one Gmail call in place; true when anything changed. */
export function formatGmailInput(input: GmailInput): boolean {
  const action = typeof input.action === "string" ? input.action : "";

  if (HTML_BODY_ACTIONS.has(action)) {
    if (
      typeof input.body !== "string" ||
      input.is_html === true ||
      !looksLikeMarkdown(input.body)
    )
      return false;
    input.body = markdownToHtml(input.body);
    input.is_html = true;
    return true;
  }

  if (TEXT_REPLY_ACTIONS.has(action)) {
    if (
      typeof input.reply_body !== "string" ||
      !looksLikeMarkdown(input.reply_body)
    )
      return false;
    input.reply_body = markdownToText(input.reply_body);
    return true;
  }

  if (BULK_ACTIONS.has(action) && Array.isArray(input.emails)) {
    let changed = false;
    for (const email of input.emails as { body?: unknown }[]) {
      if (typeof email !== "object" || email === null) continue;
      const next = bulkBodyToHtml(email.body);
      if (next !== email.body) {
        email.body = next;
        changed = true;
      }
    }
    return changed;
  }

  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== GMAIL_TOOL) return;
    // Arguments are changed in place; that is the contract for this hook.
    formatGmailInput(event.input as GmailInput);
  });
}
