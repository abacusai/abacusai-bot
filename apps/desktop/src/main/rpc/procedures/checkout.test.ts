/**
 * R4-T33 (spec 04 §26.4 a, b, h, i): the checkout-aware procedures, over the
 * real router, against a real repository with a sibling worktree attached to
 * a session. Everything happens in the worktree and the primary checkout is
 * byte-identical afterwards; paths that escape are FORBIDDEN; the gitState
 * table holds one row per checkout, keyed by `checkoutKey`, with
 * fingerprints that move for an index-only change, a new HEAD and a
 * same-size worktree edit.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trashed = vi.hoisted(() => ({ items: [] as string[] }));
vi.mock("electron", () => ({
  shell: {
    trashItem: async (target: string) => {
      trashed.items.push(target);
      await (
        await import("node:fs/promises")
      ).rm(target, {
        recursive: true,
        force: true,
      });
    },
  },
}));

import { checkoutKey } from "#shared/contract/checkout";
import type { GitStateRow } from "#shared/contract/rows";
import type {
  AgentSessionListItem,
  GitChangeItem,
  WorkspaceListItem,
} from "#shared/contracts";

import { PrefsStore } from "../../services/config/prefs-store";
import { CheckoutService } from "../../services/workspace/checkout-service";
import { FileTreeService } from "../../services/workspace/file-tree-service";
import { GitService } from "../../services/workspace/git-service";
import { MainEventBus } from "../event-bus";
import { createTables } from "../tables";
import { connectInProcess, fakeDeps, stub, type TestClient } from "../testing";

const execFileAsync = promisify(execFile);

let root = "";
let primary = "";
let worktreeA = "";
let worktreeB = "";
const WS = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "22222222-2222-4222-8222-222222222222";
const SESSION_B = "33333333-3333-4333-8333-333333333333";
const SESSION_PRIMARY = "44444444-4444-4444-8444-444444444444";

const git = (cwd: string, ...args: string[]) =>
  execFileAsync("git", ["-C", cwd, ...args]);

const session = (
  id: string,
  worktree: { id: string; path: string } | null
): AgentSessionListItem =>
  ({
    id,
    workspaceId: WS,
    worktreeId: worktree?.id ?? null,
    worktreePath: worktree?.path ?? null,
    worktreeBranch: null,
  }) as AgentSessionListItem;

/** Every file under `dir` (not `.git`) with its bytes, plus git's status. */
const fingerprintTree = async (dir: string): Promise<string> => {
  const hash = createHash("sha256");
  const walk = async (current: string): Promise<void> => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      hash.update(path.relative(dir, full));
      if (entry.isDirectory()) await walk(full);
      else hash.update(await fs.readFile(full));
    }
  };
  await walk(dir);
  hash.update((await git(dir, "status", "--porcelain")).stdout);
  return hash.digest("hex");
};

let service: CheckoutService;
let client: TestClient;
let closers: Array<() => void> = [];
const sessions = new Map<string, AgentSessionListItem>();

beforeEach(async () => {
  trashed.items.length = 0;
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "abacus-checkout-"))
  );
  primary = path.join(root, "primary");
  await fs.mkdir(primary);
  await git(primary, "init", "-b", "main");
  await git(primary, "config", "user.email", "checkout@example.invalid");
  await git(primary, "config", "user.name", "Checkout Test");
  await fs.writeFile(path.join(primary, "README.md"), "hello\n");
  await fs.mkdir(path.join(primary, "src"));
  await fs.writeFile(path.join(primary, "src", "a.txt"), "aaaa\n");
  await git(primary, "add", ".");
  await git(primary, "commit", "-m", "initial");
  worktreeA = path.join(root, "wt-a");
  worktreeB = path.join(root, "wt-b");
  await git(primary, "worktree", "add", "-b", "feature-a", worktreeA);
  await git(primary, "worktree", "add", "-b", "feature-b", worktreeB);
  // The primary checkout has a change of its own that must survive.
  await fs.writeFile(path.join(primary, "README.md"), "primary edit\n");

  sessions.clear();
  sessions.set(SESSION_A, session(SESSION_A, { id: "wt-a", path: worktreeA }));
  sessions.set(SESSION_B, session(SESSION_B, { id: "wt-b", path: worktreeB }));
  sessions.set(SESSION_PRIMARY, session(SESSION_PRIMARY, null));
  const workspace = {
    id: WS,
    label: "primary",
    status: "active",
    path: primary,
  } as WorkspaceListItem;
  service = new CheckoutService({
    workspace: (id) => (id === WS ? workspace : null),
    session: (id) => sessions.get(id) ?? null,
    git: new GitService(),
    files: new FileTreeService(),
    search: async (searchRoot, query) => ({
      items: [
        {
          relativePath: `${path.basename(searchRoot)}:${query}`,
          fileName: query,
          kind: "file",
        },
      ],
    }),
    trash: async (target) => {
      trashed.items.push(target);
      await fs.rm(target, { force: true });
    },
    watch: null,
    pollMs: null,
  });
  closers = [];
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  service.dispose();
  vi.restoreAllMocks();
  await git(primary, "worktree", "prune").catch(() => undefined);
  // The last refresh can still have a git process releasing its working
  // directory after disposal. Windows holds that directory until it exits.
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

