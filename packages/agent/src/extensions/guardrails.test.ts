/**
 * Replacing a file used to be refused outright. It is now allowed, which is
 * only safe because the previous contents are kept and the model is told where
 * — so these pin exactly that pair. Either half alone is worse than the
 * refusal was: a copy nobody can find, or an overwrite with no copy.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import guardrails, { bashWriteTargets, isProtectedPath } from "./guardrails.js";

let cwd: string;
let pi: FakePi;

const ctx = (): { cwd: string } => ({ cwd });

const writeCall = (filePath: string, content = "new contents") => ({
  toolName: "write",
  input: { path: filePath, content },
});

const backupsIn = (relativeDir = "."): string[] => {
  const directory = path.join(cwd, ".abacusai-bot", "backups", relativeDir);
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((n) => n.endsWith(".bak"))
    : [];
};

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-test-"));
  pi = fakePi();
  guardrails(pi.api as never);
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("replacing an existing file", () => {
  it("is allowed, and keeps what was there", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "original contents");

    const blocked = await pi.fire("tool_call", writeCall("server.js"), ctx());

    expect(blocked).toBeUndefined();
    const kept = backupsIn();
    expect(kept).toHaveLength(1);
    const copy = path.join(cwd, ".abacusai-bot", "backups", kept[0] ?? "");
    expect(fs.readFileSync(copy, "utf8")).toBe("original contents");
  });

  it("tells the model where the copy went, and how to put it back", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "original contents");
    await pi.fire("tool_call", writeCall("server.js"), ctx());

    const result = (await pi.fire(
      "tool_result",
      {
        toolName: "write",
        isError: false,
        input: { path: "server.js" },
        content: [{ type: "text", text: "ok" }],
      },
      ctx()
    )) as { content: Array<{ text: string }> } | undefined;

    const text = result?.content.map((part) => part.text).join("\n") ?? "";
    // The message names the copy the way the platform spells a path.
    expect(text).toContain(path.join(".abacusai-bot", "backups"));
    expect(text).toContain("cp ");
    expect(text).toContain("server.js");
  });

  it("keeps the earlier copy when the same file is replaced twice", async () => {
    const file = path.join(cwd, "server.js");
    fs.writeFileSync(file, "first");
    await pi.fire("tool_call", writeCall("server.js"), ctx());
    fs.writeFileSync(file, "second");
    await pi.fire("tool_call", writeCall("server.js"), ctx());

    const kept = backupsIn()
      .map((name) =>
        fs.readFileSync(
          path.join(cwd, ".abacusai-bot", "backups", name),
          "utf8"
        )
      )
      .sort();
    // The first overwrite's copy is the one a rescue actually needs.
    expect(kept).toEqual(["first", "second"]);
  });

  it("mirrors the workspace layout so same-named files stay apart", async () => {
    fs.mkdirSync(path.join(cwd, "client"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "server"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "client", "index.js"), "client side");
    fs.writeFileSync(path.join(cwd, "server", "index.js"), "server side");

    await pi.fire("tool_call", writeCall("client/index.js"), ctx());
    await pi.fire("tool_call", writeCall("server/index.js"), ctx());

    expect(backupsIn("client")).toHaveLength(1);
    expect(backupsIn("server")).toHaveLength(1);
  });

  it("keeps the backups out of the project history", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "original contents");
    await pi.fire("tool_call", writeCall("server.js"), ctx());

    expect(
      fs.readFileSync(
        path.join(cwd, ".abacusai-bot", "backups", ".gitignore"),
        "utf8"
      )
    ).toBe("*\n");
  });

  it("still refuses a file too large to copy", async () => {
    const file = path.join(cwd, "huge.bin");
    fs.writeFileSync(file, Buffer.alloc(26 * 1024 * 1024));

    const blocked = (await pi.fire(
      "tool_call",
      writeCall("huge.bin"),
      ctx()
    )) as {
      block: boolean;
      reason: string;
    };

    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("too large");
    expect(backupsIn()).toHaveLength(0);
    // Writing 26 MB is the point of the test, and a CI disk can take seconds.
  }, 20_000);

  it("says nothing about backups when the file is new", async () => {
    const blocked = await pi.fire(
      "tool_call",
      writeCall("brand-new.js"),
      ctx()
    );
    expect(blocked).toBeUndefined();

    const result = await pi.fire(
      "tool_result",
      {
        toolName: "write",
        isError: false,
        input: { path: "brand-new.js" },
        content: [{ type: "text", text: "ok" }],
      },
      ctx()
    );
    expect(result).toBeUndefined();
    expect(backupsIn()).toHaveLength(0);
  });
});

describe("the guards that stay", () => {
  it("still refuses a protected path", async () => {
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    const blocked = (await pi.fire("tool_call", writeCall(".env"), ctx())) as {
      block: boolean;
    };
    expect(blocked?.block).toBe(true);
    expect(backupsIn()).toHaveLength(0);
  });

  it("still requires a read before an edit", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "original");
    const blocked = (await pi.fire(
      "tool_call",
      {
        toolName: "edit",
        input: { path: "server.js", oldText: "original", newText: "changed" },
      },
      ctx()
    )) as { block: boolean; reason: string };
    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("Read");
  });
});

/**
 * batch_edit writes exactly the way edit does, so every rule that protects a
 * file from edit has to cover it too. A guard that keyed only on the name
 * `edit` would leave a second, unguarded door onto the same files.
 */
