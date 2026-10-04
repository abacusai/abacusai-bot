/**
 * R4-T33, `git.discard` (spec 04 §26.4 c) in a session's sibling worktree:
 * a staged addition and a staged rename put their new file in the Trash
 * before the index entry goes (the content is recoverable), a rename's source
 * comes back from HEAD, a Trash failure changes nothing for that entry, and
 * the primary checkout is untouched.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentSessionListItem,
  WorkspaceListItem,
} from "@abacus-ai/contract/contracts";

import { setMigrationWriteBlocks } from "../../migrations/write-block";
import { CheckoutService } from "../../services/workspace/checkout-service";
import { FileTreeService } from "../../services/workspace/file-tree-service";
import { GitService } from "../../services/workspace/git-service";
import { connectInProcess, fakeDeps, type TestClient } from "../testing";

const execFileAsync = promisify(execFile);
const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
/** Long enough that one added line keeps git's rename detection. */
const ORIGINAL_A = Array.from({ length: 12 }, (_, n) => `line ${n}\n`).join("");

let root = "";
let primary = "";
let worktree = "";
let trashDir = "";
let service: CheckoutService;
let client: TestClient;
let close: () => void = () => undefined;
/** What the index held for a path at the moment it was trashed. */
let indexAtTrash: Map<string, string>;
let failTrash = false;

const git = (cwd: string, ...args: string[]) =>
  execFileAsync("git", ["-C", cwd, ...args]);
const status = async (cwd: string) =>
  (await git(cwd, "status", "--porcelain")).stdout;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "abacus-discard-"))
  );
  primary = path.join(root, "primary");
  worktree = path.join(root, "wt");
  trashDir = path.join(root, "trash");
  await fs.mkdir(primary);
  await fs.mkdir(trashDir);
  await git(primary, "init", "-b", "main");
  await git(primary, "config", "user.email", "discard@example.invalid");
  await git(primary, "config", "user.name", "Discard Test");
  // The fixture's byte assertions should not depend on the machine's Git config.
  await git(primary, "config", "core.autocrlf", "false");
  await fs.mkdir(path.join(primary, "src"));
  await fs.writeFile(path.join(primary, "src", "a.txt"), ORIGINAL_A);
  await fs.writeFile(path.join(primary, "keep.txt"), "keep\n");
  await git(primary, "add", ".");
  await git(primary, "commit", "-m", "initial");
  await git(primary, "worktree", "add", "-b", "feature", worktree);

  indexAtTrash = new Map();
  failTrash = false;
  service = new CheckoutService({
    workspace: (id) =>
      id === WS
        ? ({
            id: WS,
            label: "p",
            status: "active",
            path: primary,
          } as WorkspaceListItem)
        : null,
    session: (id) =>
      id === SESSION
        ? ({
            id: SESSION,
            workspaceId: WS,
            worktreeId: "wt",
            worktreePath: worktree,
            worktreeBranch: "feature",
          } as AgentSessionListItem)
        : null,
    git: new GitService(),
    files: new FileTreeService(),
    search: async () => ({ items: [] }),
    trash: async (target) => {
      if (failTrash) throw new Error("The Trash is not available");
      const checkoutRoot = target.startsWith(`${worktree}${path.sep}`)
        ? worktree
        : primary;
      const relative = path
        .relative(checkoutRoot, target)
        .split(path.sep)
        .join("/");
      indexAtTrash.set(
        relative,
        (await git(checkoutRoot, "ls-files", "--stage", "--", relative)).stdout
      );
      await fs.rename(target, path.join(trashDir, path.basename(target)));
    },
    watch: null,
    pollMs: null,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const connection = connectInProcess(
    fakeDeps({
      serviceHost: {
        checkouts: service,
        refreshGitState: async () => undefined,
      },
    })
  );
  client = connection.client;
  close = () => {
    connection.closeClient();
    connection.closeServer();
  };
});

