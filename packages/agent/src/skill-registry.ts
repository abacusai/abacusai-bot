/**
 * Finding and installing skills, for the agent process: search skills.sh,
 * fetch the SKILL.md off GitHub, drop it in the skills directory. The
 * desktop's SkillsService does the same behind its dialog and cannot be
 * imported here; what must agree is the skills.sh response shape and the
 * `<dir>/<id>/SKILL.md` layout the agent's scanner reads.
 */
import fs from "fs";
import path from "path";

/** One search hit. `source` is the `owner/repo` the skill is published from. */
export interface MarketplaceSkill {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

const SEARCH_URL = (query: string): string =>
  `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`;

/**
 * Where a skill's SKILL.md might live in its repo. Publishers use several
 * layouts and the search result declares none, so each is probed; resolved in
 * this order so a repo answering on two paths installs the more specific one.
 */
const rawCandidates = (
  owner: string,
  repo: string,
  commit: string,
  skillId: string
): string[] =>
  [
    `${skillId}/SKILL.md`,
    `skills/${skillId}/SKILL.md`,
    // Curated monorepos (e.g. openai/skills → skills/.curated/<id>/SKILL.md).
    `skills/.curated/${skillId}/SKILL.md`,
    `.curated/${skillId}/SKILL.md`,
    `${skillId}.md`,
    `skills/${skillId}.md`,
    `SKILL.md`,
  ].map(
    (candidate) =>
      `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${candidate}`
  );

/**
 * A skill id, owner or repo as it goes into a raw GitHub URL. `..`, `%2e` and
 * a backslash (which URL parsing turns into `/`) would walk to another repo.
 */
function isSafeUrlSegment(segment: string): boolean {
  return (
    /^[\w.-]+$/.test(segment) && segment !== "." && !segment.includes("..")
  );
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The commit the repo's default branch points at now. Every file is fetched
 * from that one commit, so what installs is what was resolved and recorded,
 * not whatever the branch moves to between requests.
 */
async function resolveCommit(
  owner: string,
  repo: string
): Promise<string | null> {
  const response = await getText(
    `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`,
    { accept: "application/vnd.github.sha" }
  );
  if (response == null || response.status < 200 || response.status >= 300)
    return null;
  const sha = response.body.trim().toLowerCase();

  return COMMIT_SHA.test(sha) ? sha : null;
}

/** Lowercase, dashes for anything else: the id the on-disk scanner will derive. */
export function slugifySkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
}

async function getText(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "abacusai-bot", ...headers },
    });

    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  }
}

/**
 * Search skills.sh. An unreachable marketplace returns `error`, not an empty
 * list: "no skills found" for an outage would send the model off inventing one.
 */
export async function searchSkillMarketplace(
  query: string
): Promise<{ skills: MarketplaceSkill[]; error?: string }> {
  const trimmed = query.trim();
  if (trimmed === "") return { skills: [] };

  const response = await getText(SEARCH_URL(trimmed));
  if (response == null)
    return { skills: [], error: "Could not reach the skills marketplace." };
  if (response.status < 200 || response.status >= 300) {
    return {
      skills: [],
      error: `Marketplace request failed (HTTP ${response.status})`,
    };
  }

  try {
    const data = JSON.parse(response.body) as { skills?: unknown[] };
    const raw = Array.isArray(data.skills) ? data.skills : [];
    const skills = raw
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry != null && typeof entry === "object"
      )
      .filter(
        (entry) =>
          typeof entry.skillId === "string" &&
          typeof entry.name === "string" &&
          typeof entry.source === "string"
      )
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : (entry.skillId as string),
        skillId: entry.skillId as string,
        name: entry.name as string,
        source: entry.source as string,
        installs: typeof entry.installs === "number" ? entry.installs : 0,
      }));

    return { skills };
  } catch {
    return {
      skills: [],
      error: "The marketplace returned something unreadable.",
    };
  }
}

/**
 * The most SKILL.md we will write. A real skill is a few kilobytes; anything
 * this large is the wrong file or a disk-filler. Refused rather than
 * truncated, because half a skill misbehaves in ways nobody can read off it.
 */
const MAX_SKILL_BYTES = 1_000_000;

/**
 * Whether the fetched text is a skill at all. pi silently drops a skill whose
 * frontmatter has no description, so a README or a 404 served as 200 would
 * otherwise report as installed and then never appear.
 */
function looksLikeSkill(content: string): boolean {
  if (!/^\s*---\r?\n/.test(content)) return false;
  const end = content.indexOf("\n---", content.indexOf("---") + 3);
  const frontmatter = end === -1 ? content : content.slice(0, end);

  return /^description:/m.test(frontmatter);
}

/**
 * Fetch one skill's SKILL.md and write it into `targetDir` as `<id>/SKILL.md`:
 * the directory is where a skill's assets go and its name is the id.
 */
export async function installSkill(options: {
  skillId: string;
  source: string;
  targetDir: string;
  /** Overwrite a skill of the same id that is already installed. */
  replace?: boolean;
}): Promise<
  | { ok: true; id: string; path: string; existed: boolean; commit: string }
  | { ok: false; error: string; path?: string }
> {
  const leaf = options.skillId.split("/").pop() ?? options.skillId;
  if (!isSafeUrlSegment(leaf)) {
    return {
      ok: false,
      error: `"${options.skillId}" is not a usable skill id.`,
    };
  }
  // Slugified before it is joined to a path, after the URL check above.
  const id = slugifySkillId(leaf);
  if (id === "") {
    return {
      ok: false,
      error: `"${options.skillId}" is not a usable skill id.`,
    };
  }

  const [owner, repo] = options.source.split("/");
  if (
    owner == null ||
    repo == null ||
    !isSafeUrlSegment(owner) ||
    !isSafeUrlSegment(repo)
  ) {
    return {
      ok: false,
      error: `Source must be "owner/repo", got "${options.source}".`,
    };
  }

  const destDir = path.join(options.targetDir, id);
  const destPath = path.join(destDir, "SKILL.md");
  const existed = fs.existsSync(destPath);
  // A skill on disk may carry the user's edits; replacing it is a decision,
  // not a side effect of asking for the skill again.
  if (options.replace !== true && existed) {
    return {
      ok: false,
      error: `"${id}" is already installed.`,
      path: destPath,
    };
  }

  const commit = await resolveCommit(owner, repo);
  if (commit == null) {
    return {
      ok: false,
      error: `Could not resolve the current commit of ${options.source}.`,
    };
  }

  const responses = await Promise.all(
    rawCandidates(owner, repo, commit, leaf).map((url) => getText(url))
  );
  const hit = responses.find(
    (response) =>
      response != null &&
      response.status >= 200 &&
      response.status < 300 &&
      response.body.trim() !== ""
  );
  if (hit == null) {
    return {
      ok: false,
      error: `No SKILL.md for "${leaf}" in ${options.source}.`,
    };
  }
  if (Buffer.byteLength(hit.body, "utf8") > MAX_SKILL_BYTES) {
    return {
      ok: false,
      error: `The file served for "${leaf}" is too large to be a skill.`,
    };
  }
  if (!looksLikeSkill(hit.body)) {
    return {
      ok: false,
      error: `What ${options.source} served for "${leaf}" is not a skill: no description in its frontmatter, so nothing would load it.`,
    };
  }

  // Written through a pid-scoped temp file and renamed, so a half-downloaded
  // skill is never what the scanner picks up.
  const tmp = `${destPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(tmp, hit.body, "utf8");
    fs.renameSync(tmp, destPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }

    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, id, path: destPath, existed, commit };
}
