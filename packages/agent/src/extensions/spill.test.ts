/**
 * Spill's job is that nothing is lost. The trimmed result must stay small, and
 * the part that was cut must still be reachable — those two together are the
 * whole feature, and either one alone is a regression.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  fakePi,
  toolResult,
  type FakePi,
} from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 5,000 numbered lines — comfortably past the inline cap. */
const BIG = Array.from(
  { length: 5_000 },
  (_, i) => `line ${i} ${"x".repeat(20)}`
).join("\n");

let home: string;
let pi: FakePi;

// Each `vi.resetModules()` below yields a fresh module instance that registers
// its own exit hook, so this file legitimately accumulates more than Node's
// default ten. That is an artifact of reloading the module per test, not of
// the extension — in a real process the hook is registered once.
process.setMaxListeners(50);

beforeEach(async () => {
  // Point the spill directory at a scratch home so tests never touch the
  // user's real one.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "spill-test-"));
  process.env.ABACUSAI_BOT_HOME = home;

  // A fresh module per test. The exit hook is registered once per process on
  // purpose — every sub-agent loads its own copy of the extensions, and a
  // listener per sub-agent is a leak — so a test that wants to observe
  // first-run behaviour has to start from a clean module. (The dead-directory
  // sweep is per instance, not per process, for the opposite reason: leftovers
  // appear over time, so sweeping once at startup would miss them.)
  vi.resetModules();
  const { default: spill } = await import("./spill.js");

  pi = fakePi();
  spill(pi.api as never);
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function spillBig(toolName = "bash"): Promise<string> {
  const result = (await pi.fire("tool_result", toolResult(toolName, BIG))) as {
    content: Array<{ text: string }>;
  };

  return result.content[0]!.text;
}

describe("trimming", () => {
  it("leaves a small result completely alone", async () => {
    const result = await pi.fire(
      "tool_result",
      toolResult("bash", "tiny output")
    );
    // Returning undefined means "no rewrite", which is what an untouched
    // result should look like.
    expect(result).toBeUndefined();
  });

  it("bounds an oversized result", async () => {
    const text = await spillBig();
    expect(text.length).toBeLessThan(BIG.length / 2);
  });

  it("keeps the head and the tail, which is where the answer usually is", async () => {
    const text = await spillBig();
    expect(text.startsWith("line 0")).toBe(true);
    expect(text.trimEnd().endsWith(`line 4999 ${"x".repeat(20)}`)).toBe(true);
  });

  it("names the saved output so the model can go and get the rest", async () => {
    expect(await spillBig()).toMatch(/out-\d+/);
  });

  it("gives the file's real path, and says the id is not a file in the working directory", async () => {
    // "Saved as out-1" read as a file name: a routine that had just been told
    // its working directory looked for out-1 there, then sent a sub-agent to
    // look for it there too, and the sub-agent reported the dump missing.
    const text = await spillBig();
    const file = text.match(/saved to (\S+out-\d+\.txt)/)?.[1];
    expect(file).toBeDefined();
    expect(file!.startsWith(path.join(home, "spill"))).toBe(true);
    expect(fs.existsSync(file!)).toBe(true);
    expect(text).toMatch(/not a file in your working directory/);
    expect(text).toMatch(/give a sub-agent the path/);
  });

  it("lets a sub-agent's own copy of the extension read the parent's id", async () => {
    // Every sub-agent loads its own extensions. With the records kept per
    // instance, an id handed down from the parent was unknown to the child.
    const id = (await spillBig()).match(/out-\d+/)![0];
    const { default: spill } = await import("./spill.js");
    const child = fakePi();
    spill(child.api as never);

    const result = await child.tools
      .get("read_output")!
      .execute("c1", { id, offset: 4_000, limit: 1 });

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("line 3999 ");
  });

  it("does not spill its own retrieval tool, which would nest forever", async () => {
    const result = await pi.fire("tool_result", toolResult("read_output", BIG));
    expect(result).toBeUndefined();
  });

  it("inlines a connector result at a lower cap than other tools", async () => {
    // A Gmail search returns whole bodies; the rest is a read_output away.
    const email = JSON.stringify({
      results: Array.from({ length: 50 }, (_, i) => ({
        subject: `Message ${i}`,
        body: "y".repeat(500),
      })),
    });
    const result = (await pi.fire(
      "tool_result",
      toolResult("abacus-connectors_Gmail_Tool", email)
    )) as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;

    expect(email.length).toBeLessThan(30_000);
    expect(text.length).toBeLessThan(17_000);
    expect(text.startsWith('{"results":[{"subject":"Message 0"')).toBe(true);
    expect(text).toMatch(/out-\d+/);
  });

  it("leaves a connector result under its budget alone", async () => {
    const result = await pi.fire(
      "tool_result",
      toolResult("abacus-connectors_Gmail_Tool", "x".repeat(15_000))
    );
    expect(result).toBeUndefined();
  });

  it("covers every tool, not just bash", async () => {
    const text = await spillBig("some-mcp-server_query");
    expect(text).toMatch(/out-\d+/);
  });
});

describe("read_output", () => {
  it("is registered", () => {
    expect(pi.tools.get("read_output")).toBeDefined();
  });

  it("recovers a line from the omitted middle", async () => {
    await spillBig();
    const readOutput = pi.tools.get("read_output")!;
    const result = await readOutput.execute("c1", {
      id: "out-1",
      offset: 2_500,
      limit: 3,
    });

    // The point of the whole extension: this line was cut from the result and
    // is still readable without re-running the command.
    expect(result.content[0]!.text).toMatch(/line 2499/);
    expect(result.isError).toBe(false);
  });

  it("filters by grep, then pages through the matches", async () => {
    await spillBig();
    const readOutput = pi.tools.get("read_output")!;
    const result = await readOutput.execute("c2", {
      id: "out-1",
      grep: "^line 12[0-9] ",
      limit: 100,
    });

    // line 120 through line 129.
    expect(result.content[0]!.text).toMatch(/10 lines match/);
  });

  it("reports an unknown id as an error instead of throwing", async () => {
    const readOutput = pi.tools.get("read_output")!;
    const result = await readOutput.execute("c3", { id: "out-999" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No saved output/);
    // Where an id comes from, and what to ask for instead of one.
    expect(result.content[0]!.text).toMatch(/ask for that path/);
  });

  it("reports an invalid regex as an error instead of throwing", async () => {
    await spillBig();
    const readOutput = pi.tools.get("read_output")!;
    const result = await readOutput.execute("c4", { id: "out-1", grep: "([" });
    expect(result.isError).toBe(true);
  });

  it("bounds its own response, so retrieval cannot undo the spill", async () => {
    await spillBig();
    const readOutput = pi.tools.get("read_output")!;
    const result = await readOutput.execute("c5", {
      id: "out-1",
      limit: 100_000,
    });
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(21_000);
  });
});

describe("on-disk handling", () => {
  // Windows has no POSIX mode bits — chmod there only toggles the read-only flag.
  it.skipIf(process.platform === "win32")(
    "writes owner-only, because output is whatever a command printed",
    async () => {
      await spillBig();
      const dir = path.join(home, "spill", String(process.pid));
      const file = path.join(dir, "out-1.txt");

      // An `env` dump or a .env the model read lands here. World-readable would
      // put it in front of every account on the machine.
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  );

  it("sweeps directories left behind by processes that are gone", async () => {
    // A crash skips the exit hook, so a stale directory is the normal case
    // rather than the exceptional one — and its contents are the sensitive part.
    const dead = path.join(home, "spill", "999999999");
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, "out-1.txt"), "leftover secrets");

    await spillBig();

    expect(fs.existsSync(dead)).toBe(false);
  });

  it("leaves a live process directory alone", async () => {
    const live = path.join(home, "spill", String(process.pid + 0));
    await spillBig();
    // Our own directory is in use and must survive the sweep.
    expect(fs.existsSync(live)).toBe(true);
  });

  it("ignores non-numeric directory names rather than deleting them", async () => {
    const notAPid = path.join(home, "spill", "notapid");
    fs.mkdirSync(notAPid, { recursive: true });
    await spillBig();
    expect(fs.existsSync(notAPid)).toBe(true);
  });
});
