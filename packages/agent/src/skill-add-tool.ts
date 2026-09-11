/**
 * `skill_add` — installs a skill from inside the conversation. One call covers
 * search and install because the model rarely knows a skill's repo: with no
 * `source` a clear match installs and an ambiguous one returns a shortlist.
 * The result carries the path because the skill list the model sees is fixed
 * for the turn in flight; reading the file is how it acts on it right away.
 */
import { Type } from "typebox";

import {
  installSkill,
  searchSkillMarketplace,
  slugifySkillId,
  type MarketplaceSkill,
} from "./skill-registry.js";

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export const SKILL_ADD_TOOL_NAME = "skill_add";

/** Off with its toolset, like every other tool the panel can withhold. */
export function skillAddEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes(SKILL_ADD_TOOL_NAME);
}

export interface SkillAddContext {
  /** The two directories the agent scans, so `scope` can pick one by name. */
  skillDirs: () => { project: string; global: string };
  /** Re-scan skills so the new one is live in this session. */
  onInstalled: () => Promise<void> | void;
}

const text = (value: string): { type: "text"; text: string } => ({
  type: "text" as const,
  text: value,
});

/**
 * A hit good enough to install without asking: the query names it outright.
 * Several publishers ship the same id; the first (best-ranked) wins, and the
 * result names its source so a wrong guess is one call from corrected.
 */
function exactMatch(
  query: string,
  skills: MarketplaceSkill[]
): MarketplaceSkill | undefined {
  const wanted = slugifySkillId(query);

  return skills.find(
    (skill) =>
      slugifySkillId(skill.skillId) === wanted ||
      slugifySkillId(skill.name) === wanted
  );
}

/**
 * The candidates, written as the call that installs each one: a model handed
 * bare names re-searches with a narrower query instead of picking.
 */
function shortlist(skills: MarketplaceSkill[]): string {
  return skills
    .slice(0, 10)
    .map(
      (skill) =>
        `query "${skill.skillId}", source "${skill.source}" — ${skill.name} (${skill.installs} installs)`
    )
    .join("\n");
}

export function buildSkillAddTool(
  context: SkillAddContext
): PiToolDefinitionLike {
  return {
    name: SKILL_ADD_TOOL_NAME,
    label: SKILL_ADD_TOOL_NAME,
    description: [
      "Install a skill from the skills marketplace, so this session gains a capability it",
      "does not have yet.",
      "",
      "Pass what the skill should do, or its id, as `query`. With no `source` this searches",
      "the marketplace: a clear match installs immediately, and anything else comes back as a",
      "shortlist — call again with the `source` of the one you want. Skills are installed",
      'globally unless you pass scope "project", which puts the skill in the workspace where',
      "it can be committed alongside the code it is about.",
      "",
      "The install returns the path it wrote. The skill joins your listed skills from your",
      "next turn; to act on it in this one, read that file.",
      "",
      "A skill of the same id that is already installed is left alone — pass replace true to",
      "overwrite it, which discards any edits made to it locally.",
      "",
      "For a skill that already exists use skills_list and skill_view. To write a new skill of",
      "your own, write a SKILL.md with the file tools — this tool only fetches published ones.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description:
          "The skill to install — its id, its name, or what you want it to do.",
      }),
      source: Type.Optional(
        Type.String({
          description:
            'The "owner/repo" to install from, from a previous shortlist. Skips the search.',
        })
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description:
            "Where to install it. Defaults to global — available in every workspace.",
        })
      ),
      replace: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite a skill of this id that is already installed, losing any local edits.",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const source =
        typeof params.source === "string" ? params.source.trim() : "";
      const scope = params.scope === "project" ? "project" : "global";
      const replace = params.replace === true;

      if (query === "") {
        return {
          content: [
            text(
              "A query is required: the skill id, its name, or what it should do."
            ),
          ],
          details: {},
          isError: true,
        };
      }

      let skillId = query;
      let from = source;

      if (from === "") {
        const found = await searchSkillMarketplace(query);
        if (found.error != null) {
          return { content: [text(found.error)], details: {}, isError: true };
        }
        if (found.skills.length === 0) {
          return {
            content: [
              text(
                `No skill matches "${query}". Try different words, or write the skill yourself as a SKILL.md.`
              ),
            ],
            details: {},
            isError: true,
          };
        }

        const match =
          exactMatch(query, found.skills) ??
          (found.skills.length === 1 ? found.skills[0] : undefined);
        if (match == null) {
          return {
            content: [
              text(
                [
                  `Several skills match "${query}". Pick one and call skill_add again with both arguments`,
                  "exactly as written below — do not search again with different words:",
                  "",
                  shortlist(found.skills),
                ].join("\n")
              ),
            ],
            details: { candidates: found.skills },
          };
        }

        skillId = match.skillId;
        from = match.source;
      }

      const dirs = context.skillDirs();
      const targetDir = scope === "project" ? dirs.project : dirs.global;
      const result = await installSkill({
        skillId,
        source: from,
        targetDir,
        replace,
      });

      if (!result.ok) {
        // Already-installed is the one failure with a useful next step.
        const already = result.path != null;
        const message = already
          ? `${result.error}\n${result.path}\n\nRead it with skill_view, or call again with replace true to overwrite it.`
          : result.error;

        return {
          content: [text(message)],
          details: { skillId, source: from },
          isError: true,
        };
      }

      // A failed re-scan changes what to say, not whether the install worked.
      let loaded = true;
      try {
        await context.onInstalled();
      } catch {
        loaded = false;
      }

      return {
        content: [
          text(
            [
              `${result.existed ? "Replaced" : "Installed"} "${result.id}" from ${from} (${scope}).`,
              result.path,
              "",
              loaded
                ? "It is in your skills from your next turn. To use it right now, read the file above."
                : "It could not be loaded into this session; it will be there in the next one.",
            ].join("\n")
          ),
        ],
        details: {
          id: result.id,
          source: from,
          scope,
          path: result.path,
          replaced: result.existed,
        },
      };
    },
  };
}