describe("batch_edit answers to the edit guards", () => {
  const batchCall = (filePath: string) => ({
    toolName: "batch_edit",
    input: { path: filePath, edits: [{ oldText: "a", newText: "b" }] },
  });

  it("requires a read first, just as edit does", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "original");
    const blocked = (await pi.fire(
      "tool_call",
      batchCall("server.js"),
      ctx()
    )) as {
      block: boolean;
      reason: string;
    };

    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("Read");
  });

  it("refuses a protected path", async () => {
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    const blocked = (await pi.fire("tool_call", batchCall(".env"), ctx())) as {
      block: boolean;
    };

    expect(blocked?.block).toBe(true);
  });

  it("lets through a file that was read this session", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "original");
    await pi.fire(
      "tool_call",
      { toolName: "read", input: { path: "server.js" } },
      ctx()
    );

    const blocked = await pi.fire("tool_call", batchCall("server.js"), ctx());

    expect(blocked).toBeUndefined();
  });

  it("counts a batch read as having read every file it named", async () => {
    // Otherwise the model reads ten files in one call and is then told to read
    // each of them again before it may touch any.
    fs.writeFileSync(path.join(cwd, "server.js"), "original");
    fs.writeFileSync(path.join(cwd, "client.js"), "original");
    await pi.fire(
      "tool_call",
      {
        toolName: "batch_file_read",
        input: { paths: ["server.js", "client.js"] },
      },
      ctx()
    );

    expect(
      await pi.fire("tool_call", batchCall("server.js"), ctx())
    ).toBeUndefined();
    expect(
      await pi.fire(
        "tool_call",
        {
          toolName: "edit",
          input: { path: "client.js", oldText: "a", newText: "b" },
        },
        ctx()
      )
    ).toBeUndefined();
  });
});

/**
 * The redirect guard is for the user's source tree, not for the agent's own
 * scratch files. A real run lost three turns here: the model restarted a dev
 * server, `> /tmp/dating-server.log` was refused because the log already
 * existed, and it reshuffled redirects until the turn wedged.
 */
