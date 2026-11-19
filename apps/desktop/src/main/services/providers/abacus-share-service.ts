import crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { namesSecretFile } from "@abacus-ai/agent/secret-files";
import {
  isLivePage,
  isShareableFile,
  SHARE_MAX_BYTES,
  SHARE_REFUSALS,
  SHARE_TEXT_EXTENSIONS,
  shareExtension,
  type ArtifactAccess,
  type ArtifactPublished,
  type LivePage,
  type PagePreview,
  type ShareCreated,
  type SharedLink,
  type SharePreview,
  type ShareRefusal,
} from "@abacus-ai/contract/share";

import { scrubKeys } from "../diagnostics/scrub";
import { abacusApiCall } from "./abacus-connector-service";
import { bundlePage } from "./share-bundle";

/**
 * Public links to files the bot made. The platform renders and hosts them;
 * here a file is checked and cleaned before it leaves the machine. The
 * platform repeats the cleaning: this copy keeps secrets from being sent at
 * all, that one keeps them off a public page whatever a client sends.
 */

const UPLOAD_TIMEOUT_MS = 60_000;
const SOURCE_KEY_CHARS = 32;

interface ShareFile {
  fileName: string;
  contentBase64: string;
  sourceKey: string;
}

type ReadFile =
  | { ok: true; file: ShareFile }
  | { ok: false; code: ShareRefusal };

/** One key per file, from its real path: the same file finds its link again. */
const sourceKeyOf = (realPath: string): string =>
  crypto
    .createHash("sha256")
    .update(realPath)
    .digest("hex")
    .slice(0, SOURCE_KEY_CHARS);

const refusal = (value: unknown): ShareRefusal =>
  SHARE_REFUSALS.find((code) => code === value) ?? "FAILED";

