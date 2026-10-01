/**
 * Which document the main window loads (spec 01 §3.6): `index.html` for
 * the `wco` generation (renderer-next), else `index.html`. The legacy entry
 * keeps exactly the URL it always had (the base itself), so nothing about the
 * shipped renderer's location changes.
 */
import { join } from "node:path";

export const ENTRY = "index.html";

export type RendererBase =
  /** The Vite dev server (`VITE_DEV_SERVER_URL`). */
  | { kind: "dev"; url: string }
  /** An installed experience bundle (`app://bundle.<hash>/`). */
  | { kind: "experience"; url: URL }
  /** The asar baseline: `dist/renderer` beside `dist/main`. */
  | { kind: "file"; directory: string };

export type RendererEntry =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string };

export const rendererEntry = (base: RendererBase): RendererEntry => {
  switch (base.kind) {
    case "dev":
      return {
        kind: "url",
        url: new URL(ENTRY, base.url).href,
      };
    case "experience":
      return {
        kind: "url",
        url: new URL(ENTRY, base.url).href,
      };
    case "file":
      return {
        kind: "file",
        path: join(base.directory, ENTRY),
      };
  }
};

/** The swap target for an experience bundle, in this generation. */
export const experienceEntryUrl = (
  url: URL | null | undefined
): URL | null | undefined => {
  if (url == null) return url;
  return new URL(ENTRY, url);
};

/**
 * `ABACUSBOT_DEV_CONTENT_SIZE=<W>x<H>` (spec 01 §10.2): the screenshot run's
 * exact content size. Honoured only in an unpackaged app; null otherwise.
 */
export const devContentSize = (
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): { width: number; height: number } | null => {
  if (isPackaged) return null;
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(
    env.ABACUSBOT_DEV_CONTENT_SIZE ?? ""
  );
  if (match == null) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
};

export const NOTCH_ENTRY = "notch.html";
export const notchEntry = (base: RendererBase): RendererEntry =>
  base.kind === "file"
    ? { kind: "file", path: join(base.directory, NOTCH_ENTRY) }
    : { kind: "url", url: new URL(NOTCH_ENTRY, base.url).href };