describe("redirects into scratch space", () => {
  const bashCall = (command: string) => ({
    toolName: "bash",
    input: { command },
  });

  // /tmp is not the temp dir on Windows; the next test covers it there.
  it.skipIf(process.platform === "win32")(
    "allows overwriting a log the agent itself keeps in /tmp",
    async () => {
      fs.writeFileSync("/tmp/guardrails-test-server.log", "from the last run");
      const result = await pi.fire(
        "tool_call",
        bashCall("node server.js > /tmp/guardrails-test-server.log 2>&1 &"),
        ctx()
      );
      fs.rmSync("/tmp/guardrails-test-server.log", { force: true });
      expect(result).toBeUndefined();
    }
  );

  // Skipped on Windows: SCRATCH_PREFIXES holds the 8.3 short form of the temp
  // dir while the guard tests a long-form real path, so it never matches.
  it.skipIf(process.platform === "win32")(
    "treats this platform's own temp dir as scratch, not just /tmp",
    async () => {
      // os.tmpdir() is what Windows actually uses; the hardcoded POSIX list
      // left every temp write there prompting.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-scratch-"));
      const log = path.join(dir, "server.log");
      fs.writeFileSync(log, "from the last run");
      const result = await pi.fire(
        "tool_call",
        bashCall(`echo x > ${log}`),
        ctx()
      );
      fs.rmSync(dir, { recursive: true, force: true });
      expect(result).toBeUndefined();
    }
  );

  // Skipped on Windows: the carve-out lists os.tmpdir()'s 8.3 short name, which
  // never matches the long name the target realpaths to, so the write is blocked.
  it.skipIf(process.platform === "win32")(
    "lets the write tool into this platform's temp dir as well",
    async () => {
      // The guards judge realpath()ed targets, and on macOS realpath maps
      // /var/folders/... to /private/var/folders/... — a form the lexical prefix
      // list missed, so a mktemp file could be shell-redirected but not written
      // with the tools.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-tools-"));
      const result = await pi.fire(
        "tool_call",
        writeCall(path.join(dir, "notes.txt")),
        ctx()
      );
      fs.rmSync(dir, { recursive: true, force: true });
      expect(result).toBeUndefined();
    }
  );

  // Skipped on Windows: same short-form vs long-form mismatch as above.
  it.skipIf(process.platform === "win32")(
    "does not treat a link parked in temp as scratch — the target decides",
    async () => {
      // The carve-out is about where the bytes land, not where the name sits.
      // /etc/hosts is a real file outside every sanctioned area; nothing is
      // written, the point is that the redirect is refused.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-link-"));
      const link = path.join(dir, "innocent.log");
      fs.symlinkSync("/etc/hosts", link);
      const blocked = (await pi.fire(
        "tool_call",
        bashCall(`echo x > ${link}`),
        ctx()
      )) as { block: boolean; reason: string } | undefined;
      fs.rmSync(dir, { recursive: true, force: true });
      expect(blocked?.block).toBe(true);
    }
  );

  it("still refuses a redirect that would clobber a file in the workspace", async () => {
    fs.writeFileSync(path.join(cwd, "server.js"), "the real thing");
    const blocked = (await pi.fire(
      "tool_call",
      bashCall("echo x > server.js"),
      ctx()
    )) as {
      block: boolean;
      reason: string;
    };
    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("overwrite");
  });
});

/**
 * Containment lives in the permission gate (permissions.ts), which follows
 * links; what this guard must not do is break ordinary in-repo links.
 */
describe("symlinks and the workspace guard", () => {
  it("still allows a write through a link that stays inside", async () => {
    fs.mkdirSync(path.join(cwd, "pkg"));
    fs.symlinkSync(path.join(cwd, "pkg"), path.join(cwd, "alias"));

    expect(
      await pi.fire("tool_call", writeCall("alias/new.ts"), ctx())
    ).toBeUndefined();
  });

  it("still allows a plain write to a file that simply is not there yet", async () => {
    expect(
      await pi.fire("tool_call", writeCall("not-yet-created.txt"), ctx())
    ).toBeUndefined();
  });

  // Skipped on Windows: /tmp is not scratch space there, and the temp dir that
  // is does not match the carve-out once the target has been realpath'd.
  it.skipIf(process.platform === "win32")(
    "leaves the scratch carve-out alone",
    async () => {
      // A link into /tmp is not an escape the guard cares about: scratch space is
      // deliberately writable, and refusing it cost a real run three turns.
      const scratch = fs.mkdtempSync("/tmp/guard-scratch-");
      fs.symlinkSync(
        path.join(scratch, "log.txt"),
        path.join(cwd, "log-link.txt")
      );

      expect(
        await pi.fire("tool_call", writeCall("log-link.txt"), ctx())
      ).toBeUndefined();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  );
});

/**
 * The protected-path guard has to follow symlinks too, or a link inside the
 * workspace becomes a way to reach a protected file the pattern test would
 * otherwise catch. The link resolves inside the workspace, so the
 * out-of-workspace check waves it through; only resolving before the protected
 * test closes it.
 */
describe("symlinks that dodge the protected-path guard", () => {
  it("refuses a write through a link that resolves to .env", async () => {
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    fs.symlinkSync(path.join(cwd, ".env"), path.join(cwd, "notes.txt"));

    const blocked = (await pi.fire(
      "tool_call",
      writeCall("notes.txt"),
      ctx()
    )) as { block: boolean; reason: string };

    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("protected");
    // And the real file was left untouched.
    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe("SECRET=1");
  });

  it("refuses a write into a symlinked directory that resolves into .git", async () => {
    fs.mkdirSync(path.join(cwd, "repo", ".git"), { recursive: true });
    fs.symlinkSync(path.join(cwd, "repo", ".git"), path.join(cwd, "gitlink"));

    const blocked = (await pi.fire(
      "tool_call",
      writeCall("gitlink/config"),
      ctx()
    )) as { block: boolean; reason: string };

    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("protected");
  });

  it("refuses a write through a dangling link to a protected name", async () => {
    // No .env.production exists yet — the write through the link would be
    // what creates it, so the guard has to judge the link's aim, not its name.
    fs.symlinkSync(
      path.join(cwd, ".env.production"),
      path.join(cwd, "notes.txt")
    );

    const blocked = (await pi.fire(
      "tool_call",
      writeCall("notes.txt"),
      ctx()
    )) as { block: boolean; reason: string };

    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("protected");
    expect(fs.existsSync(path.join(cwd, ".env.production"))).toBe(false);
  });

  it("refuses an edit through such a link too", async () => {
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    fs.symlinkSync(path.join(cwd, ".env"), path.join(cwd, "notes.txt"));
    // Marked read first, so the protected-path rule is what answers rather than
    // the read-before-edit one.
    await pi.fire(
      "tool_call",
      { toolName: "read", input: { path: "notes.txt" } },
      ctx()
    );

    const blocked = (await pi.fire(
      "tool_call",
      {
        toolName: "edit",
        input: { path: "notes.txt", oldText: "SECRET=1", newText: "x" },
      },
      ctx()
    )) as { block: boolean; reason: string };

    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toContain("protected");
  });

  it("still allows an ordinary in-workspace file that resolves to nothing protected", async () => {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });

    expect(
      await pi.fire("tool_call", writeCall("src/app.ts"), ctx())
    ).toBeUndefined();
  });
});

