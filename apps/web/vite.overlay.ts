/**
 * The deployment overlay of the browser build (apps/web/README.md,
 * "Deployment overlay"). A deployment points `ABACUS_WEB_OVERLAY` at an ES
 * module whose default export extends the served HTML and the Content
 * Security Policy at build time; the open-source build sets nothing and
 * ships the HTML and policy as they are. Loaded by `platformPlugin`
 * (vite.renderer.ts) for the browser platform only.
 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import type { HtmlTagDescriptor } from "vite";

export const WEB_OVERLAY_ENV = "ABACUS_WEB_OVERLAY";
export const CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "media-src",
  "worker-src",
  "object-src",
  "base-uri",
  "form-action",
] as const;
export type CspDirective = (typeof CSP_DIRECTIVES)[number];
export type WebOverlay = {
  /** Sources appended to the named directives of the base policy. */
  csp?: Partial<Record<CspDirective, string[]>>;
  /** Tags injected into the document; `injectTo` defaults to `head`. */
  head?: HtmlTagDescriptor[];
  /** Tags injected into the document; `injectTo` defaults to `body`. */
  body?: HtmlTagDescriptor[];
  /** Runs on the HTML after the tags, for what the tag API cannot express. */
  transformHtml?: (html: string) => string | Promise<string>;
  /** Merged into Vite's `define`; values are JSON-encoded, as Vite expects. */
  define?: Record<string, string>;
};
export type WebOverlayContext = {
  mode: string;
  command: "build" | "serve";
  env: Record<string, string | undefined>;
};
export type WebOverlayExport =
  | WebOverlay
  | ((context: WebOverlayContext) => WebOverlay | Promise<WebOverlay>);

// A declaration: only then does the `never` narrow the callers' checks.
function fail(message: string): never {
  throw new Error(`${WEB_OVERLAY_ENV}: ${message}`);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const assertTags = (field: "head" | "body", tags: unknown) => {
  if (!Array.isArray(tags)) fail(`"${field}" must be an array of tags`);
  tags.forEach((tag, index) => {
    if (!isRecord(tag) || typeof tag.tag !== "string" || tag.tag === "")
      fail(`"${field}[${index}]" must be a tag descriptor with a "tag" name`);
    if (
      tag.children !== undefined &&
      typeof tag.children !== "string" &&
      !Array.isArray(tag.children)
    )
      fail(`"${field}[${index}].children" must be a string or an array`);
  });
};
/** Throws unless `value` is a well-formed overlay; returns it typed. */
export const validateWebOverlay = (value: unknown): WebOverlay => {
  if (!isRecord(value)) fail("the overlay must be an object");
  for (const key of Object.keys(value))
    if (!["csp", "head", "body", "transformHtml", "define"].includes(key))
      fail(`unknown field "${key}"`);
  const { csp, head, body, transformHtml, define } = value;
  if (csp !== undefined) {
    if (!isRecord(csp)) fail('"csp" must be an object of directives');
    for (const [directive, sources] of Object.entries(csp)) {
      if (!(CSP_DIRECTIVES as readonly string[]).includes(directive))
        fail(`"csp.${directive}" is not a supported directive`);
      if (
        !Array.isArray(sources) ||
        !sources.every(
          (source) => typeof source === "string" && /^[^\s;,]+$/.test(source)
        )
      )
        fail(
          `"csp.${directive}" must be an array of single-token sources (no spaces, ";" or ",")`
        );
    }
  }
  if (head !== undefined) assertTags("head", head);
  if (body !== undefined) assertTags("body", body);
  if (transformHtml !== undefined && typeof transformHtml !== "function")
    fail('"transformHtml" must be a function');
  if (define !== undefined) {
    if (!isRecord(define)) fail('"define" must be an object');
    for (const [name, replacement] of Object.entries(define))
      if (typeof replacement !== "string")
        fail(`"define.${name}" must be a JSON-encoded string`);
  }
  return value as WebOverlay;
};
/**
 * The overlay the env names, resolved for `context`; `undefined` when the
 * env is unset. The module's default export is the overlay or a function of
 * the context returning it.
 */
export const loadWebOverlay = async (
  context: WebOverlayContext,
  env: Record<string, string | undefined> = process.env
): Promise<WebOverlay | undefined> => {
  const path = env[WEB_OVERLAY_ENV];
  if (!path) return undefined;
  if (!isAbsolute(path)) fail(`must be an absolute path, got "${path}"`);
  const module: unknown = await import(
    /* @vite-ignore */ pathToFileURL(path).href
  );
  const exported = (isRecord(module) ? module : { default: undefined })
    .default as WebOverlayExport | undefined;
  if (exported === undefined) fail(`${path} has no default export`);
  const overlay: unknown =
    typeof exported === "function" ? await exported(context) : exported;
  return validateWebOverlay(overlay);
};
/** `'sha256-<base64>'`: the CSP source for the exact inline text. */
export const cspHash = (text: string): string =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const parseCsp = (csp: string): [string, string[]][] =>
  csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [directive = "", ...sources] = part.split(/\s+/);
      return [directive, sources];
    });