const connect = (extra: object = {}): TestClient => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const connection = connectInProcess(
    fakeDeps({ serviceHost: { checkouts: service, ...extra } })
  );
  closers.push(() => {
    connection.closeClient();
    connection.closeServer();
  });
  return connection.client;
};

const inA = { workspaceId: WS, sessionId: SESSION_A };

describe("checkout-aware files and git (R4-T33)", () => {
  it("tree, children, search, rename, trash and diff act in the session's worktree; the primary checkout is untouched", async () => {
    client = connect();
    const before = await fingerprintTree(primary);
    await fs.writeFile(path.join(worktreeA, "src", "a.txt"), "worktree\n");
    await fs.writeFile(path.join(worktreeA, "new.txt"), "fresh\n");

    const tree = await client.files.treeRoot({ checkout: inA });
    expect(tree.fileTree.map((node) => node.name)).toEqual(
      expect.arrayContaining(["README.md", "src", "new.txt"])
    );
    expect(
      tree.fileTree.every((node) => node.absolutePath.startsWith(worktreeA))
    ).toBe(true);

    const children = await client.files.treeChildren({
      checkout: inA,
      directoryPath: "src",
    });
    expect(children).toMatchObject([
      { name: "a.txt", absolutePath: path.join(worktreeA, "src", "a.txt") },
    ]);

    const search = await client.files.search({ checkout: inA, query: "a" });
    expect(search.items[0]!.relativePath).toBe("wt-a:a");

    await client.files.rename({
      checkout: inA,
      fromPath: "new.txt",
      toPath: "renamed.txt",
    });
    await expect(
      fs.readFile(path.join(worktreeA, "renamed.txt"), "utf8")
    ).resolves.toBe("fresh\n");

    await client.files.trash({ checkout: inA, filePath: "renamed.txt" });
    expect(trashed.items).toEqual([path.join(worktreeA, "renamed.txt")]);

    await expect(
      client.git.diff({ checkout: inA, filePath: "src/a.txt" })
    ).resolves.toMatchObject({
      kind: "patch",
      patch: expect.stringContaining("+worktree"),
    });

    expect(await fingerprintTree(primary)).toBe(before);
  });

  it("the primary checkout without a session, or a session with no worktree", async () => {
    client = connect();
    for (const checkout of [
      { workspaceId: WS },
      { workspaceId: WS, sessionId: SESSION_PRIMARY },
    ]) {
      const diff = await client.git.diff({ checkout, filePath: "README.md" });
      expect(diff).toMatchObject({
        kind: "patch",
        patch: expect.stringContaining("+primary edit"),
      });
    }
  });

  it("paths escaping the checkout are FORBIDDEN {outside}, symlinks included", async () => {
    client = connect();
    await fs.symlink(primary, path.join(worktreeA, "escape"));
    const outside = [
      "../primary/README.md",
      path.join(primary, "README.md"),
      "escape/README.md",
    ];
    for (const filePath of outside) {
      await expect(
        client.git.diff({ checkout: inA, filePath })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        defined: true,
        data: { reason: "outside" },
      });
      await expect(
        client.files.trash({ checkout: inA, filePath })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "outside" },
      });
    }
    await expect(
      client.files.rename({
        checkout: inA,
        fromPath: "README.md",
        toPath: "../primary/stolen.md",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "outside" } });
    await expect(
      client.files.treeChildren({ checkout: inA, directoryPath: "escape" })
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "outside" } });
    await expect(
      client.git.discard({ checkout: inA, entries: [{ path: "../x" }] })
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "outside" } });
    expect(trashed.items).toEqual([]);
  });

  it("an unknown workspace or session, or a session of another workspace, is NOT_FOUND", async () => {
    client = connect();
    sessions.set("55555555-5555-4555-8555-555555555555", {
      ...session("55555555-5555-4555-8555-555555555555", null),
      workspaceId: "66666666-6666-4666-8666-666666666666",
    });
    await expect(
      client.files.treeRoot({
        checkout: { workspaceId: "77777777-7777-4777-8777-777777777777" },
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { entity: "workspace" },
    });
    await expect(
      client.files.treeRoot({
        checkout: {
          workspaceId: WS,
          sessionId: "55555555-5555-4555-8555-555555555555",
        },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { entity: "session" } });
  });

  it("git.diff kinds: patch, a staged-only change asked as unstaged is none, untracked, binary", async () => {
    client = connect();
    await fs.writeFile(path.join(worktreeA, "src", "a.txt"), "staged\n");
    await git(worktreeA, "add", "src/a.txt");
    await fs.writeFile(path.join(worktreeA, "loose.txt"), "one\ntwo\n");
    await fs.writeFile(
      path.join(worktreeA, "README.md"),
      Buffer.from([0, 1, 2, 3, 0, 255])
    );

    await expect(
      client.git.diff({
        checkout: inA,
        filePath: "src/a.txt",
        scope: "unstaged",
      })
    ).resolves.toEqual({ kind: "none" });
    await expect(
      client.git.diff({ checkout: inA, filePath: "src/a.txt", scope: "staged" })
    ).resolves.toMatchObject({
      kind: "patch",
      patch: expect.stringContaining("+staged"),
    });
    await expect(
      client.git.diff({ checkout: inA, filePath: "loose.txt" })
    ).resolves.toMatchObject({
      kind: "untracked",
      patch: expect.stringContaining("+two"),
    });
    await expect(
      client.git.diff({ checkout: inA, filePath: "README.md" })
    ).resolves.toEqual({ kind: "binary" });
    // Tracked and unchanged in either scope.
    await fs.writeFile(path.join(worktreeB, "README.md"), "hello\n");
    await expect(
      client.git.diff({
        checkout: { workspaceId: WS, sessionId: SESSION_B },
        filePath: "README.md",
      })
    ).resolves.toEqual({ kind: "none" });
  });

  it("checkoutStatus reports a deleted worktree with an intact primary", async () => {
    client = connect();
    await expect(client.git.checkoutStatus({ checkout: inA })).resolves.toEqual(
      {
        kind: "worktree",
        path: worktreeA,
        exists: true,
        workspaceExists: true,
      }
    );
    await fs.rm(worktreeA, { recursive: true, force: true });
    await expect(client.git.checkoutStatus({ checkout: inA })).resolves.toEqual(
      {
        kind: "worktree",
        path: worktreeA,
        exists: false,
        workspaceExists: true,
      }
    );
    await expect(
      client.git.checkoutStatus({ checkout: { workspaceId: WS } })
    ).resolves.toEqual({
      kind: "primary",
      path: primary,
      exists: true,
      workspaceExists: true,
    });
  });
});

