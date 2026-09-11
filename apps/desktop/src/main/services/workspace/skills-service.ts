import fs from "fs";
import https from "https";
import path from "path";

import { shell } from "electron";

import { decideLocalOpen } from "#main/local-open-guard";
import { WORKSPACE_DIR_NAME } from "#main/paths";
import { resourcePath } from "#main/resources";
import type {
  InstalledSkill,
  InstallSkillRequest,
  ListInstalledSkillsRequest,
  ListInstalledSkillsResult,
  MarketplaceSkill,
  OpenSkillFileRequest,
  RemoveSkillRequest,
  SearchMarketplaceSkillsRequest,
  SearchMarketplaceSkillsResult,
  SkillMutationResult,
  SkillSource,
} from "#shared/skills-types";

import { DESKTOP_DIR } from "../mcp/mcp-config-service";
import { environmentNoticeService } from "../providers/environment-notice-service";

// The bundled agent scans exactly two roots (`skillDirs` in packages/agent):
//   project : <workspace>/.abacusai-bot/skills
//   global  : ~/.abacusai-bot/skills
// The desktop UI scans the same two and nothing else, so the Skills dialog
// lists exactly what the agent loads. repairSelfLink() clears the self-link
// old builds left at the global dir.

/** The one global skills dir — written by the desktop, scanned by the agent. */
const GLOBAL_SKILLS_DIR = path.join(DESKTOP_DIR, "skills");

/**
 * Skills that ship with the app. Read-only either way: they are seeded into
 * the user's own skills directory, never edited in place.
 */
const bundledSkillsDir = (): string | null => {
  const dir = resourcePath("skills");
  try {
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
};

/**
 * Bundled skills are seeded at most once each, tracked in this ledger rather
 * than by folder presence: a presence check would restore a skill the user
 * deleted on every launch. The cost is that improvements to an already-seeded
 * skill do not reach someone with the old copy; silently overwriting an edited
 * skill would be worse.
 */
const SEED_LEDGER = path.join(DESKTOP_DIR, ".seeded-skills.json");

const readSeedLedger = (): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SEED_LEDGER, "utf8"));
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : []
    );
  } catch {
    return new Set();
  }
};

const writeSeedLedger = (ids: Set<string>): void => {
  try {
    fs.mkdirSync(path.dirname(SEED_LEDGER), { recursive: true });
    fs.writeFileSync(
      SEED_LEDGER,
      `${JSON.stringify([...ids], null, 2)}\n`,
      "utf8"
    );
  } catch {
    // A deleted skill would return next launch; not worth failing startup over.
  }
};

const seedBundledSkills = (targetDir: string): void => {
  const source = bundledSkillsDir();
  if (source == null) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return;
  }

  const seeded = readSeedLedger();
  let changed = false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (seeded.has(entry.name)) continue;

    const destination = path.join(targetDir, entry.name);
    try {
      // A same-named marketplace skill the user already has wins.
      if (!fs.existsSync(destination)) {
        fs.cpSync(path.join(source, entry.name), destination, {
          recursive: true,
        });
      }
      seeded.add(entry.name);
      changed = true;
    } catch {
      // One failed copy must not stop the rest or the app from starting.
    }
  }

  if (changed) writeSeedLedger(seeded);
};

const SKILLS_SH_SEARCH = (query: string): string =>
  `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`;

const githubRawCandidates = (
  owner: string,
  repo: string,
  skillId: string
): string[] =>
  [
    `${skillId}/SKILL.md`,
    `skills/${skillId}/SKILL.md`,
    // Curated-monorepo layouts (skills/.curated/<id>/SKILL.md).
    `skills/.curated/${skillId}/SKILL.md`,
    `.curated/${skillId}/SKILL.md`,
    `${skillId}.md`,
    `skills/${skillId}.md`,
    `SKILL.md`,
  ].map(
    (candidate) =>
      `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${candidate}`
  );

