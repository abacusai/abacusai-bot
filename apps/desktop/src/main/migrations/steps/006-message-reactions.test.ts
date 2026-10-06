import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { messageReactions } from "./006-message-reactions";

it("stages an idempotent upgrade, backs up user history, and leaves newer files alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-reactions-"));
  try {
    const threads = path.join(root, "threads");
    fs.mkdirSync(threads);
    const old = {
      version: 2,
      threadId: "t",
      updatedAt: "now",
      source: { kind: "agui" },
      messages: [
        {
          id: "a",
          role: "assistant",
          parts: [],
          metadata: { abacus: { reactions: ["👍"] } },
        },
      ],
    };
    const dest = path.join(threads, "t.json");
    fs.writeFileSync(dest, JSON.stringify(old));
    const future = JSON.stringify({ ...old, version: 4 });
    fs.writeFileSync(path.join(threads, "future.json"), future);
    const ctx = {
      home: root,
      userData: root,
      appVersion: "test",
      staging: path.join(root, "staging"),
      progress: () => {},
      log: () => {},
    };
    const plan = await messageReactions().plan(ctx);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.kind).toBe("replace-user");
    const upgraded = JSON.parse(
      fs.readFileSync(plan.writes[0]!.staged, "utf8")
    );
    expect(upgraded.version).toBe(3);
    expect(upgraded.messages[0].reactions).toEqual(["👍"]);
    fs.copyFileSync(plan.writes[0]!.staged, dest);
    expect((await messageReactions().plan(ctx)).writes).toEqual([]);
    expect(fs.readFileSync(path.join(threads, "future.json"), "utf8")).toBe(
      future
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
