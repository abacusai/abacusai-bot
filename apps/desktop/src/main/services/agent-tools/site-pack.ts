/**
 * The project zip for Abacus AI Agent on the web: a site's folder, without
 * what is never sent (dependencies, build caches, anything that may hold a
 * key), plus the conversation that built it. Made off the main thread's
 * critical path, with progress and a cancel.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { isSecretFileName } from "@abacus-ai/agent/secret-files";
import { visibleUserText } from "@abacus-ai/agent/user-text";
import type { UIMessage } from "@abacus-ai/contract/contract";
import {
  SITE_ZIP_CONVERSATION,
  SITE_ZIP_LIMITS,
  type SitePack,
  type SitePackProgress,
} from "@abacus-ai/contract/site-deploy";

import { abacusBotHome, sessionDefaultWorkspace } from "../../paths";
import { hasKey, scrubKeys } from "../diagnostics/scrub";
import { buildZip, crc32, type ZipFile } from "../diagnostics/zip-write";

const deflateRaw = promisify(zlib.deflateRaw);

/** Folders never sent: dependencies, history, build and tool caches. */
const LEFT_OUT_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  ".venv",
  "venv",
  "__pycache__",
  ".abacusai-bot",
  ".parcel-cache",
  ".svelte-kit",
]);

/** Files never sent: OS litter. */
const LEFT_OUT_FILES = new Set([".DS_Store", "Thumbs.db"]);

/** Text files read whole for key shapes; larger ones are sent as they are. */
const KEY_SCAN_BYTES = 1024 * 1024;

/** Folders in home that hold a person's things rather than one project, as paths from home. */
const HOME_FOLDER =
  /^(?:onedrive[^/\\]*[/\\])?(?:desktop|documents|downloads|pictures|photos|movies|videos|music|public|favorites|contacts|links|searches|saved games|3d objects|onedrive[^/\\]*|dropbox|google drive|icloud drive)$/i;

/** Apps' own folders in home: nothing under them is a project. */
const HOME_APP_FOLDER = /^(?:library|appdata)(?:[/\\]|$)/i;

/** Temp folders beside os.tmpdir(), which is per-user on macOS and Windows. */
const SYSTEM_TEMP_DIRS = ["/tmp", "/var/tmp", "/dev/shm"];

export class SiteTooBigError extends Error {}

const within = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

/** Where a path really is, so a link cannot stand in for a refused folder. */
const realDir = (dir: string): string => {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
};

/**
 * Not a site's own folder: the file system root, the home folder or above
 * it, home's standard folders, a temp folder, the app's own folder, or the
 * root of a workspace the app made for itself (the auto workspace, a bot's),
 * which holds other chats' files too. A file left in any of these has no
 * folder of its own.
 */
export const siteDirTooBroad = (
  siteDir: string,
  workspaceRoot: string | null,
  homeDir = os.homedir(),
  botHomeDir = abacusBotHome()
): boolean => {
  const dir = realDir(siteDir);
  const home = realDir(homeDir);
  const botHome = realDir(botHomeDir);
  if (dir === path.parse(dir).root) return true;
  if (within(home, dir) || within(botHome, dir)) return true;
  const fromHome = path.relative(home, dir);
  if (HOME_FOLDER.test(fromHome) || HOME_APP_FOLDER.test(fromHome)) return true;
  // Both spellings: macOS's /tmp is really /private/tmp, and a folder not made yet has no real path.
  const named = [os.tmpdir(), ...SYSTEM_TEMP_DIRS];
  const temps = [...named, ...named.map(realDir)];
  if (temps.some((temp) => within(temp, dir))) return true;
  if (!within(dir, home) && temps.some((temp) => within(dir, temp)))
    return true;
  if (dir === realDir(sessionDefaultWorkspace())) return true;
  if (workspaceRoot == null) return false;
  const workspace = realDir(workspaceRoot);
  return within(workspace, botHome) && workspace === dir;
};

/** The chat as a readable file: what was asked and answered, in order. */
export const conversationMarkdown = (
  title: string,
  messages: readonly UIMessage[]
): string => {
  const blocks = [`# ${title}`];
  for (const message of messages) {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("\n\n");
    const words = message.role === "user" ? visibleUserText(text) : text.trim();
    if (words.length === 0) continue;
    blocks.push(
      `## ${message.role === "user" ? "User" : "Assistant"}\n\n${words}`
    );
  }
  return `${blocks.join("\n\n")}\n`;
};

interface Walked {
  files: { relative: string; absolute: string; size: number; modified: Date }[];
  leftOut: Set<string>;
  heldBack: string[];
}