// Minimal line-based frontmatter reader; a handful of scalar fields is not
// worth a YAML dependency. Block scalars and multi-line plain values must work:
// a skill whose description parses to empty vanishes from the picker.

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Returns the scalar text and the index of the first line after the block. */
function readBlockScalar(
  lines: string[],
  start: number,
  folded: boolean,
  chomp: string
): { text: string; nextIndex: number } {
  const collected: string[] = [];
  let indent: number | null = null;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      collected.push("");
      continue;
    }
    if (indentOf(line) === 0) break; // next top-level key
    if (indent == null) indent = indentOf(line);
    collected.push(line.slice(Math.min(indent, indentOf(line))));
  }
  while (collected.length > 0 && collected[collected.length - 1] === "")
    collected.pop();

  let text: string;
  if (folded) {
    // Folded: single newlines become spaces, blank lines become newlines.
    text = collected.reduce((acc, line) => {
      if (line === "") return `${acc}\n`;
      if (acc === "" || acc.endsWith("\n")) return acc + line;
      return `${acc} ${line}`;
    }, "");
  } else {
    text = collected.join("\n");
  }
  // '-' strips the final newline; default and '+' keep one.
  if (chomp !== "-" && text.length > 0) text += "\n";
  return { text, nextIndex: i };
}

/** Indented lines after a key with an empty value, folded with spaces. */
function readContinuation(
  lines: string[],
  start: number
): { text: string; nextIndex: number } {
  const collected: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || indentOf(line) === 0) break;
    collected.push(line.trim());
  }
  return { text: collected.join(" "), nextIndex: i };
}

/**
 * Honours the quote style's escapes (`\"`, `''`); anything after the closing
 * quote is discarded and an unterminated quote keeps what was read.
 */
function unquoteScalar(value: string): string {
  const quote = value[0];
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (quote === '"' && ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i++;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return out;
    }
    out += ch;
  }
  return out;
}

function parseScalar(value: string): unknown {
  if (value[0] === '"' || value[0] === "'") return unquoteScalar(value);
  // Strip a trailing line comment only on unquoted values.
  const hash = value.indexOf(" #");
  const bare = (hash !== -1 ? value.slice(0, hash) : value).trim();
  if (bare === "true") return true;
  if (bare === "false") return false;
  return bare;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return {};
  const closing = trimmed.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (closing?.index == null) return {};
  const block = trimmed.slice(3, closing.index);

  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m == null) continue;
    const key = m[1];
    const rawValue = m[2].trim();

    // Block scalar (`key: |`, `key: >-`, …) — the value is the indented block.
    const blockHeader = rawValue.match(/^([|>])([+-]?)\s*(?:#.*)?$/);
    if (blockHeader != null) {
      const { text, nextIndex } = readBlockScalar(
        lines,
        i + 1,
        blockHeader[1] === ">",
        blockHeader[2]
      );
      out[key] = text;
      i = nextIndex - 1;
      continue;
    }

    // Empty value: either a plain multi-line continuation, or genuinely empty.
    if (rawValue === "") {
      const { text, nextIndex } = readContinuation(lines, i + 1);
      if (text !== "") {
        out[key] = text;
        i = nextIndex - 1;
      }
      continue;
    }

    out[key] = parseScalar(rawValue);
  }
  return out;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Reject path segments that could escape the target dir (`..`, separators). */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !/[\\/]/.test(segment)
  );
}

