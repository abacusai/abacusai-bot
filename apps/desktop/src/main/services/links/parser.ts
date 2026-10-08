import { parse, type DefaultTreeAdapterMap } from "parse5";

const clean = (s: string | undefined, max = 600) =>
  (s ?? "")
    // oxlint-disable-next-line no-control-regex -- Strip untrusted metadata controls and bidi overrides.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** parse5 supplies HTML tokenisation, entity decoding and tolerant head parsing. */
export const previewMetadata = (html: string, finalUrl: string) => {
  const doc = parse(html);
  type Node = DefaultTreeAdapterMap["node"];
  const metas = new Map<string, string>();
  let title = "";
  let icon: string | undefined;
  const walk = (node: Node, inHead = false) => {
    if (!("tagName" in node)) return;
    if (node.tagName === "body") return;
    const head = inHead || node.tagName === "head";
    const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
    if (head && node.tagName === "meta") {
      const name = (
        attrs.get("property") ??
        attrs.get("name") ??
        ""
      ).toLowerCase();
      if (!metas.has(name)) metas.set(name, attrs.get("content") ?? "");
    }
    if (head && node.tagName === "title")
      title = node.childNodes
        .filter((n) => n.nodeName === "#text")
        .map((n) => (n as DefaultTreeAdapterMap["textNode"]).value)
        .join("");
    if (
      head &&
      node.tagName === "link" &&
      /(?:^|\s)icon(?:\s|$)/i.test(attrs.get("rel") ?? "")
    )
      icon ??= attrs.get("href");
    for (const child of node.childNodes) walk(child, head);
  };
  for (const node of doc.childNodes) walk(node);
  const relative = (s: string | undefined) => {
    try {
      const url = new URL(s ?? "", finalUrl);
      return s &&
        /^https?:$/.test(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    siteName:
      clean(metas.get("og:site_name"), 100) || new URL(finalUrl).hostname,
    title: clean(
      metas.get("og:title") || metas.get("twitter:title") || title,
      90
    ),
    description: clean(
      metas.get("og:description") ||
        metas.get("twitter:description") ||
        metas.get("description"),
      160
    ),
    image: relative(metas.get("og:image") || metas.get("twitter:image")),
    favicon: relative(icon),
  };
};
