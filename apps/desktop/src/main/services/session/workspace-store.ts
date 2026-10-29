import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import { app } from "electron";
import Store from "electron-store";

import { abacusBotHome } from "../../paths";

/**
 * The `localCode.` prefix and the file name are on disk in every install.
 * Renaming a key here does not migrate anything; it orphans it.
 */
type WorkspaceStoreSchema = {
  "localCode.workspaces": unknown[];
  "localCode.activeWorkspaceId": string | null;
  "localCode.agentSessions": unknown[];
  "localCode.sessionArtifacts": unknown[];
  migrated_from_default_v1: boolean;
};

const STORE_FILE = "local-code.json";

/**
 * Move the store from Electron's userData into `~/.abacusai-bot`, beside
 * everything else the app keeps. Copied rather than moved so a downgrade
 * still opens its sessions; the copy runs once, since the new file wins.
 */
function migrateFromUserDataIfNeeded(): void {
  try {
    const destination = path.join(abacusBotHome(), STORE_FILE);

    if (fs.existsSync(destination)) return;

    const source = path.join(app.getPath("userData"), STORE_FILE);

    if (!fs.existsSync(source)) return;

    fs.mkdirSync(abacusBotHome(), { recursive: true });
    fs.copyFileSync(source, destination);
    // copyFileSync keeps the source mode, which may be world-writable. This
    // file chooses which directory the agent works in, so tighten it.
    try {
      fs.chmodSync(destination, 0o600);
    } catch {
      // Windows and some network filesystems have no POSIX modes.
    }
  } catch {
    // Non-fatal: an empty workspace list beats losing the window.
  }
}

migrateFromUserDataIfNeeded();

const writeFileAtomic = (file: string, text: string): void =>
  writeFileAtomicSync(file, text, { restrict: true });

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * The longest prefix of a torn file that ends after a whole record (a
 * value two containers below the root, or shallower), closed. Null when
 * nothing whole is left.
 */
function salvageTornJson(text: string): string | null {
  const stack: string[] = [];
  let cut = -1;
  let close = "";
  const mark = (at: number) => {
    if (stack.length === 0 || stack.length > 3) return;
    cut = at;
    close = [...stack].reverse().join("");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++)
        if (text[i] === "\\") i++;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      if (stack.length > 1) mark(i + 1);
    } else if (char === "}" || char === "]") {
      stack.pop();
      mark(i + 1);
    } else if (char === ",") mark(i);
  }
  if (cut < 0) return null;
  const salvaged = `${text.slice(0, cut)}${close}`;
  return parses(salvaged) ? salvaged : null;
}

/**
 * `clearInvalidConfig` reads a file that does not parse (a torn write) as
 * empty and overwrites it on the next write: keep its bytes beside it, then
 * put back the last copy that parsed, else the whole records it still holds.
 * A file that parses is that copy for the next launch.
 */
function keepUnparsableStoreFile(): void {
  const file = path.join(abacusBotHome(), STORE_FILE);
  const backup = `${file}.bak`;
  try {
    const text = fs.readFileSync(file, "utf8");
    if (parses(text)) {
      writeFileAtomic(backup, text);
      return;
    }
    fs.copyFileSync(
      file,
      `${file}.corrupt-${Date.now()}`,
      fs.constants.COPYFILE_EXCL
    );
    const last = fs.existsSync(backup) ? fs.readFileSync(backup, "utf8") : "";
    const restored = parses(last) ? last : salvageTornJson(text);
    if (restored == null) {
      console.error(
        `[workspace-store] ${STORE_FILE} does not parse and nothing in it could be recovered; its bytes are kept beside it`
      );
      return;
    }
    writeFileAtomic(file, restored);
    console.warn(
      `[workspace-store] ${STORE_FILE} did not parse; restored from ${restored === last ? `${STORE_FILE}.bak` : "its whole records"}`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`[workspace-store] could not check ${STORE_FILE}`, error);
  }
}

keepUnparsableStoreFile();

// Singleton shared by WorkspaceService and AgentSessionManagerService so
// concurrent persist() calls cannot race.
const store = new Store<WorkspaceStoreSchema>({
  name: "local-code",
  cwd: abacusBotHome(),
  clearInvalidConfig: true,
});

// One-time copy from the unnamed default store (config.json) into this one.
function migrateFromDefaultStoreIfNeeded(): void {
  if (store.get("migrated_from_default_v1")) return;

  try {
    const defaultStore = new Store({ clearInvalidConfig: true });
    const oldWorkspaces = defaultStore.get("localCode.workspaces");
    const oldSessions = defaultStore.get("localCode.agentSessions");
    const oldActiveId = defaultStore.get("localCode.activeWorkspaceId");

    const hasOldData = Array.isArray(oldWorkspaces) && oldWorkspaces.length > 0;
    // A partial earlier attempt may have written a stale empty array.
    const existing = store.get("localCode.workspaces");
    const newStoreHasData =
      Array.isArray(existing) && (existing as unknown[]).length > 0;

    if (hasOldData && !newStoreHasData) {
      store.set("localCode.workspaces", oldWorkspaces as unknown[]);
      store.set(
        "localCode.activeWorkspaceId",
        typeof oldActiveId === "string" ? oldActiveId : null
      );
      if (Array.isArray(oldSessions)) {
        store.set("localCode.agentSessions", oldSessions as unknown[]);
      }
    }

    // Clean up even when the copy was skipped: these keys must leave config.json.

    const d = defaultStore as any;
    d.delete("localCode.workspaces");
    d.delete("localCode.activeWorkspaceId");
    d.delete("localCode.agentSessions");

    // Mark only on success; a flag written after a throw would strand old data.
    store.set("migrated_from_default_v1", true);
  } catch {
    // Non-fatal: the flag was not written, so the next start retries.
  }
}

migrateFromDefaultStoreIfNeeded();

export { store as workspaceStore };