const walk = async (
  root: string,
  signal: AbortSignal,
  progress: (files: number) => void
): Promise<Walked> => {
  const out: Walked = { files: [], leftOut: new Set(), heldBack: [] };
  let total = 0;
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      signal.throwIfAborted();
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      // A link could point anywhere: never followed, never sent.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (LEFT_OUT_DIRS.has(entry.name)) out.leftOut.add(entry.name);
        else if (isSecretFileName(entry.name))
          out.heldBack.push(`${relative}/`);
        else await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (LEFT_OUT_FILES.has(entry.name)) continue;
      if (isSecretFileName(entry.name)) {
        out.heldBack.push(relative);
        continue;
      }
      const stat = await fs.stat(absolute);
      total += stat.size;
      if (
        stat.size > SITE_ZIP_LIMITS.fileBytes ||
        total > SITE_ZIP_LIMITS.totalBytes ||
        out.files.length >= SITE_ZIP_LIMITS.files
      )
        throw new SiteTooBigError();
      out.files.push({
        relative,
        absolute,
        size: stat.size,
        modified: stat.mtime,
      });
      progress(out.files.length);
    }
  };
  await visit(root);
  return out;
};

/** A real key in a small text file: the file is held back whole, never edited. */
const holdsKey = (content: Buffer): boolean =>
  content.length <= KEY_SCAN_BYTES &&
  !content.includes(0) &&
  hasKey(content.toString("utf8"));

/** A file name from the folder's: letters, digits and dashes. */
const zipName = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "site";

export interface PackSiteOptions {
  siteDir: string;
  /** The chat that built it, written into the zip. */
  messages: readonly UIMessage[];
  /** Where the zip is written. */
  outDir: string;
  signal: AbortSignal;
  onProgress: (progress: SitePackProgress) => void;
}

/** Packs `siteDir`; never throws for an expected outcome, only says which it was. */
export const packSite = async (options: PackSiteOptions): Promise<SitePack> => {
  const root = path.resolve(options.siteDir);
  const name = path.basename(root);
  const { signal } = options;
  try {
    const stat = await fs.stat(root).catch(() => null);
    if (stat?.isDirectory() !== true) return { state: "none" };
    let bytes = 0;
    const walked = await walk(root, signal, (files) =>
      options.onProgress({ files, bytes })
    );
    const entries: ZipFile[] = [];
    let zipped = 0;
    for (const file of walked.files) {
      signal.throwIfAborted();
      const content = await fs.readFile(file.absolute);
      if (holdsKey(content)) {
        walked.heldBack.push(file.relative);
        continue;
      }
      const data = await deflateRaw(content);
      zipped += data.length;
      if (zipped > SITE_ZIP_LIMITS.zipBytes) throw new SiteTooBigError();
      entries.push({
        name: `${name}/${file.relative}`,
        content,
        modified: file.modified,
        deflated: { data, crc: crc32(content) },
      });
      bytes += content.length;
      options.onProgress({ files: entries.length, bytes });
    }
    if (entries.length === 0) return { state: "none" };
    const conversation = Buffer.from(
      scrubKeys(conversationMarkdown(name, options.messages))
    );
    entries.push({ name: SITE_ZIP_CONVERSATION, content: conversation });
    signal.throwIfAborted();
    const zip = buildZip(entries);
    if (zip.length > SITE_ZIP_LIMITS.zipBytes)
      return { state: "too-big", name };
    await fs.mkdir(options.outDir, { recursive: true });
    const target = path.join(options.outDir, `${zipName(name)}.zip`);
    await fs.writeFile(target, zip);
    return {
      state: "ready",
      path: target,
      name,
      files: entries.length - 1,
      bytes: zip.length,
      leftOut: [...walked.leftOut].sort(),
      heldBack: walked.heldBack.sort(),
    };
  } catch (error) {
    if (error instanceof SiteTooBigError) return { state: "too-big", name };
    if (signal.aborted) return { state: "cancelled" };
    console.warn(
      `[site-pack] could not pack the site: ${(error as Error).message}`
    );
    return { state: "failed" };
  }
};

/** Where project zips are written; a drag or a reveal may only name a file in here. */
export const siteExportsDir = (): string =>
  path.join(abacusBotHome(), "exports");

/** One chat's zips: two chats' sites can share a folder name, never a zip. */
export const siteExportDir = (sessionId: string): string =>
  path.join(
    siteExportsDir(),
    createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  );

export const isSiteExport = (file: string): boolean =>
  within(path.resolve(file), siteExportsDir()) &&
  path.resolve(file) !== siteExportsDir();

/** One pack at a time per id, readable while it runs and cancellable. */
export class SitePacker {
  private readonly running = new Map<
    string,
    { controller: AbortController; progress: SitePackProgress }
  >();

  async pack(
    packId: string,
    options: Omit<PackSiteOptions, "signal" | "onProgress">
  ): Promise<SitePack> {
    this.cancel(packId);
    const job = {
      controller: new AbortController(),
      progress: { files: 0, bytes: 0 },
    };
    this.running.set(packId, job);
    try {
      return await packSite({
        ...options,
        signal: job.controller.signal,
        onProgress: (progress) => {
          job.progress = progress;
        },
      });
    } finally {
      if (this.running.get(packId) === job) this.running.delete(packId);
    }
  }

  progress(packId: string): SitePackProgress | null {
    return this.running.get(packId)?.progress ?? null;
  }

  cancel(packId: string): void {
    this.running.get(packId)?.controller.abort();
  }
}