afterEach(async () => {
  setMigrationWriteBlocks(null);
  close();
  service.dispose();
  vi.restoreAllMocks();
  await git(primary, "worktree", "prune").catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

const checkout = { workspaceId: WS, sessionId: SESSION };

describe("git.discard (R4-T33)", () => {
  it("a staged addition goes to the Trash before its index entry is removed", async () => {
    const primaryStatus = await status(primary);
    await fs.writeFile(path.join(worktree, "new.txt"), "precious\n");
    await git(worktree, "add", "new.txt");

    const result = await client.git.discard({
      checkout,
      entries: [{ path: "new.txt" }],
    });

    expect(result).toEqual({ discarded: ["new.txt"], failed: [] });
    // Still staged when it was trashed: the index changed only afterwards.
    expect(indexAtTrash.get("new.txt")).toMatch(/new\.txt/);
    await expect(
      fs.readFile(path.join(trashDir, "new.txt"), "utf8")
    ).resolves.toBe("precious\n");
    expect(await status(worktree)).toBe("");
    expect(await status(primary)).toBe(primaryStatus);
  });

  it("a staged rename: the destination to the Trash, the source restored from HEAD", async () => {
    await git(worktree, "mv", "src/a.txt", "src/b.txt");
    await fs.writeFile(
      path.join(worktree, "src", "b.txt"),
      `${ORIGINAL_A}edited\n`
    );
    await git(worktree, "add", "src/b.txt");
    const changes = (await new GitService().readGitChanges(worktree)).changes;
    expect(changes).toContainEqual(
      expect.objectContaining({ path: "src/b.txt", origPath: "src/a.txt" })
    );

    const result = await client.git.discard({
      checkout,
      entries: [{ path: "src/b.txt", origPath: "src/a.txt" }],
    });

    expect(result).toEqual({ discarded: ["src/b.txt"], failed: [] });
    expect(indexAtTrash.get("src/b.txt")).toMatch(/src\/b\.txt/);
    await expect(
      fs.readFile(path.join(trashDir, "b.txt"), "utf8")
    ).resolves.toBe(`${ORIGINAL_A}edited\n`);
    await expect(
      fs.readFile(path.join(worktree, "src", "a.txt"), "utf8")
    ).resolves.toBe(ORIGINAL_A);
    expect(await status(worktree)).toBe("");
  });

  it("a tracked modification, staged and unstaged, is put back as HEAD has it", async () => {
    await fs.writeFile(path.join(worktree, "keep.txt"), "staged\n");
    await git(worktree, "add", "keep.txt");
    await fs.writeFile(path.join(worktree, "keep.txt"), "and more\n");

    await expect(
      client.git.discard({ checkout, entries: [{ path: "keep.txt" }] })
    ).resolves.toEqual({ discarded: ["keep.txt"], failed: [] });
    await expect(
      fs.readFile(path.join(worktree, "keep.txt"), "utf8")
    ).resolves.toBe("keep\n");
    expect(indexAtTrash.size).toBe(0);
  });

  it("a Trash failure stops that entry before any index change; the others still run", async () => {
    await fs.writeFile(path.join(worktree, "new.txt"), "precious\n");
    await git(worktree, "add", "new.txt");
    await fs.writeFile(path.join(worktree, "keep.txt"), "edit\n");
    failTrash = true;

    const result = await client.git.discard({
      checkout,
      entries: [{ path: "new.txt" }, { path: "keep.txt" }],
    });

    expect(result).toMatchObject({
      discarded: ["keep.txt"],
      failed: [{ path: "new.txt", reason: "trash" }],
    });
    expect(await status(worktree)).toBe("A  new.txt\n");
    await expect(
      fs.readFile(path.join(worktree, "new.txt"), "utf8")
    ).resolves.toBe("precious\n");
  });
});

it("refuses an occupied rename source before trashing anything", async () => {
  await git(worktree, "mv", "src/a.txt", "src/b.txt");
  await fs.writeFile(path.join(worktree, "src/a.txt"), "new precious content");
  const before = await status(worktree);
  const result = await client.git.discard({
    checkout,
    entries: [{ path: "src/b.txt", origPath: "src/a.txt" }],
  });
  expect(result.failed).toMatchObject([{ reason: "occupied" }]);
  expect(indexAtTrash.size).toBe(0);
  expect(await status(worktree)).toBe(before);
  expect(await fs.readFile(path.join(worktree, "src/a.txt"), "utf8")).toBe(
    "new precious content"
  );
});

it("refuses a symlink at the rename source even when its target matches HEAD", async () => {
  await git(worktree, "mv", "src/a.txt", "src/b.txt");
  await fs.symlink("b.txt", path.join(worktree, "src/a.txt"));
  const before = await status(worktree);
  const result = await client.git.discard({
    checkout,
    entries: [{ path: "src/b.txt", origPath: "src/a.txt" }],
  });
  expect(result.failed).toMatchObject([{ reason: "occupied" }]);
  expect(indexAtTrash.size).toBe(0);
  expect(await status(worktree)).toBe(before);
  expect(await fs.readlink(path.join(worktree, "src/a.txt"))).toBe("b.txt");
  expect(await fs.readFile(path.join(worktree, "src/b.txt"), "utf8")).toBe(
    ORIGINAL_A
  );
});

it("a subfolder checkout restores mixed-case tracked paths and renames from the repository root", async () => {
  primary = path.join(primary, "src");
  const repo = path.dirname(primary);
  await fs.writeFile(path.join(primary, "Mixed Name.txt"), ORIGINAL_A);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "mixed");
  await fs.writeFile(path.join(primary, "Mixed Name.txt"), "changed");
  const watch = service.watch({ workspaceId: WS });
  await service.refresh(watch.key);
  expect(service.rows()[0]?.gitChanges).toMatchObject([
    { path: "Mixed Name.txt" },
  ]);
  watch.release();
  const ref = { workspaceId: WS };
  expect(
    await client.git.discard({
      checkout: ref,
      entries: [{ path: "Mixed Name.txt" }],
    })
  ).toEqual({ discarded: ["Mixed Name.txt"], failed: [] });
  expect(await fs.readFile(path.join(primary, "Mixed Name.txt"), "utf8")).toBe(
    ORIGINAL_A
  );
  await git(primary, "mv", "--", "Mixed Name.txt", "-renamed name.txt");
  expect(
    await client.git.discard({
      checkout: ref,
      entries: [{ path: "-renamed name.txt", origPath: "Mixed Name.txt" }],
    })
  ).toEqual({ discarded: ["-renamed name.txt"], failed: [] });
  expect(await fs.readFile(path.join(primary, "Mixed Name.txt"), "utf8")).toBe(
    ORIGINAL_A
  );
  expect(await status(repo)).toBe("");
});

it("refuses directories, wrong case, and internal symlink aliases without deleting staged additions", async () => {
  await fs.writeFile(path.join(worktree, "src/a.txt"), "edit");
  await fs.writeFile(path.join(worktree, "src/new.txt"), "staged precious");
  await git(worktree, "add", "src/new.txt");
  await fs.symlink("src", path.join(worktree, "link"));
  const before = await status(worktree);
  const result = await client.git.discard({
    checkout,
    entries: [{ path: "src" }, { path: "src/A.TXT" }, { path: "link/a.txt" }],
  });
  expect(result.failed.map((failure) => failure.reason)).toEqual([
    "not-changed",
    "not-changed",
    "not-changed",
  ]);
  expect(await status(worktree)).toBe(before);
  expect(await fs.readFile(path.join(worktree, "src/new.txt"), "utf8")).toBe(
    "staged precious"
  );
  expect(await fs.readFile(path.join(worktree, "src/a.txt"), "utf8")).toBe(
    "edit"
  );
});

it.skipIf(process.platform === "win32")(
  "preserves literal backslashes through checkout operations",
  async () => {
    await fs.mkdir(path.join(worktree, "a"));
    await fs.writeFile(path.join(worktree, "a/b.txt"), "nested");
    await fs.writeFile(path.join(worktree, "a\\b.txt"), "literal");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-m", "backslash");
    await fs.writeFile(path.join(worktree, "a/b.txt"), "nested edit");
    await fs.writeFile(path.join(worktree, "a\\b.txt"), "literal edit");
    await expect(
      client.git.diff({ checkout, filePath: "a\\b.txt" })
    ).resolves.toMatchObject({
      kind: "patch",
      patch: expect.stringContaining("+literal edit"),
    });
    await client.git.discard({ checkout, entries: [{ path: "a\\b.txt" }] });
    expect(await fs.readFile(path.join(worktree, "a\\b.txt"), "utf8")).toBe(
      "literal"
    );
    expect(await fs.readFile(path.join(worktree, "a/b.txt"), "utf8")).toBe(
      "nested edit"
    );
  }
);

it("a missing worktree .git file cannot discard in a containing repository", async () => {
  worktree = path.join(primary, "nested");
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, "new.txt"), "precious");
  const result = await client.git.discard({
    checkout,
    entries: [{ path: "new.txt" }],
  });
  expect(result.failed).toMatchObject([{ reason: "git" }]);
  expect(await fs.readFile(path.join(worktree, "new.txt"), "utf8")).toBe(
    "precious"
  );
});