/** Home folders in the text go down to the file's own name. */
export const scrubForShare = (text: string): string =>
  scrubKeys(text).replace(
    /(?:file:\/+)?(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+Users[\\/]+)[^\s"'<>`)\]]+/g,
    (found) => found.split(/[\\/]/).filter(Boolean).pop() ?? ""
  );

const readShareFile = async (filePath: string): Promise<ReadFile> => {
  if (!isShareableFile(filePath)) return { ok: false, code: "UNSUPPORTED" };
  try {
    // The real path too: a link must not rename a key file into a report.
    const real = await fs.realpath(filePath);
    if (!isShareableFile(real)) return { ok: false, code: "UNSUPPORTED" };
    if (namesSecretFile(filePath) || namesSecretFile(real))
      return { ok: false, code: "SENSITIVE" };
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { ok: false, code: "UNSUPPORTED" };
    if (stat.size > SHARE_MAX_BYTES) return { ok: false, code: "TOO_LARGE" };
    const bytes = await fs.readFile(real);
    const content = SHARE_TEXT_EXTENSIONS.includes(shareExtension(real))
      ? Buffer.from(scrubForShare(bytes.toString("utf8")), "utf8")
      : bytes;
    return {
      ok: true,
      file: {
        fileName: path.basename(filePath),
        contentBase64: content.toString("base64"),
        sourceKey: sourceKeyOf(real),
      },
    };
  } catch {
    return { ok: false, code: "FAILED" };
  }
};

const asLink = (value: unknown): SharedLink | null => {
  if (value == null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.shareId !== "string" || typeof row.url !== "string")
    return null;
  return {
    shareId: row.shareId,
    url: row.url,
    title: typeof row.title === "string" ? row.title : "",
    sourceKey: typeof row.sourceKey === "string" ? row.sourceKey : "",
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
};

export const listShares = async (): Promise<SharedLink[] | null> => {
  const response = await abacusApiCall("_listAbacusaibotShares", "POST", {});
  if (!response.ok || response.result == null) return null;
  const rows = (response.result as { shares?: unknown }).shares;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((row) => asLink(row) ?? []);
};

const sendFile = async (
  file: ShareFile,
  lang: string,
  preview: boolean
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: ShareRefusal }
> => {
  const response = await abacusApiCall(
    "_createAbacusaibotShare",
    "POST",
    { ...file, lang, preview },
    UPLOAD_TIMEOUT_MS
  );
  if (!response.ok || response.result == null)
    return { ok: false, code: "FAILED" };
  const result = response.result as Record<string, unknown>;
  if (result.refused != null)
    return { ok: false, code: refusal(result.refused) };
  return { ok: true, result };
};

export const previewShare = async (
  filePath: string,
  lang: string
): Promise<SharePreview> => {
  const read = await readShareFile(filePath);
  if (read.ok === false) return read;
  const [sent, links] = await Promise.all([
    sendFile(read.file, lang, true),
    listShares(),
  ]);
  if (sent.ok === false) return sent;
  if (typeof sent.result.document !== "string")
    return { ok: false, code: "FAILED" };
  return {
    ok: true,
    title: typeof sent.result.title === "string" ? sent.result.title : "",
    document: sent.result.document,
    existing:
      links?.find((link) => link.sourceKey === read.file.sourceKey) ?? null,
  };
};

export const createShare = async (
  filePath: string,
  lang: string
): Promise<ShareCreated> => {
  const read = await readShareFile(filePath);
  if (read.ok === false) return read;
  const sent = await sendFile(read.file, lang, false);
  if (sent.ok === false) return sent;
  const link = asLink(sent.result.share);
  return link == null ? { ok: false, code: "FAILED" } : { ok: true, link };
};

export const removeShare = async (
  shareId: string
): Promise<{ ok: boolean }> => {
  const response = await abacusApiCall("_deleteAbacusaibotShare", "POST", {
    shareId,
  });
  return { ok: response.ok };
};

/** The page's own name, for the share page's tab. */
const pageTitle = (html: string): string =>
  /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || "Artifact";

/** The page as one file, with the files it loads from its folder folded in: what the link will show. */
const bundledPage = async (
  filePath: string
): Promise<
  | { ok: true; content: string; sourceKey: string }
  | { ok: false; code: ShareRefusal }
> => {
  if (!isLivePage(filePath)) return { ok: false, code: "UNSUPPORTED" };
  const read = await readShareFile(filePath);
  if (read.ok === false) return read;
  let content: string;
  try {
    content = await bundlePage(
      Buffer.from(read.file.contentBase64, "base64").toString("utf8"),
      path.dirname(await fs.realpath(filePath)),
      scrubForShare
    );
  } catch {
    return { ok: false, code: "FAILED" };
  }
  if (Buffer.byteLength(content, "utf8") > SHARE_MAX_BYTES)
    return { ok: false, code: "TOO_LARGE" };
  return { ok: true, content, sourceKey: read.file.sourceKey };
};

export const previewPage = async (filePath: string): Promise<PagePreview> => {
  const page = await bundledPage(filePath);
  return page.ok === false ? page : { ok: true, document: page.content };
};

export const publishArtifact = async (
  filePath: string,
  access: ArtifactAccess
): Promise<ArtifactPublished> => {
  const page = await bundledPage(filePath);
  if (page.ok === false) return page;
  const { content } = page;
  const response = await abacusApiCall(
    "_publishAbacusaibotArtifact",
    "POST",
    {
      identifier: page.sourceKey,
      title: pageTitle(content),
      content,
      access,
    },
    UPLOAD_TIMEOUT_MS
  );
  if (!response.ok || response.result == null)
    return { ok: false, code: "FAILED" };
  const result = response.result as Record<string, unknown>;
  if (result.refused != null)
    return { ok: false, code: refusal(result.refused) };
  if (typeof result.shareUrl !== "string") return { ok: false, code: "FAILED" };
  return {
    ok: true,
    url: result.shareUrl,
    access,
    updated: result.updated === true,
    identifier: page.sourceKey,
  };
};

export const unpublishArtifact = async (
  identifier: string
): Promise<{ ok: boolean }> => {
  const response = await abacusApiCall(
    "_unpublishAbacusaibotArtifact",
    "POST",
    { identifier }
  );
  return { ok: response.ok };
};

const asPage = (value: unknown): LivePage | null => {
  if (value == null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.identifier !== "string" || typeof row.shareUrl !== "string")
    return null;
  return {
    identifier: row.identifier,
    url: row.shareUrl,
    title: typeof row.title === "string" ? row.title : "",
    access: row.access === "public" ? "public" : "private",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
};

export const listPages = async (): Promise<LivePage[] | null> => {
  const response = await abacusApiCall("_listAbacusaibotArtifacts", "POST", {});
  if (!response.ok || response.result == null) return null;
  const rows = (response.result as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((row) => asPage(row) ?? []);
};

export const pageFor = async (filePath: string): Promise<LivePage | null> => {
  let identifier: string;
  try {
    identifier = sourceKeyOf(await fs.realpath(filePath));
  } catch {
    return null;
  }
  return (
    (await listPages())?.find((page) => page.identifier === identifier) ?? null
  );
};
