/**
 * The folders a chat works in beyond its own: the ones the user attached or
 * added. The desktop owns the list (one per chat) and says it at spawn
 * (ABACUSAI_BOT_WORKSPACE_FOLDERS) and after every change (the
 * `workspace_folders` command). The sandbox, the file gate and the prompt read
 * it from here. Imports only node and the zone map, so main can use it too.
 */
import * as os from "node:os";
import * as path from "node:path";

import { modelPath } from "./model-path.js";
import { canonicalize } from "./sandbox/policy.js";
import { isWithin } from "./sandbox/secrets.js";
import { ownerZone } from "./sandbox/zones.js";

export const WORKSPACE_FOLDERS_ENV = "ABACUSAI_BOT_WORKSPACE_FOLDERS";

const parse = (raw: unknown): string[] | null =>
  Array.isArray(raw)
    ? [
        ...new Set(
          raw.filter(
            (entry): entry is string =>
              typeof entry === "string" && path.isAbsolute(entry)
          )
        ),
      ]
    : null;

const fromEnv = (raw: string | undefined): string[] => {
  try {
    return parse(raw != null && raw !== "" ? JSON.parse(raw) : null) ?? [];
  } catch {
    return [];
  }
};

let folders = fromEnv(process.env[WORKSPACE_FOLDERS_ENV]);

/** The folders the user added to this chat, beyond its own. */
export const hostWorkspaceFolders = (): readonly string[] => folders;

/** The desktop's latest list; an unreadable one leaves the last. */
export function setHostWorkspaceFolders(next: unknown): void {
  folders = parse(next) ?? folders;
}

/**
 * Why `real` (a resolved directory) cannot join a chat's folders, or null.
 * A folder is handed to the sandbox as writable, so the home folder, anything
 * holding it, a filesystem root and the sensitive zones (dotfolders,
 * ~/Library, system folders) never are.
 */
export function workspaceFolderRefusal(
  real: string,
  home: string = os.homedir()
): "folder-not-allowed" | null {
  if (path.parse(real).root === real) return "folder-not-allowed";
  const canonicalHome = canonicalize(home);
  if (isWithin(canonicalHome, real)) return "folder-not-allowed";
  return ownerZone(real, canonicalHome, true) === "sensitive"
    ? "folder-not-allowed"
    : null;
}

/**
 * Where the chat works and saves, for the prompt. Sits late in the prompt:
 * a folder added mid-chat rebuilds only from here.
 */
export function workspaceFoldersPrompt(
  chatFolder: string,
  added: readonly string[] = folders
): string {
  const lines = [
    `- ${modelPath(chatFolder)} (this chat's own folder)`,
    ...added.map((folder) => `- ${modelPath(folder)}`),
  ];
  return [
    "This chat's workspace folders (the user can preview files here, and add folders in the chat):",
    ...lines,
    "Work and save in these folders. New work goes beside the user's own files in a folder they gave you, otherwise in this chat's own folder; scratch files go in this chat's own folder too. Never hand over a file from the system temp folder, the home folder itself, or a folder you found by searching: the user cannot preview it. When the user names another place, save there.",
  ].join("\n");
}