describe("gitState per checkout (R4-T33)", () => {
  /** Tables over a primary row from a runtime-like source, plus the service. */
  const tablesWith = async () => {
    const git = new GitService();
    const primaryState = await git.readGitChanges(primary, {
      fingerprints: true,
    });
    const sources = {
      ...stub("sources", {}),
      listAllAgentSessions: () => [],
      listSessionTurnStates: () => [],
      onSessionsChanged: () => () => undefined,
      listBots: () => [],
      onBotsWritten: () => () => undefined,
      listRoutines: () => [],
      onRoutinesWritten: () => () => undefined,
      listSessionArtifacts: () => [],
      listMemories: () => ({ global: [], bots: [] }),
      listBotMemories: () => [],
      getMetadata: () => ({
        workspaces: [
          {
            id: WS,
            label: "p",
            status: "active",
            path: primary,
          } as WorkspaceListItem,
        ],
        activeWorkspaceId: WS,
        materialIconsBasePath: null,
        lastUpdatedAt: "",
      }),
      onWorkspacesChanged: () => () => undefined,
      getGitState: () => ({
        gitChanges: primaryState.changes,
        gitAvailable: true,
        gitStatusMessage: primaryState.message,
        lastUpdatedAt: "",
      }),
      gitStateWorkspacePath: () => primary,
      botHome: () => root,
      checkoutRows: () => service.rows(),
      onCheckoutRowsChanged: (listener: () => void) =>
        service.onRowsChanged(listener),
    };
    return createTables({
      bus: new MainEventBus(),
      sources: sources as never,
      prefsStore: new PrefsStore({ file: null }),
      watchMemories: false,
      routinesClockMs: null,
      artifactsPollMs: null,
    });
  };

  it("a primary and two worktrees are three rows keyed by checkoutKey, while watched", async () => {
    const tables = await tablesWith();
    const connection = connectInProcess(
      fakeDeps({ serviceHost: { checkouts: service }, tables })
    );
    closers.push(() => {
      connection.closeClient();
      connection.closeServer();
    });
    await fs.writeFile(path.join(worktreeA, "src", "a.txt"), "in a\n");
    await fs.writeFile(path.join(worktreeB, "b-only.txt"), "in b\n");

    const watchA = await connection.client.git.watch({ checkout: inA });
    const watchB = await connection.client.git.watch({
      checkout: { workspaceId: WS, sessionId: SESSION_B },
    });
    await expect(watchA.next()).resolves.toMatchObject({
      value: { type: "watching", checkoutKey: checkoutKey(WS, "wt-a") },
    });
    await expect(watchB.next()).resolves.toMatchObject({
      value: { checkoutKey: checkoutKey(WS, "wt-b") },
    });
    await vi.waitFor(() => expect(service.rows()).toHaveLength(2));

    const rows = (await connection.client.db.gitState.snapshot()).rows;
    const byKey = new Map(rows.map((row) => [row.checkoutKey, row]));
    expect([...byKey.keys()].sort()).toEqual(
      [
        checkoutKey(WS, null),
        checkoutKey(WS, "wt-a"),
        checkoutKey(WS, "wt-b"),
      ].sort()
    );
    const paths = (row: GitStateRow | undefined) =>
      row?.gitChanges.map((change) => change.path);
    expect(paths(byKey.get(checkoutKey(WS, null)))).toEqual(["README.md"]);
    expect(paths(byKey.get(checkoutKey(WS, "wt-a")))).toEqual(["src/a.txt"]);
    expect(paths(byKey.get(checkoutKey(WS, "wt-b")))).toEqual(["b-only.txt"]);
    expect(byKey.get(checkoutKey(WS, "wt-a"))).toMatchObject({
      workspaceId: WS,
      checkoutPath: worktreeA,
    });

    // Closing a watch removes that row.
    await watchB.return();
    await vi.waitFor(() =>
      expect(
        tables.gitState
          .snapshot()
          .rows.map((row) => row.checkoutKey)
          .sort()
      ).toEqual([checkoutKey(WS, null), checkoutKey(WS, "wt-a")].sort())
    );
    await watchA.return();
    tables.dispose();
  });

  it("fingerprints change for an index-only change, a HEAD change and a same-size worktree edit", async () => {
    const { key, release } = service.watch(inA);
    const fingerprints = async (file: string) => {
      await service.refresh(key);
      const row = service.rows().find((entry) => entry.checkoutKey === key)!;
      return row.gitChanges.find(
        (change: GitChangeItem) => change.path === file
      )?.fingerprints;
    };
    const file = path.join(worktreeA, "src", "a.txt");

    // Staged and unstaged at once.
    await fs.writeFile(file, "bbbb\n");
    await git(worktreeA, "add", "src/a.txt");
    await fs.writeFile(file, "cccc\n");
    const first = await fingerprints("src/a.txt");
    expect(first?.staged).toEqual(expect.any(String));
    expect(first?.unstaged).toEqual(expect.any(String));

    // Same size, same status, different bytes: only the unstaged side moves.
    await fs.writeFile(file, "dddd\n");
    const sameStat = await fingerprints("src/a.txt");
    expect(sameStat?.staged).toBe(first?.staged);
    expect(sameStat?.unstaged).not.toBe(first?.unstaged);

    // Index only: the status letters stay "MM".
    await fs.writeFile(file, "eeee\n");
    await git(worktreeA, "add", "src/a.txt");
    await fs.writeFile(file, "dddd\n");
    const indexOnly = await fingerprints("src/a.txt");
    expect(indexOnly?.staged).not.toBe(sameStat?.staged);
    expect(indexOnly?.unstaged).not.toBe(sameStat?.unstaged);

    // A new HEAD (a commit of another file) moves the staged side.
    await fs.writeFile(path.join(worktreeA, "other.txt"), "x\n");
    await git(worktreeA, "add", "other.txt");
    await git(worktreeA, "commit", "-m", "other", "--", "other.txt");
    const headChange = await fingerprints("src/a.txt");
    expect(headChange?.staged).not.toBe(indexOnly?.staged);
    expect(headChange?.unstaged).toBe(indexOnly?.unstaged);
    release();
  });

  it("a file-tree change of a watched checkout is a files.events tree-root-changed with its key", async () => {
    const connection = connectInProcess(
      fakeDeps({
        serviceHost: { checkouts: service, activeCheckoutKey: () => null },
      })
    );
    closers.push(() => {
      connection.closeClient();
      connection.closeServer();
    });
    const events = await connection.client.files.events();
    const { release } = service.watch(inA);
    await connection.client.files.rename({
      checkout: inA,
      fromPath: "README.md",
      toPath: "READ.md",
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "tree-root-changed",
        checkoutKey: checkoutKey(WS, "wt-a"),
      },
    });
    release();
    await events.return();
  });
});