/**
 * The protected-path guard, on the platform it was silently off for.
 *
 * The patterns are written with `/`, and `path.resolve` returns a `\` separated
 * path on Windows — so none of them matched there and `.env`, `.git` and
 * `node_modules` were all writable. Nothing caught it because this suite runs
 * on macOS and Linux only; Windows gets the build and the CLI smoke test,
 * neither of which touches the guard.
 *
 * These use literal paths rather than `path.resolve`, so both platforms are
 * checked wherever the tests happen to run.
 */
describe("protected paths, whichever separator the platform uses", () => {
  it.each([
    ["posix .env", "/Users/me/proj/.env"],
    ["windows .env", "C:\\Users\\me\\proj\\.env"],
    ["posix .env.local", "/Users/me/proj/.env.local"],
    ["windows .env.local", "C:\\Users\\me\\proj\\.env.local"],
    ["posix .git", "/Users/me/proj/.git/config"],
    ["windows .git", "C:\\Users\\me\\proj\\.git\\config"],
    ["posix node_modules", "/Users/me/proj/node_modules/pkg/index.js"],
    [
      "windows node_modules",
      "C:\\Users\\me\\proj\\node_modules\\pkg\\index.js",
    ],
  ])("protects %s", (_label, target) => {
    expect(isProtectedPath(target)).toBe(true);
  });

  it.each([
    ["a source file", "/Users/me/proj/src/app.ts"],
    ["a windows source file", "C:\\Users\\me\\proj\\src\\app.ts"],
    ["a file merely mentioning env", "/Users/me/proj/environment.ts"],
    [
      "a directory named like the pattern",
      "/Users/me/proj/node_modules_notes.md",
    ],
    ["a file named like git", "/Users/me/proj/.gitignore"],
  ])("leaves %s alone", (_label, target) => {
    expect(isProtectedPath(target)).toBe(false);
  });
});

/**
 * The shell was the way around the protected-path guard: the write tool
 * refused `.env`, and one `>>` in bash wrote it anyway. These pin the pair —
 * both tools refuse, and the commands that reach a protected path without
 * naming it keep working, because blocking those would stop `git commit`.
 */
