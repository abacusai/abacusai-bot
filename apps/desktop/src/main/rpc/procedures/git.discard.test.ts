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
} from "#shared/contracts";

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
      const relative = path
        .relative(worktree, target)
        .split(path.sep)
        .join("/");
      indexAtTrash.set(
        relative,
        (await git(worktree, "ls-files", "--stage", "--", relative)).stdout
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
