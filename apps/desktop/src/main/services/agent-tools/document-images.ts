/**
 * Making a remote `<img>` printable.
 *
 * Printing happens the moment the page loads, so a slow or dead remote image
 * prints as a gap. Every remote source is fetched to a local file first, or
 * dropped with a reason the caller is told about.
 */
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { assertPublicHttpsUrl } from "./generated-files";

/** Enough for a well-illustrated report; past this it is a gallery. */
const MAX_IMAGES = 40;

/** A print asset, not a download: bigger than this only slows the print. */
const MAX_BYTES = 12 * 1024 * 1024;

const TIMEOUT_MS = 20_000;

const EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

export interface ImageFetchReport {
  /** url -> the file name it was written to, relative to the document. */
  localised: Map<string, string>;
  /** Human-readable reasons, one per image that could not be used. */
  dropped: string[];
}

const SRC_PATTERN =
  /<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

/** Every distinct http(s) image source across the section bodies, in order. */
export const remoteImageSources = (
  htmlFragments: readonly string[]
): string[] => {
  const found: string[] = [];

  for (const fragment of htmlFragments) {
    for (const match of fragment.matchAll(SRC_PATTERN)) {
      const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
      if (/^https?:\/\//i.test(value) && !found.includes(value))
        found.push(value);
    }
  }

  return found;
};

/** Injectable only so tests can serve from loopback, which the guard forbids. */
export type UrlGuard = (url: string) => void;

const fetchOne = async (
  url: string,
  directory: string,
  index: number,
  assertUrl: UrlGuard
): Promise<string> => {
  // The URL comes from a model: loopback and private hosts stay out of reach.
  assertUrl(url);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);

  const type =
    (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
  const extension = EXTENSION[type];
  if (extension == null)
    throw new Error(
      `not an image (${type.length > 0 ? type : "no content-type"})`
    );

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("larger than 12MB");
  if (bytes.byteLength === 0) throw new Error("empty");

  // Content-addressed, so the same photo used in three sections is fetched and
  // written once.
  const name = `img-${index}-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8)}${extension}`;
  await fs.writeFile(path.join(directory, name), bytes);

  return name;
};

/**
 * Fetch every remote image into `directory`, next to the HTML being printed.
 * Never throws: an image that cannot be had is a line in `dropped`.
 */
export const localiseImages = async (
  htmlFragments: readonly string[],
  directory: string,
  assertUrl: UrlGuard = assertPublicHttpsUrl
): Promise<ImageFetchReport> => {
  const sources = remoteImageSources(htmlFragments);
  const report: ImageFetchReport = { localised: new Map(), dropped: [] };

  if (sources.length === 0) return report;

  for (const extra of sources.slice(MAX_IMAGES)) {
    report.dropped.push(`${extra}: past the ${MAX_IMAGES}-image limit`);
  }

  const wanted = sources.slice(0, MAX_IMAGES);
  const results = await Promise.all(
    wanted.map(async (url, index) => {
      try {
        return { url, name: await fetchOne(url, directory, index, assertUrl) };
      } catch (error) {
        return {
          url,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  for (const result of results) {
    if ("name" in result && result.name != null)
      report.localised.set(result.url, result.name);
    else
      report.dropped.push(
        `${result.url}: ${String((result as { error?: string }).error)}`
      );
  }

  return report;
};

/** Point each fetched `<img>` at its local copy; unfetched ones are dropped. */
export const rewriteImageSources = (
  html: string,
  localised: ReadonlyMap<string, string>
): string =>
  html.replace(SRC_PATTERN, (tag) => {
    const match = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
    const local = localised.get(value);

    return local == null ? tag : tag.replace(match![0], ` src="${local}"`);
  });
