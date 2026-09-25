/**
 * Installing a skill from inside the conversation.
 *
 * The network is stubbed at `fetch`, so what is pinned here is the part that
 * has to be right on a machine with no marketplace reachable: which URLs are
 * probed, where the file lands, and what the model is told when the answer is
 * ambiguous rather than an install. The on-disk layout (`<id>/SKILL.md`) is
 * written as a literal because the agent's scanner derives the skill id from
 * that folder name; a test that imported the path builder would not notice it
 * changing.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSkillAddTool } from "./skill-add-tool.js";

let root: string;
let reloads: number;

const SKILL_MD =
  "---\nname: pdf\ndescription: Work with PDFs.\n---\n\nDo PDF things.\n";

/** Serve the given URLs; every other request 404s, as GitHub does for a missing layout. */
const serve = (routes: Record<string, string>): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[String(url)];

      return {
        status: body == null ? 404 : 200,
        text: async () => body ?? "Not Found",
      };
    })
  );
};

const searchUrl = (query: string): string =>
  `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`;
const rawUrl = (repoPath: string): string =>
  `https://raw.githubusercontent.com/${repoPath}`;

const tool = (): ReturnType<typeof buildSkillAddTool> =>
  buildSkillAddTool({
    skillDirs: () => ({
      project: path.join(root, "project"),
      global: path.join(root, "global"),
    }),
    onInstalled: () => {
      reloads++;
    },
  });

