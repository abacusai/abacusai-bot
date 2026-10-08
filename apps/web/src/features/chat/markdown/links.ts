import type {
  BlockNode,
  InlineNode,
  MarkdownExtension,
} from "@tanstack/markdown";
import { parseMarkdown } from "@tanstack/markdown/parser";
import LinkifyIt from "linkify-it";

import { prepass } from "./prepass";

const detector = new LinkifyIt().set({ fuzzyEmail: false });

const inlineLinks = (nodes: InlineNode[]): InlineNode[] =>
  nodes.flatMap((node): InlineNode[] => {
    if (node.type === "link" || node.type === "inlineCode") return [node];
    if ("children" in node)
      return [{ ...node, children: inlineLinks(node.children) }];
    if (node.type !== "text") return [node];
    const matches = detector.match(node.value) ?? [];
    const result: InlineNode[] = [];
    let at = 0;
    for (const match of matches) {
      if (!/^https?:\/\//i.test(match.url)) continue;
      // Bare domain mentions require a path; www and explicit schemes are clear.
      if (
        !match.schema &&
        !match.raw.startsWith("www.") &&
        !match.raw.includes("/")
      )
        continue;
      if (match.index > at)
        result.push({ type: "text", value: node.value.slice(at, match.index) });
      result.push({
        type: "link",
        href: match.url,
        title: match.url,
        children: [{ type: "text", value: match.raw }],
      });
      at = match.lastIndex;
    }
    if (at < node.value.length)
      result.push({ type: "text", value: node.value.slice(at) });
    return result;
  });

const blocks = (nodes: BlockNode[]): BlockNode[] =>
  nodes.map((node): BlockNode => {
    switch (node.type) {
      case "heading":
      case "paragraph":
        return { ...node, children: inlineLinks(node.children) };
      case "blockquote":
      case "callout":
      case "component":
        return { ...node, children: blocks(node.children) };
      case "list":
        return {
          ...node,
          items: node.items.map((item) => ({
            ...item,
            children: blocks(item.children),
          })),
        };
      case "table":
        return {
          ...node,
          header: node.header.map((cell) => ({
            ...cell,
            children: inlineLinks(cell.children),
          })),
          rows: node.rows.map((row) =>
            row.map((cell) => ({
              ...cell,
              children: inlineLinks(cell.children),
            }))
          ),
        };
      case "footnotes":
        return {
          ...node,
          items: node.items.map((item) => ({
            ...item,
            children: blocks(item.children),
          })),
        };
      default:
        return node;
    }
  });

export const replyLinks: MarkdownExtension[] = [
  {
    name: "reply-links",
    transformDocument: (document) => ({
      ...document,
      children: blocks(document.children),
    }),
  },
];

/** Uses the same parsed nodes as rendering, excluding code and image URLs. */
export const messageLinks = (source: string): string[] => {
  const document = parseMarkdown(prepass(source, { workspaceRoot: null }), {
    extensions: replyLinks,
    frontmatter: false,
  });
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "link" && typeof record.href === "string") {
      try {
        const url = new URL(record.href);
        if (/^https?:$/.test(url.protocol) && !url.username && !url.password) {
          url.hash = "";
          found.add(url.href);
        }
      } catch {
        /* Relative files and anchors are not previews. */
      }
      return;
    }
    for (const field of ["children", "items", "header", "rows"])
      visit(record[field]);
  };
  visit(document);
  return [...found];
};
