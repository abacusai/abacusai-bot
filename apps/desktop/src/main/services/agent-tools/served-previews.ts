/**
 * The directories `serve` handed out, remembered across restarts. A served
 * page lives only as long as this process, but its URL lives on in the chat's
 * files card, the pane's tabs and the agent's next turn: after a restart (an
 * update installs itself by restarting) that URL answered nothing and the
 * app read as broken. So the port each directory was served on is kept on
 * disk, serving a directory again takes the same port, and opening a URL
 * whose server is down brings its directory back up first.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import { isLoopbackUrl } from "@abacus-ai/agent/deliverable-url";

import { abacusBotHome } from "../../paths";
import {
  listServed,
  serveDirectory,
  stopDirectory,
  type ServedDirectory,
} from "./static-server";

const SERVED_PREVIEWS_FILE = "served-previews.json";
/** Directories remembered, the least recently served dropped first. */
const MAX_SERVED_PREVIEWS = 200;

interface ServedPreview {
  directory: string;
  port: number;
}

const storePath = (): string =>
  path.join(abacusBotHome(), SERVED_PREVIEWS_FILE);

const isServedPreview = (value: unknown): value is ServedPreview => {
  const entry = value as Partial<ServedPreview> | null;
  return (
    typeof entry?.directory === "string" &&
    typeof entry.port === "number" &&
    Number.isInteger(entry.port) &&
    entry.port > 0
  );
};

/** Oldest first. A file that is missing means nothing was served yet. */
const readPreviews = (): ServedPreview[] => {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isServedPreview) : [];
  } catch (error) {
    // Only a memory of URLs: unreadable, it is started over, not fatal.
    console.error(
      `[serve] ${SERVED_PREVIEWS_FILE} is unreadable, starting over: ${(error as Error).message}`
    );
    return [];
  }
};

const writePreviews = (previews: ServedPreview[]): void => {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileAtomicSync(
    storePath(),
    `${JSON.stringify(previews.slice(-MAX_SERVED_PREVIEWS), null, 2)}\n`
  );
};

/** `directory` is now served on `port`: the newest entry, and the only one for either. */
const remember = (directory: string, port: number): void => {
  const others = readPreviews().filter(
    (entry) => entry.directory !== directory && entry.port !== port
  );
  writePreviews([...others, { directory, port }]);
};

/** Serves `directory` on the port it had before, if it had one, and remembers it. */
export const servePreview = async (
  directory: string
): Promise<ServedDirectory> => {
  const root = path.resolve(directory);
  const before = readPreviews().find((entry) => entry.directory === root);
  const served = await serveDirectory(root, before?.port);
  if (before?.port !== served.port) remember(served.directory, served.port);
  return served;
};

/** Stops serving `directory` and forgets it: its URL is meant to be dead now. */
export const stopPreview = (directory: string): boolean => {
  const root = path.resolve(directory);
  const stopped = stopDirectory(root);
  const previews = readPreviews();
  const kept = previews.filter((entry) => entry.directory !== root);
  if (kept.length !== previews.length) writePreviews(kept);
  return stopped;
};

/**
 * The URL to open for `url`. A loopback URL whose port a served directory
 * had, and that nothing of ours serves now, gets that directory served again
 * first; on another port if something else took this one, and the URL then
 * names that port. Any other URL is returned as it is. A directory that is
 * gone (or empty) is forgotten: there is nothing left to bring back.
 */
export const revivePreview = async (url: string): Promise<string> => {
  if (!isLoopbackUrl(url)) return url;
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (port === 0 || listServed().some((served) => served.port === port))
    return url;
  const known = readPreviews().find((entry) => entry.port === port);
  if (known == null) return url;

  let served: ServedDirectory;
  try {
    served = await serveDirectory(known.directory, port);
  } catch (error) {
    console.warn(
      `[serve] could not bring a served directory back: ${(error as Error).message}`
    );
    writePreviews(readPreviews().filter((entry) => entry.port !== port));
    return url;
  }
  if (served.port === port) return url;
  remember(served.directory, served.port);
  parsed.port = String(served.port);
  return parsed.href;
};