it("reports partial when trash succeeded but the index cannot be changed", async () => {
  await fs.writeFile(path.join(worktree, "new.txt"), "precious");
  await git(worktree, "add", "new.txt");
  const index = (
    await git(worktree, "rev-parse", "--git-path", "index")
  ).stdout.trim();
  const lock = `${path.resolve(worktree, index)}.lock`;
  await fs.writeFile(lock, "locked");
  const result = await client.git.discard({
    checkout,
    entries: [{ path: "new.txt" }],
  });
  expect(result.failed).toMatchObject([{ reason: "partial" }]);
  expect(await fs.readFile(path.join(trashDir, "new.txt"), "utf8")).toBe(
    "precious"
  );
  await fs.rm(lock);
});

it.each(["destination", "origin", "unknown"])(
  "migration write blocks protect %s before any discard mutation",
  async (kind) => {
    await git(worktree, "mv", "src/a.txt", "src/b.txt");
    const before = await status(worktree);
    setMigrationWriteBlocks({
      unresolved: [
        {
          attempt: "pending",
          destinations:
            kind === "unknown"
              ? null
              : [
                  path.join(
                    worktree,
                    kind === "origin" ? "src/a.txt" : "src/b.txt"
                  ),
                ],
        },
      ],
    } as never);
    const result = await client.git.discard({
      checkout,
      entries: [{ path: "src/b.txt", origPath: "src/a.txt" }],
    });
    expect(result.failed).toMatchObject([{ reason: "blocked" }]);
    expect(await status(worktree)).toBe(before);
    expect(indexAtTrash.size).toBe(0);
  }
);

it("refresh retargets a watched primary checkout after relocation", async () => {
  const watched = service.watch({ workspaceId: WS });
  await service.refresh(watched.key);
  const old = primary;
  primary = path.join(root, "relocated");
  await fs.rename(old, primary);
  await fs.writeFile(path.join(primary, "keep.txt"), "relocated edit");
  await service.refresh(watched.key);
  expect(service.rows()[0]).toMatchObject({
    checkoutPath: primary,
    gitChanges: [expect.objectContaining({ path: "keep.txt" })],
  });
  watched.release();
});

it("a directory replacing a tracked file retains every new file", async () => {
  await fs.rm(path.join(worktree, "keep.txt"));
  await fs.mkdir(path.join(worktree, "keep.txt"));
  await fs.writeFile(path.join(worktree, "keep.txt/new.txt"), "precious");
  const result = await client.git.discard({
    checkout,
    entries: [{ path: "keep.txt" }],
  });
  expect(result.failed).toMatchObject([{ reason: "not-changed" }]);
  expect(
    await fs.readFile(path.join(worktree, "keep.txt/new.txt"), "utf8")
  ).toBe("precious");
});
