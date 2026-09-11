/**
 * Recall across both front ends.
 *
 * The failures worth pinning here are the quiet ones. Search does not throw
 * when it reads the wrong store — it just answers "nothing", which is
 * indistinguishable from a conversation that genuinely never happened. So the
 * two on-disk layouts are written here as literals rather than through the
 * app's own writers: a test that builds its fixtures with the code under test
 * cannot catch the layout drifting from what the desktop actually writes.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSessionSearchTool,
  resolveLimit,
  sessionSearchEnabled,
} from "./session-search-tool.js";
import { renderHits, searchSessions, textOf } from "./session-search.js";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
const previousExcluded = process.env.ABACUSAI_BOT_EXCLUDED_TOOLS;

/** A desktop transcript, in the shape transcript-service.ts writes. */
const writeTranscript = (
  sessionId: string,
  segments: unknown[],
  updatedAt = "2026-01-01T00:00:00.000Z"
): void => {
  const dir = path.join(home, "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ version: 1, sessionId, updatedAt, segments }),
    "utf8"
  );
};

/** One bot message, as the renderer persists it. */
const botSays = (content: string): unknown => ({
  type: "text",
  id: "text:0:1",
  source: "bot",
  content,
});

/** An agent session log, in the shape pi appends. */
const writeSessionLog = (options: {
  id: string;
  cwd?: string;
  folder?: string;
  said?: string[];
  timestamp?: string;
  trailing?: string;
  /** Several blocks in one message, rather than one message each. */
  blocks?: string[];
  /** Leave the timestamps off entirely, as an older or hand-made log would. */
  undated?: boolean;
}): void => {
  const folder = options.folder ?? "--Users-someone-project--";
  const dir = path.join(home, "agent", "sessions", folder);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = options.timestamp ?? "2026-01-01T00:00:00.000Z";
  const dated = <T extends object>(entry: T): T =>
    options.undated === true ? entry : { ...entry, timestamp };
  const lines = [
    JSON.stringify(
      dated({
        type: "session",
        version: 3,
        id: options.id,
        cwd: options.cwd ?? "/Users/someone/project",
      })
    ),
    ...(options.said ?? []).map((text, index) =>
      JSON.stringify(
        dated({
          type: "message",
          id: `entry-${index}`,
          parentId: null,
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text }],
          },
        })
      )
    ),
    ...(options.blocks == null
      ? []
      : [
          JSON.stringify(
            dated({
              type: "message",
              id: "entry-blocks",
              parentId: null,
              message: {
                role: "assistant",
                content: options.blocks.map((text) => ({ type: "text", text })),
              },
            })
          ),
        ]),
  ];

  fs.writeFileSync(
    path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${options.id}.jsonl`),
    lines.join("\n") + (options.trailing ?? "\n"),
    "utf8"
  );
};

/** The desktop's own record of its sessions, as local-code.json holds it. */
const writeDesktopStore = (sessions: unknown[]): void => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "local-code.json"),
    JSON.stringify({ agent: { agentSessions: sessions } }),
    "utf8"
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-session-search-"));
  process.env.ABACUSAI_BOT_HOME = home;
  delete process.env.ABACUSAI_BOT_EXCLUDED_TOOLS;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  if (previousExcluded == null) delete process.env.ABACUSAI_BOT_EXCLUDED_TOOLS;
  else process.env.ABACUSAI_BOT_EXCLUDED_TOOLS = previousExcluded;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("a fresh install", () => {
  it("finds nothing rather than throwing when neither store exists", () => {
    expect(searchSessions("anything")).toEqual([]);
  });

  it("says so in words the model can act on", () => {
    expect(renderHits([], "redis")).toBe(
      'Nothing in past sessions mentions "redis".'
    );
  });

  it("treats an empty or blank query as no query at all", () => {
    writeTranscript("s1", [botSays("anything at all")]);

    expect(searchSessions("")).toEqual([]);
    expect(searchSessions("   ")).toEqual([]);
  });
});

describe("conversations held in the app", () => {
  it("finds one by something said in it", () => {
    writeTranscript("s1", [
      botSays("The retry budget lives in fetchWithBackoff."),
    ]);

    const [hit] = searchSessions("fetchWithBackoff");

    expect(hit?.sessionId).toBe("s1");
    expect(hit?.origin).toBe("desktop");
    expect(hit?.excerpts[0]).toContain("fetchWithBackoff");
  });

  it("matches regardless of case, in either direction", () => {
    writeTranscript("s1", [botSays("We settled on PostgreSQL.")]);

    expect(searchSessions("postgresql")).toHaveLength(1);
    expect(searchSessions("POSTGRESQL")).toHaveLength(1);
  });

  it("shows the label the user gave the session", () => {
    writeTranscript("s1", [botSays("shipped the parser")]);
    writeDesktopStore([
      {
        id: "s1",
        label: "rewrite the parser",
        updatedAt: "2026-03-01T09:00:00.000Z",
      },
    ]);

    expect(searchSessions("parser")[0]?.title).toBe("rewrite the parser");
  });

  it("has no title to show when the app never recorded one", () => {
    writeTranscript("s1", [botSays("shipped the parser")]);

    expect(searchSessions("parser")[0]?.title).toBeNull();
  });
});

describe("conversations that left only an agent log", () => {
  it("finds one with no transcript to go with it", () => {
    writeSessionLog({ id: "log-1", said: ["why does buildIndex hang?"] });

    const [hit] = searchSessions("buildIndex");

    expect(hit?.sessionId).toBe("log-1");
    expect(hit?.origin).toBe("agent-log");
    expect(hit?.excerpts[0]).toContain("buildIndex");
  });

  it("shows the directory it ran in, which is how someone recognises it", () => {
    writeSessionLog({
      id: "log-1",
      cwd: "/Users/someone/api",
      said: ["migrating the schema"],
    });

    expect(searchSessions("migrating")[0]?.title).toBe("/Users/someone/api");
  });

  it("reads the session id from the log rather than from its filename", () => {
    // The filename carries a timestamp prefix, and ownership is decided on the
    // id — taking it from the name would never match what the app recorded.
    writeSessionLog({ id: "log-1", said: ["a thing was said"] });

    expect(searchSessions("a thing")[0]?.sessionId).toBe("log-1");
  });

  it("searches every project folder, not just one", () => {
    writeSessionLog({
      id: "log-1",
      folder: "--a--",
      said: ["shared phrase here"],
    });
    writeSessionLog({
      id: "log-2",
      folder: "--b--",
      said: ["shared phrase here"],
    });

    expect(
      searchSessions("shared phrase")
        .map((hit) => hit.sessionId)
        .sort()
    ).toEqual(["log-1", "log-2"]);
  });
});

describe("a conversation that is in both stores", () => {
  it("is reported once, as the app session that owns it", () => {
    // The desktop writes a transcript AND runs an agent that writes a log. Both
    // match; reporting both spends the result budget saying the same thing twice.
    writeTranscript("s1", [botSays("the cache key is tenant-scoped")]);
    writeSessionLog({ id: "log-1", said: ["the cache key is tenant-scoped"] });
    writeDesktopStore([
      { id: "s1", label: "caching", agentSessionIds: ["log-1"] },
    ]);

    const hits = searchSessions("tenant-scoped");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.origin).toBe("desktop");
  });

  it("skips every log the session has ever opened, not just the newest", () => {
    // The agent respawns on each app launch and opens a fresh log, so a long
    // conversation owns several. Only recording the latest left the older ones
    // showing up as separate sessions.
    writeTranscript("s1", [botSays("the cache key is tenant-scoped")]);
    writeSessionLog({
      id: "old-log",
      said: ["the cache key is tenant-scoped"],
    });
    writeSessionLog({
      id: "new-log",
      said: ["the cache key is tenant-scoped"],
    });
    writeDesktopStore([
      {
        id: "s1",
        agentSessionIds: ["old-log", "new-log"],
        agentSessionId: "new-log",
      },
    ]);

    expect(searchSessions("tenant-scoped")).toHaveLength(1);
  });

  it("leaves out the live conversation through the older single-id field too", () => {
    writeTranscript("s1", [botSays("what did we decide about retries?")]);
    writeSessionLog({
      id: "current",
      said: ["what did we decide about retries?"],
    });
    writeDesktopStore([{ id: "s1", agentSessionId: "current" }]);

    expect(searchSessions("retries", 10, "current")).toEqual([]);
  });

  it("still honours a store written before the list existed", () => {
    writeTranscript("s1", [botSays("the cache key is tenant-scoped")]);
    writeSessionLog({ id: "log-1", said: ["the cache key is tenant-scoped"] });
    writeDesktopStore([{ id: "s1", agentSessionId: "log-1" }]);

    expect(searchSessions("tenant-scoped")).toHaveLength(1);
  });

  it("keeps an agent log the app has no claim on", () => {
    writeTranscript("s1", [botSays("tenant-scoped keys")]);
    writeSessionLog({ id: "log-1", said: ["tenant-scoped keys"] });
    writeSessionLog({ id: "log-2", said: ["tenant-scoped keys"] });
    writeDesktopStore([{ id: "s1", agentSessionIds: ["log-1"] }]);

    expect(
      searchSessions("tenant-scoped")
        .map((hit) => hit.sessionId)
        .sort()
    ).toEqual(["log-2", "s1"]);
  });
});

describe("the conversation asking the question", () => {
  it("is left out of its own results", () => {
    // Every query matches the session it was typed into — the prompt is in the
    // log by the time the tool runs. Reporting it reads as "you have discussed
    // this before" pointing at the discussion in progress.
    writeSessionLog({
      id: "current",
      said: ["what did we decide about retries?"],
    });
    writeSessionLog({
      id: "earlier",
      said: ["what did we decide about retries?"],
    });

    expect(
      searchSessions("retries", 10, "current").map((hit) => hit.sessionId)
    ).toEqual(["earlier"]);
  });

  it("takes the app conversation running it out too", () => {
    // In the app the same words are in the transcript as well, under a
    // different id. Only the store knows the two are the same conversation.
    writeTranscript("desktop-session", [
      botSays("what did we decide about retries?"),
    ]);
    writeSessionLog({
      id: "current",
      said: ["what did we decide about retries?"],
    });
    writeDesktopStore([
      { id: "desktop-session", agentSessionIds: ["current"] },
    ]);

    expect(searchSessions("retries", 10, "current")).toEqual([]);
  });

  it("leaves other app conversations alone when their logs are not the live one", () => {
    writeTranscript("other", [botSays("what did we decide about retries?")]);
    writeSessionLog({
      id: "current",
      said: ["what did we decide about retries?"],
    });
    writeDesktopStore([{ id: "other", agentSessionIds: ["some-other-log"] }]);

    expect(
      searchSessions("retries", 10, "current").map((hit) => hit.sessionId)
    ).toEqual(["other"]);
  });

  it("leaves every other conversation alone when nothing claims the log", () => {
    writeTranscript("other", [botSays("what did we decide about retries?")]);
    writeSessionLog({
      id: "current",
      said: ["what did we decide about retries?"],
    });

    expect(
      searchSessions("retries", 10, "current").map((hit) => hit.sessionId)
    ).toEqual(["other"]);
  });

  it("searches everything when the caller does not say which session it is", () => {
    writeSessionLog({
      id: "current",
      said: ["what did we decide about retries?"],
    });

    expect(searchSessions("retries")).toHaveLength(1);
    expect(searchSessions("retries", 10, "")).toHaveLength(1);
  });
});

describe("what a query must not match", () => {
  it("ignores the timestamp every transcript carries at the top", () => {
    // This one shipped: a search for a date returned every session that
    // existed, each excerpted to a bare ISO string and crowding out real hits.
    writeTranscript(
      "s1",
      [botSays("nothing about dates here")],
      "2026-03-04T05:06:07.000Z"
    );

    expect(searchSessions("2026-03-04")).toEqual([]);
  });

  it("ignores session ids, which are not what anyone is searching for", () => {
    writeTranscript("deadbeef-0000-4000-8000-000000000000", [
      botSays("nothing to see"),
    ]);
    writeSessionLog({
      id: "cafebabe-1111-4111-8111-111111111111",
      said: ["nothing to see"],
    });

    expect(searchSessions("deadbeef")).toEqual([]);
    expect(searchSessions("cafebabe")).toEqual([]);
  });

  it("ignores the structural words every message is labelled with", () => {
    // Segments carry type "text" and source "bot"; log messages carry role
    // "user". Matching those returns every session ever held.
    writeTranscript("s1", [botSays("nothing relevant")]);
    writeSessionLog({ id: "log-1", said: ["nothing relevant"] });

    expect(searchSessions("bot")).toEqual([]);
    expect(searchSessions("user")).toEqual([]);
  });
});

describe("when nothing on disk says when it happened", () => {
  it("falls back to the file for a transcript with no timestamp", () => {
    // Older transcripts, and anything hand-made. Better a real date from the
    // file than sorting the session to the bottom as if it were from 1970.
    fs.mkdirSync(path.join(home, "transcripts"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "transcripts", "s1.json"),
      JSON.stringify({
        version: 1,
        sessionId: "s1",
        segments: [botSays("undated but findable")],
      }),
      "utf8"
    );

    expect(searchSessions("undated")[0]?.updatedAt).toBeGreaterThan(
      Date.parse("2020-01-01")
    );
  });

  it("falls back to the file for a log with no timestamps", () => {
    writeSessionLog({
      id: "log-1",
      said: ["undated but findable"],
      undated: true,
    });

    expect(searchSessions("undated")[0]?.updatedAt).toBeGreaterThan(
      Date.parse("2020-01-01")
    );
  });

  it("ignores a timestamp that is not a date", () => {
    writeTranscript("s1", [botSays("findable")], "the day before yesterday");

    // Not parseable, so the file answers instead — never NaN, which would make
    // every comparison in the sort false and the order arbitrary.
    expect(Number.isNaN(searchSessions("findable")[0]?.updatedAt)).toBe(false);
    expect(searchSessions("findable")[0]?.updatedAt).toBeGreaterThan(
      Date.parse("2020-01-01")
    );
  });
});

describe("the order results come back in", () => {
  it("puts the most recently active conversation first", () => {
    writeTranscript(
      "older",
      [botSays("the deploy step")],
      "2026-01-01T00:00:00.000Z"
    );
    writeTranscript(
      "newer",
      [botSays("the deploy step")],
      "2026-06-01T00:00:00.000Z"
    );

    expect(searchSessions("deploy").map((hit) => hit.sessionId)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("believes the app over the file, which it rewrites on every launch", () => {
    // Restoring a session rewrites its transcript, so mtime says "this morning"
    // for every conversation the app has ever held. Sorting on that reshuffled
    // results into the arbitrary order the app happened to hydrate in.
    writeTranscript(
      "stale-on-disk",
      [botSays("the deploy step")],
      "2026-01-01T00:00:00.000Z"
    );
    writeTranscript(
      "fresh-on-disk",
      [botSays("the deploy step")],
      "2026-01-01T00:00:00.000Z"
    );
    writeDesktopStore([
      { id: "stale-on-disk", updatedAt: "2026-06-01T00:00:00.000Z" },
      { id: "fresh-on-disk", updatedAt: "2026-02-01T00:00:00.000Z" },
    ]);

    expect(searchSessions("deploy").map((hit) => hit.sessionId)).toEqual([
      "stale-on-disk",
      "fresh-on-disk",
    ]);
  });

  it("ranks the two stores against each other, not one after the other", () => {
    writeTranscript(
      "desktop-old",
      [botSays("the deploy step")],
      "2026-01-01T00:00:00.000Z"
    );
    writeSessionLog({
      id: "log-new",
      said: ["the deploy step"],
      timestamp: "2026-06-01T00:00:00.000Z",
    });

    expect(searchSessions("deploy").map((hit) => hit.sessionId)).toEqual([
      "log-new",
      "desktop-old",
    ]);
  });

  it("returns no more than the limit asked for", () => {
    for (let index = 0; index < 5; index += 1) {
      writeTranscript(`s${index}`, [botSays("the deploy step")]);
    }

    expect(searchSessions("deploy", 2)).toHaveLength(2);
  });
});

describe("what one hit looks like", () => {
  it("keeps a few matches per session and stops", () => {
    writeTranscript(
      "s1",
      Array.from({ length: 10 }, (_, index) =>
        botSays(`mention ${index} of widget`)
      )
    );

    expect(searchSessions("widget")[0]?.excerpts).toHaveLength(3);
  });

  it("trims a long line down to the part around the match", () => {
    const filler = "x".repeat(500);
    writeTranscript("s1", [botSays(`${filler} needle ${filler}`)]);

    const excerpt = searchSessions("needle")[0]?.excerpts[0] ?? "";

    expect(excerpt.length).toBeLessThan(250);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("needle");
  });

  it("collapses the whitespace that would otherwise wrap the result over pages", () => {
    writeTranscript("s1", [botSays("before\n\n   needle   \n\nafter")]);

    expect(searchSessions("needle")[0]?.excerpts[0]).toBe(
      "before needle after"
    );
  });

  it("names where it happened and when, and never renders a missing date as 1970", () => {
    const rendered = renderHits(
      [
        {
          sessionId: "s1",
          origin: "desktop",
          updatedAt: Date.parse("2026-05-04T03:02:01.000Z"),
          title: "the parser",
          excerpts: ["a line"],
        },
        {
          sessionId: "log-1",
          origin: "agent-log",
          updatedAt: 0,
          title: "/Users/someone/api",
          excerpts: ["another line"],
        },
      ],
      "parser"
    );

    expect(rendered).toContain("session s1 (2026-05-04 03:02, app) the parser");
    expect(rendered).toContain(
      "session log-1 (unknown, agent log) /Users/someone/api"
    );
    expect(rendered).not.toContain("1970");
  });
});

describe("excerpts of awkward text", () => {
  it("never cuts a character in half", () => {
    // The bounds are character offsets either side of the match, and an emoji is
    // two of them. An odd offset used to cut between the pair and leave an
    // unpaired surrogate — a replacement glyph on screen, and not text worth
    // handing to an encoder. The gap makes the boundary land mid-pair.
    const party = "🎉".repeat(60);
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    for (const gap of [0, 1, 2, 3]) {
      fs.rmSync(path.join(home, "transcripts"), {
        recursive: true,
        force: true,
      });
      writeTranscript("s1", [
        botSays(`${party}${"x".repeat(gap)}needle${"x".repeat(gap)}${party}`),
      ]);

      const excerpt = searchSessions("needle")[0]?.excerpts[0] ?? "";

      expect(lone.test(excerpt), `gap of ${gap} split a surrogate pair`).toBe(
        false
      );
      expect(excerpt).toContain("needle");
    }
  });

  it("keeps the split character whole rather than dropping it, at either end", () => {
    // Moving off the pair can go either way; outward keeps the character, inward
    // eats one that was inside the window. The counts differ by exactly one, so
    // they are what pins the direction — `toContain` cannot tell them apart.
    const count = (excerpt: string): number =>
      [...excerpt.matchAll(/🎉/gu)].length;
    const party = "🎉".repeat(200);

    // Leading edge: an odd gap puts the start bound inside a pair.
    writeTranscript("s1", [botSays(`${party}xneedle`)]);
    expect(count(searchSessions("needle")[0]?.excerpts[0] ?? "")).toBe(40);

    // Trailing edge, same trick on the other side.
    fs.rmSync(path.join(home, "transcripts"), { recursive: true, force: true });
    writeTranscript("s1", [botSays(`needlex${party}`)]);
    expect(count(searchSessions("needle")[0]?.excerpts[0] ?? "")).toBe(60);

    // An even gap needs no adjustment at all, and must not get one.
    fs.rmSync(path.join(home, "transcripts"), { recursive: true, force: true });
    writeTranscript("s1", [botSays(`needlexx${party}`)]);
    expect(count(searchSessions("needle")[0]?.excerpts[0] ?? "")).toBe(59);
  });

  it("does not spend the budget saying the same line three times", () => {
    // A conversation repeats itself — a line quoted back, a command run twice.
    // Three copies of one line is not evidence of three things.
    writeTranscript("s1", [
      botSays("the same line"),
      botSays("the same line"),
      botSays("a different line"),
    ]);

    expect(searchSessions("line")[0]?.excerpts).toEqual([
      "the same line",
      "a different line",
    ]);
  });

  it("keeps a repeated line out across log entries, not just within one", () => {
    writeSessionLog({
      id: "log-1",
      said: ["echo hello", "echo hello", "echo goodbye"],
    });

    expect(searchSessions("echo")[0]?.excerpts).toEqual([
      "echo hello",
      "echo goodbye",
    ]);
  });

  it("caps the excerpts taken from a single log message", () => {
    // One message can carry several content blocks; the cap is per session, so
    // it has to hold inside an entry as well as across them.
    writeSessionLog({
      id: "log-1",
      blocks: ["widget one", "widget two", "widget three", "widget four"],
    });

    expect(searchSessions("widget")[0]?.excerpts).toHaveLength(3);
  });

  it("finds text nested as deep as a tool call puts it, and gives up below that", () => {
    const nested = {
      toolCall: {
        name: "bash",
        arguments: { command: { parts: [{ value: "reachable-needle" }] } },
      },
    };
    const buried = {
      a: { b: { c: { d: { e: { f: { g: "buried-needle" } } } } } },
    };

    expect(
      textOf(nested).some((text) => text.includes("reachable-needle"))
    ).toBe(true);
    // Deeper than any real segment nests. Bounded so a cyclic or pathological
    // structure cannot walk forever.
    expect(textOf(buried).some((text) => text.includes("buried-needle"))).toBe(
      false
    );
  });

  it("walks past values that are not text without tripping on them", () => {
    expect(
      textOf({
        count: 42,
        ok: true,
        nothing: null,
        blank: "   ",
        real: "words",
      })
    ).toEqual(["words"]);
  });
});

describe("files that are not what they should be", () => {
  it("skips a corrupt transcript and keeps searching the rest", () => {
    fs.mkdirSync(path.join(home, "transcripts"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "transcripts", "broken.json"),
      "{ not json",
      "utf8"
    );
    writeTranscript("s1", [botSays("the good one mentions sockets")]);

    expect(searchSessions("sockets").map((hit) => hit.sessionId)).toEqual([
      "s1",
    ]);
  });

  it("skips a half-written log line and keeps the lines before it", () => {
    // pi appends a line at a time, so the last line of a log being written
    // right now can be truncated mid-object.
    writeSessionLog({
      id: "log-1",
      said: ["the good line mentions sockets"],
      trailing: '\n{"type":"mess',
    });

    expect(searchSessions("sockets").map((hit) => hit.sessionId)).toEqual([
      "log-1",
    ]);
  });

  it("survives a local-code.json that is corrupt or the wrong shape", () => {
    writeTranscript("s1", [botSays("still findable")]);
    fs.writeFileSync(path.join(home, "local-code.json"), "{ not json", "utf8");

    expect(searchSessions("findable")).toHaveLength(1);

    fs.writeFileSync(
      path.join(home, "local-code.json"),
      JSON.stringify({ agent: { agentSessions: "nope" } }),
      "utf8"
    );

    expect(searchSessions("findable")).toHaveLength(1);
  });

  it("ignores a stray file sitting where a project folder should be", () => {
    writeSessionLog({ id: "log-1", said: ["findable text"] });
    fs.writeFileSync(
      path.join(home, "agent", "sessions", "stray.jsonl"),
      "mentions findable text",
      "utf8"
    );

    expect(searchSessions("findable").map((hit) => hit.sessionId)).toEqual([
      "log-1",
    ]);
  });

  it("skips a log it cannot read and keeps the rest", () => {
    // A directory named like a log: readable as an entry, not as a file.
    writeSessionLog({ id: "log-1", said: ["findable text"] });
    fs.mkdirSync(
      path.join(
        home,
        "agent",
        "sessions",
        "--Users-someone-project--",
        "wedged.jsonl"
      ),
      { recursive: true }
    );

    expect(searchSessions("findable").map((hit) => hit.sessionId)).toEqual([
      "log-1",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "skips a project folder it cannot list",
    () => {
      writeSessionLog({
        id: "log-1",
        folder: "--readable--",
        said: ["findable text"],
      });
      const closed = path.join(home, "agent", "sessions", "--closed--");
      fs.mkdirSync(closed, { recursive: true });
      fs.chmodSync(closed, 0o000);

      try {
        expect(searchSessions("findable").map((hit) => hit.sessionId)).toEqual([
          "log-1",
        ]);
      } finally {
        // Or the temp directory cannot be removed afterwards.
        fs.chmodSync(closed, 0o755);
      }
    }
  );

  it("survives a log whose header is not the shape it should be", () => {
    const dir = path.join(home, "agent", "sessions", "--p--");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "malformed.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: 42,
          cwd: null,
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "findable" }],
          },
        }),
      ].join("\n"),
      "utf8"
    );

    const [hit] = searchSessions("findable");

    // Falls back to the filename, and offers no directory rather than "null".
    expect(hit?.sessionId).toBe("malformed");
    expect(hit?.title).toBeNull();
  });

  it("survives a claimed-log list holding things that are not ids", () => {
    writeTranscript("s1", [botSays("tenant-scoped keys")]);
    writeSessionLog({ id: "log-1", said: ["tenant-scoped keys"] });
    writeDesktopStore([{ id: "s1", agentSessionIds: [null, 42, "log-1"] }]);

    expect(searchSessions("tenant-scoped")).toHaveLength(1);
  });

  it("still reports a hit when the file vanishes before it can be dated", () => {
    writeSessionLog({ id: "log-1", said: ["findable"], undated: true });
    const statSync = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    try {
      const [hit] = searchSessions("findable");

      expect(hit?.sessionId).toBe("log-1");
      expect(hit?.updatedAt).toBe(0);
      expect(renderHits([hit!], "findable")).toContain("unknown");
    } finally {
      statSync.mockRestore();
    }
  });

  it("survives an agentSessions list holding things that are not sessions", () => {
    writeTranscript("s1", [botSays("still findable")]);
    writeDesktopStore([
      null,
      "not an object",
      42,
      { noId: true },
      { id: "s1", label: "kept" },
    ]);

    expect(searchSessions("findable")[0]?.title).toBe("kept");
  });

  it("ignores a stray file that is not a transcript or a log", () => {
    fs.mkdirSync(path.join(home, "transcripts"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "transcripts", "notes.txt"),
      "mentions sockets",
      "utf8"
    );
    fs.mkdirSync(path.join(home, "agent", "sessions", "--a--"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, "agent", "sessions", "--a--", "notes.txt"),
      "mentions sockets",
      "utf8"
    );

    expect(searchSessions("sockets")).toEqual([]);
  });
});

describe("queries with characters JSON escapes on disk", () => {
  it("finds a quoted phrase in a log, which the fast path must not reject", () => {
    // Logs are scanned with a raw substring test before anything is parsed. A
    // quote is stored escaped, so testing the raw text for one would skip a
    // file that does match.
    writeSessionLog({ id: "log-1", said: ['he said "ship it" and left'] });

    expect(
      searchSessions('said "ship it"').map((hit) => hit.sessionId)
    ).toEqual(["log-1"]);
  });

  it("finds a Windows path, whose backslashes are escaped too", () => {
    writeSessionLog({
      id: "log-1",
      said: ["the file is at C:\\Users\\me\\notes.txt"],
    });

    expect(searchSessions("C:\\Users\\me").map((hit) => hit.sessionId)).toEqual(
      ["log-1"]
    );
  });

  it("finds non-ASCII text, which JSON stores as itself", () => {
    writeSessionLog({ id: "log-1", said: ["the café migration"] });

    expect(searchSessions("café").map((hit) => hit.sessionId)).toEqual([
      "log-1",
    ]);
  });
});

describe("the tool wrapper", () => {
  it("is on unless its group was switched off", () => {
    expect(sessionSearchEnabled()).toBe(true);

    process.env.ABACUSAI_BOT_EXCLUDED_TOOLS = "todo, session_search ,memory";
    expect(sessionSearchEnabled()).toBe(false);

    process.env.ABACUSAI_BOT_EXCLUDED_TOOLS = "todo,memory";
    expect(sessionSearchEnabled()).toBe(true);
  });

  it("is named exactly what the capability registry lists", () => {
    // The registry marks `session_search` as agent-delivered, which means this
    // process is the only thing that registers it. A rename here and nowhere
    // else leaves the group switched on in the panel with nothing behind it.
    const tool = buildSessionSearchTool();

    expect(tool.name).toBe("session_search");
    expect(tool.label).toBe("session_search");
  });

  it("corrects a limit rather than refusing the call", () => {
    expect(resolveLimit(undefined)).toBe(10);
    expect(resolveLimit("twelve")).toBe(10);
    expect(resolveLimit(Number.NaN)).toBe(10);
    expect(resolveLimit(Number.POSITIVE_INFINITY)).toBe(10);
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(-5)).toBe(1);
    expect(resolveLimit(3.7)).toBe(3);
    expect(resolveLimit(500)).toBe(50);
  });

  it("leaves out whichever session the caller says is the live one", async () => {
    writeSessionLog({ id: "current", said: ["the migration ran twice"] });
    writeSessionLog({ id: "earlier", said: ["the migration ran twice"] });

    const result = await buildSessionSearchTool(() => "current").execute(
      "call-1",
      {
        query: "migration",
      }
    );

    expect(result.details).toMatchObject({ sessions: ["earlier"] });
  });

  it("reads the live session id at call time, since it does not exist at build time", async () => {
    writeSessionLog({ id: "current", said: ["the migration ran twice"] });
    // Deliberately still `let`: the point of the test is that the id does not
    // exist when the tool is built and is read at call time.
    let live: string | undefined;

    const tool = buildSessionSearchTool(() => live);
    live = "current";

    expect(await tool.execute("call-1", { query: "migration" })).toMatchObject({
      details: { sessions: [] },
    });
  });

  it("answers with the rendered hits, and names the sessions in its details", async () => {
    writeTranscript("s1", [botSays("the migration ran twice")]);

    const result = await buildSessionSearchTool().execute("call-1", {
      query: "migration",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("the migration ran twice");
    expect(result.details).toMatchObject({
      query: "migration",
      sessions: ["s1"],
    });
  });

  it("treats a query that is not text as no query at all", async () => {
    const result = await buildSessionSearchTool().execute("call-1", {
      query: 42 as unknown as string,
    });

    expect(result.isError).toBe(true);
  });

  it("reports an empty query as an error the model can correct", async () => {
    const result = await buildSessionSearchTool().execute("call-1", {
      query: "   ",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("A query is required.");
  });

  it("answers rather than errors when there is simply nothing to find", async () => {
    const result = await buildSessionSearchTool().execute("call-1", {
      query: "nothing here",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Nothing in past sessions");
  });
});