const serializeCsp = (directives: [string, string[]][]): string =>
  directives.map(([d, s]) => [d, ...s].join(" ")).join("; ") + ";";
const fallback = (
  directives: [string, string[]][],
  directive: string
): string[] => {
  const find = (name: string) => directives.find(([d]) => d === name)?.[1];
  if (directive === "base-uri" || directive === "form-action") return [];
  if (directive === "worker-src")
    return find("script-src") ?? find("default-src") ?? [];
  return find("default-src") ?? [];
};
/**
 * `csp` with `additions` merged in. Each directive's sources are appended to
 * the existing directive, deduplicated and in order; a directive the policy
 * lacks is created once, seeded with the sources it fell back to (so adding
 * to it never drops what default-src allowed); a directive that is `'none'`
 * keeps `'none'` unless the addition lists sources for it, which replace it;
 * an empty list changes nothing. The result stays a single line.
 */
export const mergeCsp = (
  csp: string,
  additions: Partial<Record<string, string[]>>
): string => {
  const directives = parseCsp(csp);
  for (const [directive, sources = []] of Object.entries(additions)) {
    if (sources.length === 0) continue;
    let entry = directives.find(([d]) => d === directive);
    if (!entry) {
      entry = [directive, [...fallback(directives, directive)]];
      directives.push(entry);
    }
    if (entry[1].length === 1 && entry[1][0] === "'none'") entry[1] = [];
    for (const source of sources)
      if (!entry[1].includes(source)) entry[1].push(source);
  }
  return serializeCsp(directives);
};
const effective = (csp: string, directive: string): string[] => {
  const directives = parseCsp(csp);
  return (
    directives.find(([d]) => d === directive)?.[1] ??
    fallback(directives, directive)
  );
};
/**
 * The hashes of the overlay's inline `<script>` and `<style>` children, by
 * directive. A directive that already allows `'unsafe-inline'` gets none: a
 * hash would make browsers ignore that keyword and block every other inline
 * element on the page.
 */
export const inlineHashes = (
  csp: string,
  overlay: WebOverlay
): Partial<Record<CspDirective, string[]>> => {
  const hashes: Partial<Record<CspDirective, string[]>> = {};
  for (const tag of [...(overlay.head ?? []), ...(overlay.body ?? [])]) {
    const directive =
      tag.tag === "script"
        ? "script-src"
        : tag.tag === "style"
          ? "style-src"
          : undefined;
    if (!directive || typeof tag.children !== "string" || !tag.children)
      continue;
    if (effective(csp, directive).includes("'unsafe-inline'")) continue;
    (hashes[directive] ??= []).push(cspHash(tag.children));
  }
  return hashes;
};
/** The base policy with the overlay's directives and inline hashes merged. */
export const overlayCsp = (csp: string, overlay: WebOverlay): string => {
  const merged = mergeCsp(csp, overlay.csp ?? {});
  return mergeCsp(merged, inlineHashes(merged, overlay));
};
/** The overlay's tags with `injectTo` defaulted by section. */
export const overlayTags = (overlay: WebOverlay): HtmlTagDescriptor[] => [
  ...(overlay.head ?? []).map((tag) => ({ injectTo: "head" as const, ...tag })),
  ...(overlay.body ?? []).map((tag) => ({ injectTo: "body" as const, ...tag })),
];