/** True when `target` is strictly inside `root` (boundary-aware, not substring). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ── HTTP helpers (Node https) ──────────────────────────────────────────────

function httpGet(
  url: string,
  maxRedirects = 5
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "abacusai-bot" } },
      (res) => {
        // A response-phase error (ECONNRESET mid-body) emits 'error' on `res`,
        // not `req`; without this the promise never settles and the IPC hangs.
        res.on("error", reject);
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (
          status >= 300 &&
          status < 400 &&
          location != null &&
          maxRedirects > 0
        ) {
          res.resume();
          const next = new URL(location, url).toString();
          httpGet(next, maxRedirects - 1).then(resolve, reject);
          return;
        }
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(20_000, () =>
      req.destroy(new Error("skills request timed out"))
    );
  });
}

// ── Async filesystem helpers ───────────────────────────────────────────────

/** Frontmatter lives at the top; the whole body is never needed. */
async function readHead(
  filePath: string,
  maxBytes = 16_384
): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Falls back to a lexical resolve for a not-yet-existing root. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class SkillsService {
  /** Memoizes the layout setup so list/install skip the migration syscalls. */
  private layoutEnsured = false;

  // ── Global skills layout (canonical dir + host link) ─────────────────────

  /**
   * Clear a `skills` symlink that points at itself and put back what it
   * displaced: the link was created by renaming the real directory to
   * `skills.backup-<timestamp>`, so restore the most recent one rather than
   * leave an empty skill list the user did not empty.
   */
  private repairSelfLink(): void {
    let stat: fs.Stats | null = null;

    try {
      stat = fs.lstatSync(GLOBAL_SKILLS_DIR);
    } catch {
      return; // nothing there: the normal first-run case
    }

    if (!stat.isSymbolicLink()) return;

    try {
      // recursive:false so this can only ever remove the link itself.
      fs.rmSync(GLOBAL_SKILLS_DIR, { recursive: false, force: true });
    } catch {
      return;
    }

    try {
      const parent = path.dirname(GLOBAL_SKILLS_DIR);
      const prefix = `${path.basename(GLOBAL_SKILLS_DIR)}.backup-`;
      const newest = fs
        .readdirSync(parent)
        .filter((name) => name.startsWith(prefix))
        .sort()
        .pop();

      if (newest != null)
        fs.renameSync(path.join(parent, newest), GLOBAL_SKILLS_DIR);
    } catch {
      // Non-fatal; the caller creates an empty directory next.
    }
  }

  /**
   * Idempotent: repairs the self-link older builds left behind, creates the
   * directory, and seeds the bundled skills.
   */
  ensureGlobalSkillsLayout(): void {
    if (this.layoutEnsured) return;

    this.repairSelfLink();

    try {
      fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
    } catch {
      return; // leave layoutEnsured false so we retry next time
    }

    seedBundledSkills(GLOBAL_SKILLS_DIR);
    this.layoutEnsured = true;
  }

  /** The dir global installs/removes/scans operate on. */
  private globalSkillsDir(): string {
    this.ensureGlobalSkillsLayout();
    return GLOBAL_SKILLS_DIR;
  }

  // ── Listing (session-independent disk scan) ──────────────────────────────

  async listInstalled(
    request: ListInstalledSkillsRequest
  ): Promise<ListInstalledSkillsResult> {
    const seen = new Map<string, InstalledSkill>();
    const add = (skill: InstalledSkill | null): void => {
      if (skill == null) return;
      const key = `${skill.source}:${skill.id}`;
      if (!seen.has(key)) seen.set(key, skill);
    };

    // Only the roots the bundled agent scans; anything else would list skills
    // the agent never loads.
    if (request.workspacePath != null && request.workspacePath.trim() !== "") {
      for (const s of await this.scanDir(
        path.join(request.workspacePath, WORKSPACE_DIR_NAME, "skills"),
        "project"
      ))
        add(s);
    }
    for (const s of await this.scanDir(this.globalSkillsDir(), "global"))
      add(s);

    return { skills: Array.from(seen.values()) };
  }

  private async scanDir(
    skillsDir: string,
    source: SkillSource
  ): Promise<InstalledSkill[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const out: InstalledSkill[] = [];
    for (const entry of entries) {
      // Case-insensitive so `Deploy.MD` is not skipped.
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const skill = await this.parseSkillFile(
          path.join(skillsDir, entry.name),
          false,
          source
        );
        if (skill != null) out.push(skill);
      } else if (entry.isDirectory()) {
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
        if (await pathExists(skillPath)) {
          const skill = await this.parseSkillFile(skillPath, true, source);
          if (skill != null) out.push(skill);
        }
      }
    }
    return out;
  }

  private async parseSkillFile(
    filePath: string,
    isDirectory: boolean,
    source: SkillSource
  ): Promise<InstalledSkill | null> {
    const content = await readHead(filePath);
    if (content == null) return null;
    const fm = parseFrontmatter(content);
    // Case-insensitive so 'Deploy.MD' → id 'deploy'.
    const rawId = isDirectory
      ? path.basename(path.dirname(filePath))
      : path.basename(filePath).replace(/\.md$/i, "");
    const id = slugify(rawId);
    if (id === "") return null;

    const rawName = fm.name;
    const rawDescription = fm.description;
    const name =
      typeof rawName === "string" && rawName.trim() !== ""
        ? rawName.trim()
        : id;
    const description =
      typeof rawDescription === "string" && rawDescription.trim() !== ""
        ? rawDescription.trim()
        : "";
    if (description === "") return null;
    if (fm["user-invocable"] === false) return null;

    const argumentHint =
      typeof fm["argument-hint"] === "string"
        ? (fm["argument-hint"] as string)
        : undefined;

    return {
      id,
      name,
      description,
      path: filePath,
      source,
      ...(argumentHint != null ? { argumentHint } : {}),
    };
  }

  // ── Marketplace search ───────────────────────────────────────────────────

  async searchMarketplace(
    request: SearchMarketplaceSkillsRequest
  ): Promise<SearchMarketplaceSkillsResult> {
    const query = request.query.trim();
    if (query === "") return { skills: [] };
    try {
      const { status, body } = await httpGet(SKILLS_SH_SEARCH(query));
      if (status < 200 || status >= 300) {
        // A service failure must not read as a genuine empty result.
        return {
          skills: [],
          error: `Marketplace request failed (HTTP ${status})`,
        };
      }
      const data = JSON.parse(body) as { skills?: unknown[] };
      const raw = Array.isArray(data.skills) ? data.skills : [];
      const skills: MarketplaceSkill[] = raw
        .filter((s): s is Record<string, unknown> => {
          if (s == null || typeof s !== "object") return false;
          const r = s as Record<string, unknown>;
          return (
            typeof r.id === "string" &&
            typeof r.skillId === "string" &&
            typeof r.name === "string" &&
            typeof r.source === "string"
          );
        })
        .map((s) => ({
          id: s.id as string,
          skillId: s.skillId as string,
          name: s.name as string,
          source: s.source as string,
          installs: typeof s.installs === "number" ? (s.installs as number) : 0,
        }));
      return { skills };
    } catch (err) {
      return {
        skills: [],
        error:
          err instanceof Error ? err.message : "Marketplace request failed",
      };
    }
  }

  // ── Install / remove ─────────────────────────────────────────────────────

  async install(request: InstallSkillRequest): Promise<SkillMutationResult> {
    try {
      const { skillId, source, scope, name } = request;
      const leaf = skillId.split("/").pop() ?? skillId;
      const fileId = slugify(leaf);
      if (!isSafeSegment(fileId) || fileId === "") {
        return { success: false, error: "Invalid skill id" };
      }

      let targetDir: string;
      if (scope === "project") {
        const ws = request.workspacePath;
        if (ws == null || ws.trim() === "") {
          return {
            success: false,
            error: "No workspace selected for project install",
          };
        }
        targetDir = path.join(ws, WORKSPACE_DIR_NAME, "skills");
      } else {
        targetDir = this.globalSkillsDir();
      }

      const [owner, repo] = source.split("/");
      if (owner == null || repo == null || owner === "" || repo === "") {
        return { success: false, error: "Invalid source format" };
      }

      // Probe layouts concurrently; take the first success in priority order.
      const candidates = githubRawCandidates(owner, repo, leaf);
      const responses = await Promise.all(
        candidates.map((url) => httpGet(url).catch(() => null))
      );
      let content: string | null = null;
      for (const res of responses) {
        if (
          res != null &&
          res.status >= 200 &&
          res.status < 300 &&
          res.body.trim() !== ""
        ) {
          content = res.body;
          break;
        }
      }
      if (content == null) {
        return {
          success: false,
          error: `Could not fetch skill content for "${name}" from ${source}`,
        };
      }

      // Directory form (`<id>/SKILL.md`), not flat: the directory is where assets
      // live and keeps the on-disk name (the id every scanner derives) unambiguous.
      const destDir = path.join(targetDir, fileId);
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, "SKILL.md");
      // pid-scoped temp name so concurrent installs don't clobber each other.
      const tmp = `${destPath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, content, "utf-8");
        fs.renameSync(tmp, destPath);
      } catch (writeErr) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best-effort cleanup */
        }
        throw writeErr;
      }
      // A running conversation was told which skills exist; say the list grew.
      environmentNoticeService.markChanged();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Import from local files/folders (always global scope) ─────────────────

  /**
   * `kind: 'file'` copies `<id>.md` files; `kind: 'folder'` copies folders
   * holding a `SKILL.md`. The id derives from the file/folder name, matching
   * the scanner, so the resulting `/id` is predictable. Always global.
   */
  async importFromPaths(request: {
    paths: string[];
    kind: "file" | "folder";
  }): Promise<SkillMutationResult & { imported?: number }> {
    const { paths, kind } = request;
    if (!Array.isArray(paths) || paths.length === 0) {
      return { success: false, error: "No skills selected" };
    }
    const targetDir = this.globalSkillsDir();
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let imported = 0;
    const errors: string[] = [];
    for (const src of paths) {
      try {
        if (kind === "folder") await this.importFolder(src, targetDir);
        else await this.importFile(src, targetDir);
        imported++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (imported === 0) {
      return {
        success: false,
        error: errors[0] ?? "Could not import the selected skill",
      };
    }
    environmentNoticeService.markChanged();
    return { success: true, imported };
  }

  /** id from the filename, to match how the scanner derives the `/command`. */
  private async importFile(src: string, targetDir: string): Promise<void> {
    if (!src.toLowerCase().endsWith(".md"))
      throw new Error("Only .md skill files are supported");
    const content = await fs.promises.readFile(src, "utf-8");
    const id = slugify(path.basename(src).replace(/\.md$/i, ""));
    if (!isSafeSegment(`${id}.md`) || id === "")
      throw new Error(`Invalid skill name in ${path.basename(src)}`);
    const destPath = path.join(targetDir, `${id}.md`);
    const tmp = `${destPath}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmp, content, "utf-8");
      await fs.promises.rename(tmp, destPath);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** id from the folder name; re-importing the same id replaces the dir. */
  private async importFolder(src: string, targetDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(src);
    } catch {
      throw new Error(`Could not read folder "${path.basename(src)}"`);
    }
    if (!entries.some((e) => e.toLowerCase() === "skill.md")) {
      throw new Error(`Folder "${path.basename(src)}" has no SKILL.md`);
    }
    const id = slugify(path.basename(src));
    if (!isSafeSegment(id) || id === "")
      throw new Error(`Invalid skill folder name "${path.basename(src)}"`);
    const dest = path.join(targetDir, id);
    // Guard: never let a crafted name resolve outside the global dir.
    if (!isInside(targetDir, dest))
      throw new Error("Refusing to import outside the skills directory");
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.cp(src, dest, { recursive: true });
  }

  remove(request: RemoveSkillRequest): SkillMutationResult {
    try {
      const rawTarget = path.resolve(request.path);
      if (!fs.existsSync(rawTarget))
        return { success: false, error: "Skill file not found" };

      // The same two roots the agent scans (builtins are never an allowed root).
      // Resolve symlinks on both sides before the boundary check, or a symlinked
      // component could smuggle the delete outside a skills dir.
      const ws = request.workspacePath;
      const realRoots = [
        GLOBAL_SKILLS_DIR,
        ...(ws != null && ws.trim() !== ""
          ? [path.join(ws, WORKSPACE_DIR_NAME, "skills")]
          : []),
      ].map(safeRealpath);

      const realTarget = safeRealpath(rawTarget);
      // Boundary-check what is actually deleted: a stray SKILL.md sitting
      // directly in a skills root (whose dirname is the root) must not wipe the
      // whole directory.
      const isDirSkill = path.basename(realTarget) === "SKILL.md";
      const deleteTarget = isDirSkill ? path.dirname(realTarget) : realTarget;

      if (!realRoots.some((root) => isInside(root, deleteTarget))) {
        return {
          success: false,
          error: "Refusing to remove a skill outside a skills directory",
        };
      }

      fs.rmSync(deleteTarget, { recursive: isDirSkill, force: true });
      environmentNoticeService.markChanged();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async openFile(request: OpenSkillFileRequest): Promise<SkillMutationResult> {
    try {
      // Same roots remove() enforces; opening gets the same boundary as deleting.
      const ws = request.workspacePath;
      const roots = [
        GLOBAL_SKILLS_DIR,
        ...(ws != null && ws.trim() !== ""
          ? [path.join(ws, WORKSPACE_DIR_NAME, "skills")]
          : []),
      ];
      const decision = decideLocalOpen(request.path, roots);
      if (decision.action === "refuse") {
        return {
          success: false,
          error: "Refusing to open a file outside a skills directory",
        };
      }
      // A helper script shipped with a skill is something the OS would run, so
      // it is revealed in the file manager instead, as the rest of the app does.
      if (decision.action === "reveal") {
        shell.showItemInFolder(decision.path);
        return { success: true };
      }
      const result = await shell.openPath(decision.path);
      if (result !== "") return { success: false, error: result };
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