describe("protected paths, reached through the shell", () => {
  const bashCall = (command: string) => ({
    toolName: "bash",
    input: { command },
  });

  const refusal = async (command: string) =>
    (await pi.fire("tool_call", bashCall(command), ctx())) as
      | { block: boolean; reason: string }
      | undefined;

  beforeEach(() => {
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET_TOKEN=hunter2\n");
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".git", "config"), "[core]\n");
  });

  // The exact reproduction from the audit: `write` refused and bash did not.
  it("refuses the append that the write tool already refuses", async () => {
    const blocked = await refusal('printf "API_KEY=zzz\\n" >> .env');

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("protected");
    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe(
      "SECRET_TOKEN=hunter2\n"
    );
  });

  it("refuses an overwrite redirect into a protected path", async () => {
    expect((await refusal("echo x > .env"))?.block).toBe(true);
  });

  it("refuses a redirect into .git, in any segment of a chain", async () => {
    const blocked = await refusal(
      'echo "" >> .git/config; printf "[my-user]\\n" >> .git/config'
    );

    expect(blocked?.block).toBe(true);
    expect(fs.readFileSync(path.join(cwd, ".git", "config"), "utf8")).toBe(
      "[core]\n"
    );
  });

  // Redirects were only ever half of it. Every one of these writes a file
  // without a `>` anywhere in the command.
  it.each([
    ["tee", "echo x | tee .env"],
    ["tee -a", "echo x | tee -a .env"],
    ["cp", "cp .env.example .env"],
    ["mv", "mv scratch.txt .env"],
    ["sed -i", "sed -i 's/a/b/' .env"],
    ["rm", "rm -f .env"],
    ["truncate", "truncate -s 0 .env"],
    ["dd", "dd if=/dev/zero of=.env"],
    ["ln -s", "ln -s /etc/passwd .env"],
    ["chmod", "chmod 600 .env"],
  ])("refuses %s", async (_name, command) => {
    expect((await refusal(command))?.block).toBe(true);
  });

  it("sees through a sudo or env prefix", async () => {
    expect((await refusal("sudo rm .env"))?.block).toBe(true);
    expect((await refusal("env FOO=1 cp a.txt .env"))?.block).toBe(true);
  });

  it("refuses a write into node_modules", async () => {
    fs.mkdirSync(path.join(cwd, "node_modules", "left-pad"), {
      recursive: true,
    });

    expect(
      (await refusal("echo patch >> node_modules/left-pad/index.js"))?.block
    ).toBe(true);
  });

  // The line that keeps the guard usable: a command has to *name* the path.
  // git and npm write these directories constantly and name neither.
  it.each([
    ["git commit", 'git commit -m "wip"'],
    ["git add", "git add ."],
    ["npm install", "npm install"],
    ["a build writing its own output", "npm run build > build.log"],
    ["reading a protected path", "cat .env"],
    ["grepping one", "grep -r SECRET .env"],
    ["a redirect to /dev/null", "npm test > /dev/null 2>&1"],
    ["a path that merely contains the word", "touch env-notes.txt"],
    ["a sed script mentioning it", "sed -i 's#node_modules#vendor#' Makefile"],
  ])("allows %s", async (_name, command) => {
    expect(await refusal(command)).toBeUndefined();
  });

  it("refuses a shell write through a symlink that resolves to .env", async () => {
    fs.symlinkSync(path.join(cwd, ".env"), path.join(cwd, "notes.txt"));

    expect((await refusal("echo x >> notes.txt"))?.block).toBe(true);
    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe(
      "SECRET_TOKEN=hunter2\n"
    );
  });

  it("still refuses the deny-listed commands first", async () => {
    const blocked = await refusal("rm -rf /");

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("blocked");
  });
});

describe("bashWriteTargets", () => {
  it("does not read 2>&1 as a file called &1", () => {
    expect(bashWriteTargets("npm test 2>&1")).toEqual([]);
  });

  it("takes the append target as well as the overwrite one", () => {
    expect(bashWriteTargets("a > one.txt; b >> two.txt")).toEqual([
      "one.txt",
      "two.txt",
    ]);
  });

  it("takes the destination of a copy, not the source", () => {
    expect(bashWriteTargets("cp -r src/ dist/")).toEqual(["dist/"]);
  });

  it("leaves sed alone when it is only reading", () => {
    expect(bashWriteTargets("sed 's/a/b/' notes.txt")).toEqual([]);
  });

  it("keeps quoted paths whole", () => {
    expect(bashWriteTargets('cp a.txt "my notes.txt"')).toEqual([
      "my notes.txt",
    ]);
  });
});