const call = async (
  params: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> => {
  const result = await tool().execute("call-1", params);

  return {
    text: result.content.map((part) => part.text).join("\n"),
    isError: result.isError === true,
  };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-skill-add-"));
  reloads = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("skill_add", () => {
  it("installs the skill the query names, and loads it before returning", async () => {
    serve({
      [searchUrl("pdf")]: JSON.stringify({
        skills: [
          {
            id: "anthropics/skills/pdf",
            skillId: "pdf",
            name: "PDF",
            source: "anthropics/skills",
            installs: 12,
          },
        ],
      }),
      [rawUrl("anthropics/skills/HEAD/pdf/SKILL.md")]: SKILL_MD,
    });

    const result = await call({ query: "pdf" });

    expect(result.isError).toBe(false);
    expect(
      fs.readFileSync(path.join(root, "global", "pdf", "SKILL.md"), "utf8")
    ).toBe(SKILL_MD);
    // The point of reloading: the session has to pick the skill up, and the
    // text says when, so that had better be what happens.
    expect(reloads).toBe(1);
    expect(result.text).toContain("next turn");
    expect(result.text).toContain("anthropics/skills");
  });

  it("finds a skill filed under a curated monorepo layout", async () => {
    serve({
      [rawUrl("openai/skills/HEAD/skills/.curated/canvas/SKILL.md")]: SKILL_MD,
    });

    const result = await call({ query: "canvas", source: "openai/skills" });

    expect(result.isError).toBe(false);
    expect(fs.existsSync(path.join(root, "global", "canvas", "SKILL.md"))).toBe(
      true
    );
  });

  it("installs into the workspace when the scope says project", async () => {
    serve({ [rawUrl("acme/skills/HEAD/deploy/SKILL.md")]: SKILL_MD });

    await call({ query: "deploy", source: "acme/skills", scope: "project" });

    expect(
      fs.existsSync(path.join(root, "project", "deploy", "SKILL.md"))
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "global", "deploy"))).toBe(false);
  });

  it("hands back a shortlist rather than guessing between matches", async () => {
    serve({
      [searchUrl("write me a deck")]: JSON.stringify({
        skills: [
          {
            id: "a/b/slides",
            skillId: "slides",
            name: "Slides",
            source: "a/b",
            installs: 9,
          },
          {
            id: "c/d/pptx",
            skillId: "pptx",
            name: "PPTX",
            source: "c/d",
            installs: 4,
          },
        ],
      }),
    });

    const result = await call({ query: "write me a deck" });

    // Not an error: a shortlist is a step in the flow, and marking it one would
    // put a failed call in the transcript for a call that worked.
    expect(result.isError).toBe(false);
    expect(result.text).toContain('query "slides", source "a/b"');
    expect(result.text).toContain('query "pptx", source "c/d"');
    expect(fs.existsSync(path.join(root, "global"))).toBe(false);
  });

  it("says the skill was not found rather than writing an empty one", async () => {
    serve({});

    const result = await call({ query: "nonesuch", source: "acme/skills" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No SKILL.md");
    expect(fs.existsSync(path.join(root, "global", "nonesuch"))).toBe(false);
    expect(reloads).toBe(0);
  });

  it("refuses a source that is not owner/repo", async () => {
    serve({});

    const result = await call({ query: "pdf", source: "not-a-repo" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("owner/repo");
  });

  it('reports an unreachable marketplace instead of "no skills found"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    const result = await call({ query: "pdf" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Could not reach");
  });

  it("leaves an already-installed skill alone, and says how to replace it", async () => {
    serve({ [rawUrl("acme/skills/HEAD/deploy/SKILL.md")]: SKILL_MD });
    await call({ query: "deploy", source: "acme/skills" });
    const mine = `${SKILL_MD}\nMy own notes.\n`;
    fs.writeFileSync(
      path.join(root, "global", "deploy", "SKILL.md"),
      mine,
      "utf8"
    );

    const result = await call({ query: "deploy", source: "acme/skills" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("already installed");
    expect(result.text).toContain("replace true");
    // The edits are the whole point of not overwriting.
    expect(
      fs.readFileSync(path.join(root, "global", "deploy", "SKILL.md"), "utf8")
    ).toBe(mine);
  });

  it("overwrites when replace is passed, and says it replaced rather than installed", async () => {
    serve({ [rawUrl("acme/skills/HEAD/deploy/SKILL.md")]: SKILL_MD });
    await call({ query: "deploy", source: "acme/skills" });
    fs.writeFileSync(
      path.join(root, "global", "deploy", "SKILL.md"),
      "stale\n",
      "utf8"
    );

    const result = await call({
      query: "deploy",
      source: "acme/skills",
      replace: true,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Replaced");
    expect(
      fs.readFileSync(path.join(root, "global", "deploy", "SKILL.md"), "utf8")
    ).toBe(SKILL_MD);
  });

  it("refuses a file that is not a skill, rather than installing one nothing loads", async () => {
    // What a repo without that skill often serves: a page, with a 200.
    serve({
      [rawUrl("acme/skills/HEAD/ghost/SKILL.md")]:
        "# Ghost\n\nJust a readme.\n",
    });

    const result = await call({ query: "ghost", source: "acme/skills" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a skill");
    expect(fs.existsSync(path.join(root, "global", "ghost"))).toBe(false);
  });

  it("refuses frontmatter with no description, which pi would drop silently", async () => {
    serve({
      [rawUrl("acme/skills/HEAD/bare/SKILL.md")]:
        "---\nname: bare\n---\n\nBody.\n",
    });

    const result = await call({ query: "bare", source: "acme/skills" });

    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(root, "global", "bare"))).toBe(false);
  });

  it("accepts a description written as a block scalar", async () => {
    const block =
      "---\nname: wide\ndescription: >-\n  A description that\n  runs over two lines.\n---\n\nBody.\n";
    serve({ [rawUrl("acme/skills/HEAD/wide/SKILL.md")]: block });

    const result = await call({ query: "wide", source: "acme/skills" });

    expect(result.isError).toBe(false);
    expect(
      fs.readFileSync(path.join(root, "global", "wide", "SKILL.md"), "utf8")
    ).toBe(block);
  });

  it("refuses a file too large to be a skill", async () => {
    const huge = `---\nname: huge\ndescription: Big.\n---\n${"x".repeat(1_000_001)}`;
    serve({ [rawUrl("acme/skills/HEAD/huge/SKILL.md")]: huge });

    const result = await call({ query: "huge", source: "acme/skills" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("too large");
    expect(fs.existsSync(path.join(root, "global", "huge"))).toBe(false);
  });

  it("cannot be talked into writing outside the skills directory", async () => {
    // The id is the model's to choose, and it is joined to a path.
    serve({ [rawUrl("acme/skills/HEAD/passwd/SKILL.md")]: SKILL_MD });

    const result = await call({
      query: "../../../../etc/passwd",
      source: "acme/skills",
    });

    expect(result.isError).toBe(false);
    expect(fs.existsSync(path.join(root, "global", "passwd", "SKILL.md"))).toBe(
      true
    );
    expect(fs.readdirSync(path.join(root, "global"))).toEqual(["passwd"]);
  });

  it("reports an install that landed but could not be re-scanned", async () => {
    serve({ [rawUrl("acme/skills/HEAD/deploy/SKILL.md")]: SKILL_MD });
    const built = buildSkillAddTool({
      skillDirs: () => ({
        project: path.join(root, "project"),
        global: path.join(root, "global"),
      }),
      onInstalled: () => {
        throw new Error("loader is gone");
      },
    });

    const result = await built.execute("call-1", {
      query: "deploy",
      source: "acme/skills",
    });

    // Not an error: the file is on disk and the next session will have it.
    expect(result.isError).toBe(undefined);
    expect(result.content[0]?.text).toContain("next one");
    expect(fs.existsSync(path.join(root, "global", "deploy", "SKILL.md"))).toBe(
      true
    );
  });

  it("needs a query", async () => {
    serve({});

    const result = await call({ query: "   " });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("query is required");
  });

  it("says so when the marketplace has nothing", async () => {
    serve({ [searchUrl("quokka")]: JSON.stringify({ skills: [] }) });

    const result = await call({ query: "quokka" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No skill matches");
  });

  it("installs the only hit even when the query does not name it", async () => {
    serve({
      [searchUrl("something to lint my yaml")]: JSON.stringify({
        skills: [
          {
            id: "a/b/yamllint",
            skillId: "yamllint",
            name: "yamllint",
            source: "a/b",
            installs: 3,
          },
        ],
      }),
      [rawUrl("a/b/HEAD/yamllint/SKILL.md")]: SKILL_MD,
    });

    const result = await call({ query: "something to lint my yaml" });

    expect(result.isError).toBe(false);
    expect(
      fs.existsSync(path.join(root, "global", "yamllint", "SKILL.md"))
    ).toBe(true);
  });

  it("survives a marketplace answer that is not the shape it promises", async () => {
    serve({ [searchUrl("pdf")]: '{"skills": [{"nope": 1}], ' });

    const result = await call({ query: "pdf" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("unreadable");
  });
});
