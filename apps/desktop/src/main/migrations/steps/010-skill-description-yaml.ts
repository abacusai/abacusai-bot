/**
 * Step 10: the copies of the bundled skills the app seeded into
 * `<home>/skills` before their descriptions were folded. Those descriptions
 * were plain YAML scalars holding ": ", which the agent's YAML frontmatter
 * parser rejects, so the agent dropped the skill while the Skills dialog
 * (its own lenient reader) still listed it. Seeding happens once per skill,
 * so a fixed bundle never reaches an existing copy; this step folds the one
 * line in place and leaves the rest of the file, edits included, as it is.
 * Only skills the app seeded are touched. Idempotent: a folded or quoted
 * description is left alone.
 */
import fs from "node:fs";
import path from "node:path";

import type { MigrationContext, MigrationStep, PlannedWrite } from "../types";

const SKILLS_DIR = "skills";
const SEED_LEDGER = ".seeded-skills.json";

/** A one-line plain `description:` that YAML cannot read as a plain scalar. */
const BROKEN_DESCRIPTION = /^description:[ \t]+(?!["'>|])(.*(?:: | #).*)$/m;

/** The folded form, or null when the frontmatter needs nothing. */
const foldSkillDescription = (content: string): string | null => {
  const closing = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (closing == null) return null;
  const head = closing[0];
  const match = head.match(BROKEN_DESCRIPTION);
  if (match == null) return null;
  const eol = head.includes("\r\n") ? "\r\n" : "\n";
  const folded = head.replace(
    BROKEN_DESCRIPTION,
    () => `description: >-${eol}  ${match[1].trimEnd()}`
  );
  return folded + content.slice(head.length);
};

const seededSkills = (ctx: MigrationContext): string[] => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(ctx.home, SEED_LEDGER), "utf8")
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (id): id is string =>
            typeof id === "string" && id !== "" && path.basename(id) === id
        )
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      ctx.log(`skill description yaml: ledger skipped: ${String(error)}`);
    return [];
  }
};

const planSkill = (ctx: MigrationContext, id: string): PlannedWrite | null => {
  const dest = path.join(ctx.home, SKILLS_DIR, id, "SKILL.md");
  let content: string;
  try {
    if (!fs.lstatSync(dest).isFile()) return null;
    content = fs.readFileSync(dest, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      ctx.log(`skill description yaml: ${id} skipped: ${String(error)}`);
    return null;
  }
  const folded = foldSkillDescription(content);
  if (folded == null) return null;
  const staged = path.join(ctx.staging, SKILLS_DIR, id, "SKILL.md");
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, folded, "utf8");
  return { dest, staged, kind: "replace-user" };
};

export const skillDescriptionYaml = (): MigrationStep => ({
  id: 10,
  name: "skill-description-yaml",
  plan: async (ctx) => {
    const writes = seededSkills(ctx).flatMap((id) => planSkill(ctx, id) ?? []);
    return { writes, removals: [], stats: { folded: writes.length } };
  },
});
