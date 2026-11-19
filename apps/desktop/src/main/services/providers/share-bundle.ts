import fs from "node:fs/promises";
import path from "node:path";

import { namesSecretFile } from "@abacus-ai/agent/secret-files";
import { parse, type DefaultTreeAdapterMap } from "parse5";

/**
 * A web page shared live is one file, so the files it loads from beside it
 * (stylesheets, scripts, images, fonts, media) are folded into it: the link
 * then shows what the app showed. Only files inside the page's own folder are
 * read, never a key file; anything else is left as written.
 */

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type Scrub = (text: string) => string;

interface Edit {
  start: number;
  end: number;
  text: string;
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Attributes that point at a file to embed, by element. */
const EMBEDDED_ATTRIBUTES: Record<string, readonly string[]> = {
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  image: ["href", "xlink:href"],
};

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1\s*;/gi;

const isLocalReference = (ref: string): boolean => {
  const value = ref.trim();
  return (
    value !== "" &&
    !value.startsWith("#") &&
    !value.startsWith("//") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value)
  );
};

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const attributes = (element: Element, skip: string): string =>
  element.attrs
    .filter((attr) => attr.name !== skip)
    .map((attr) => ` ${attr.name}="${escapeAttribute(attr.value)}"`)
    .join("");

class PageBundler {
  private readonly root: string;
  private readonly scrub: Scrub;

  constructor(root: string, scrub: Scrub) {
    this.root = root;
    this.scrub = scrub;
  }

  /** The file a reference names, when it lies inside the page's folder and is not a key file. */
  private async resolve(ref: string, from: string): Promise<string | null> {
    const clean = decodeURI(ref.trim().split(/[?#]/)[0] ?? "");
    if (clean === "") return null;
    // A leading slash means the folder the page is served from.
    const lexical = clean.startsWith("/")
      ? path.join(this.root, clean)
      : path.resolve(from, clean);
    try {
      const real = await fs.realpath(lexical);
      const relative = path.relative(this.root, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      if (namesSecretFile(relative) || namesSecretFile(real)) return null;
      return (await fs.stat(real)).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  private async readText(
    ref: string,
    from: string
  ): Promise<{ file: string; text: string } | null> {
    const file = await this.resolve(ref, from);
    if (file == null) return null;
    return { file, text: this.scrub(await fs.readFile(file, "utf8")) };
  }

  private async dataUri(ref: string, from: string): Promise<string | null> {
    const file = await this.resolve(ref, from);
    if (file == null) return null;
    const mime = MIME_TYPES[path.extname(file).slice(1).toLowerCase()];
    if (mime == null) return null;
    const bytes =
      mime === "image/svg+xml"
        ? Buffer.from(this.scrub(await fs.readFile(file, "utf8")), "utf8")
        : await fs.readFile(file);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  /** A stylesheet with its local url()s embedded and local @imports folded in. */
  private async inlineCss(
    css: string,
    from: string,
    depth = 0
  ): Promise<string> {
    let out = css;
    if (depth < 3) {
      const imports = [...out.matchAll(CSS_IMPORT_RE)];
      for (const match of imports.reverse()) {
        const ref = match[2] ?? "";
        if (!isLocalReference(ref)) continue;
        const sheet = await this.readText(ref, from);
        if (sheet == null) continue;
        const folded = await this.inlineCss(
          sheet.text,
          path.dirname(sheet.file),
          depth + 1
        );
        const at = match.index ?? 0;
        out = out.slice(0, at) + folded + out.slice(at + match[0].length);
      }
    }
    const urls = [...out.matchAll(CSS_URL_RE)];
    for (const match of urls.reverse()) {
      const ref = match[2] ?? "";
      if (!isLocalReference(ref)) continue;
      const uri = await this.dataUri(ref, from);
      if (uri == null) continue;
      const at = match.index ?? 0;
      out = `${out.slice(0, at)}url(${uri})${out.slice(at + match[0].length)}`;
    }
    return out;
  }

  private async elementEdits(element: Element, html: string): Promise<Edit[]> {
    const location = element.sourceCodeLocation;
    if (location == null) return [];
    const attr = new Map(element.attrs.map(({ name, value }) => [name, value]));
    const tag = element.tagName;
    const rel = (attr.get("rel") ?? "").toLowerCase().split(/\s+/);

    if (
      tag === "link" &&
      rel.includes("stylesheet") &&
      isLocalReference(attr.get("href") ?? "")
    ) {
      const sheet = await this.readText(attr.get("href") ?? "", this.root);
      if (sheet == null) return [];
      const css = await this.inlineCss(sheet.text, path.dirname(sheet.file));
      const media = attr.get("media");
      return [
        {
          start: location.startOffset,
          end: location.endOffset,
          text: `<style${media != null ? ` media="${escapeAttribute(media)}"` : ""}>${css.replace(/<\/style/gi, "<\\/style")}</style>`,
        },
      ];
    }

    if (tag === "script" && isLocalReference(attr.get("src") ?? "")) {
      const script = await this.readText(attr.get("src") ?? "", this.root);
      if (script == null) return [];
      return [
        {
          start: location.startOffset,
          end: location.endOffset,
          text: `<script${attributes(element, "src")}>${script.text.replace(/<\/script/gi, "<\\/script")}</script>`,
        },
      ];
    }

    const edits: Edit[] = [];
    const embedded = [...(EMBEDDED_ATTRIBUTES[tag] ?? [])];
    if (
      tag === "link" &&
      rel.some((value) => value === "icon" || value === "apple-touch-icon")
    )
      embedded.push("href");
    for (const name of embedded) {
      const ref = attr.get(name);
      const at = location.attrs?.[name];
      if (ref == null || at == null || !isLocalReference(ref)) continue;
      const uri = await this.dataUri(ref, this.root);
      if (uri != null)
        edits.push({
          start: at.startOffset,
          end: at.endOffset,
          text: `${name}="${uri}"`,
        });
    }
    const style = attr.get("style");
    const styleAt = location.attrs?.style;
    if (style != null && styleAt != null && CSS_URL_RE.test(style)) {
      CSS_URL_RE.lastIndex = 0;
      const css = await this.inlineCss(style, this.root);
      if (css !== style)
        edits.push({
          start: styleAt.startOffset,
          end: styleAt.endOffset,
          text: `style="${escapeAttribute(css)}"`,
        });
    }
    if (tag === "style") {
      const text = element.childNodes.find(
        (child) => child.nodeName === "#text"
      );
      const textAt = text?.sourceCodeLocation;
      if (text != null && textAt != null) {
        const original = html.slice(textAt.startOffset, textAt.endOffset);
        const css = await this.inlineCss(original, this.root);
        if (css !== original)
          edits.push({
            start: textAt.startOffset,
            end: textAt.endOffset,
            text: css.replace(/<\/style/gi, "<\\/style"),
          });
      }
    }
    return edits;
  }

  async bundle(html: string): Promise<string> {
    const doc = parse(html, { sourceCodeLocationInfo: true });
    const edits: Edit[] = [];
    const walk = async (node: Node): Promise<void> => {
      if ("tagName" in node)
        edits.push(...(await this.elementEdits(node, html)));
      const children = "childNodes" in node ? node.childNodes : [];
      for (const child of children) await walk(child);
      if ("content" in node && node.content != null)
        await walk(node.content as unknown as Node);
    };
    await walk(doc as unknown as Node);
    let out = html;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return out;
  }
}

/** The page with the files beside it folded in; `root` is the page's folder. */
export const bundlePage = (
  html: string,
  root: string,
  scrub: Scrub
): Promise<string> => new PageBundler(root, scrub).bundle(html);
