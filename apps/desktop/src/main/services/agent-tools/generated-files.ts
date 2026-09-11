/**
 * Where generated media lands.
 *
 * Media is returned to the model as a path, never base64: one image is a
 * megabyte that would evict the conversation from context. Files go under the
 * app's own directory, not the workspace, so no stray PNGs land in a repo.
 */
import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";

const GENERATED_DIR = (): string => path.join(abacusBotHome(), "generated");

/**
 * Write bytes to a uniquely named file and return its absolute path. The
 * counter guards against two calls in the same millisecond.
 */
let counter = 0;

export const writeGenerated = (
  prefix: string,
  extension: string,
  data: Buffer
): string => {
  const dir = GENERATED_DIR();
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(
    dir,
    `${prefix}-${Date.now()}-${++counter}.${extension}`
  );
  fs.writeFileSync(file, data);

  return file;
};

/** Refused rather than buffered, so a hostile URL cannot OOM the main process. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Reject URLs that don't resolve to a public https host. The URL comes from a
 * provider response, so a loopback, link-local or private target would make
 * this main-process fetch an SSRF primitive against the desktop's own network.
 */
export const assertPublicHttpsUrl = (raw: string): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The provider returned an invalid asset URL.");
  }

  if (url.protocol !== "https:")
    throw new Error(
      "Refusing to download a generated asset over a non-https URL."
    );

  const host = url.hostname.toLowerCase();
  const isBareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      host
    ) ||
    host === "0.0.0.0";

  if (isBareIp || isPrivate)
    throw new Error(
      "Refusing to download a generated asset from a private or loopback host."
    );
};

/** Fetch an asset a provider returned by URL, so the result is a local file. */
export const downloadGenerated = async (
  prefix: string,
  extension: string,
  url: string
): Promise<string> => {
  assertPublicHttpsUrl(url);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(
      `Could not download the generated file: ${response.status} ${response.statusText}`
    );
  }

  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error("The provider returned an oversized generated asset.");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES)
    throw new Error("The provider returned an oversized generated asset.");

  return writeGenerated(prefix, extension, bytes);
};

/**
 * Read a local path or public https URL as base64 plus a media type, so the
 * model need not care which form a provider wants.
 */
export const readAsBase64 = async (
  source: string
): Promise<{ base64: string; mediaType: string }> => {
  const extensionOf = (value: string): string =>
    path.extname(value).slice(1).toLowerCase();

  const mediaTypeFor = (ext: string): string => {
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "mp4") return "video/mp4";
    if (ext === "mov") return "video/quicktime";
    if (ext === "webm") return "video/webm";
    return "application/octet-stream";
  };

  if (/^https?:\/\//i.test(source)) {
    // `source` is a model argument: without the guard this is an SSRF primitive
    // that returns the bytes to the model.
    assertPublicHttpsUrl(source);
    const response = await fetch(source, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: "error",
    });

    if (!response.ok)
      throw new Error(
        `Could not fetch ${source}: ${response.status} ${response.statusText}`
      );

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim();

    return {
      base64: Buffer.from(await response.arrayBuffer()).toString("base64"),
      mediaType:
        contentType != null && contentType.length > 0
          ? contentType
          : mediaTypeFor(extensionOf(source)),
    };
  }

  if (!fs.existsSync(source)) throw new Error(`No such file: ${source}`);

  return {
    base64: fs.readFileSync(source).toString("base64"),
    mediaType: mediaTypeFor(extensionOf(source)),
  };
};
