/**
 * R4-T33, `browser.runtime.materializeFile`'s guard (spec 04 §12.8, §26.4
 * f): the readers' containment (symlinks resolved first), a regular file, a
 * pdf/html/htm type, and the main renderer only. What reaches the runtime
 * are real paths. The root itself is checked against what main derives for
 * the conversation (ServiceHost's real `localPreviewRoots`): its checkout
 * (the session's worktree when it has one) or its workspace's artifact
 * folders; any other `hostRoot` is `FORBIDDEN {root-not-allowed}`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentSessionListItem,
  SessionArtifact,
  WorkspaceListItem,
} from "#shared/contracts";
import {
  draftConversationKey,
  sessionConversationKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import { CheckoutService } from "../../services/workspace/checkout-service";
import { FileTreeService } from "../../services/workspace/file-tree-service";
import { GitService } from "../../services/workspace/git-service";
import { connectInProcess, fakeDeps } from "../testing";

vi.mock("electron", () => {
  // ServiceHost's module graph touches Electron at import; nothing of it is
  // exercised here.
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});

let root = "";
let checkout = "";
let worktree = "";
let artifacts = "";
const closers: Array<() => void> = [];

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "abacus-local-file-"))
  );
  checkout = path.join(root, "checkout");
  await fs.mkdir(path.join(checkout, "docs"), { recursive: true });
  await fs.writeFile(path.join(checkout, "docs", "report.pdf"), "%PDF-1.4\n");
  await fs.writeFile(path.join(checkout, "page.HTML"), "<p>hi</p>");
  await fs.writeFile(path.join(checkout, "notes.txt"), "text");
  await fs.writeFile(path.join(root, "secret.pdf"), "%PDF-1.4\n");
  await fs.symlink(
    path.join(root, "secret.pdf"),
    path.join(checkout, "linked.pdf")
  );
  await fs.mkdir(path.join(checkout, "folder.pdf"));
  worktree = path.join(root, "wt");
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, "wt.pdf"), "%PDF-1.4\n");
  artifacts = path.join(root, "artifacts");
  await fs.mkdir(artifacts);
  await fs.mkdir(path.join(root, "other"));
  await fs.writeFile(path.join(artifacts, "out.pdf"), "%PDF-1.4\n");
  await fs.writeFile(path.join(root, "other", "x.pdf"), "%PDF-1.4\n");
});

/** ServiceHost's own derivation, over a real CheckoutService. */
const previewRoots = async (): Promise<(key: ConversationKey) => string[]> => {
  const { ServiceHost } = await import("../../service-host");
  const checkouts = new CheckoutService({
    workspace: (id) =>
      id === "workspace-one"
        ? ({
            id,
            label: "one",
            status: "active",
            path: checkout,
          } as WorkspaceListItem)
        : null,
    session: (id) =>
      id === "chat-one" || id === "chat-wt"
        ? ({
            id,
            workspaceId: "workspace-one",
            worktreeId: id === "chat-wt" ? "wt" : null,
            worktreePath: id === "chat-wt" ? worktree : null,
          } as AgentSessionListItem)
        : null,
    git: new GitService(),
    files: new FileTreeService(),
    search: async () => ({ items: [] }),
    trash: async () => undefined,
    watch: null,
    pollMs: null,
  });
  const artifact = (
    workspaceId: string,
    location: string,
    kind: SessionArtifact["kind"] = "file"
  ): SessionArtifact =>
    ({ workspaceId, sessionId: "chat-one", kind, location }) as SessionArtifact;
  const host = {
    checkouts,
    sessionArtifactsService: {
      list: () => [
        artifact("workspace-one", path.join(artifacts, "out.pdf")),
        artifact("workspace-two", path.join(root, "other", "x.pdf")),
        artifact("workspace-one", "https://example.com/", "link"),
      ],
    },
  };
  return (key) =>
    ServiceHost.prototype.localPreviewRoots.call(host as never, key);
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
  await fs.rm(root, { recursive: true, force: true });
});

const connect = async (mainRendererId: number | null = 1) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const localPreviewRoots = await previewRoots();
  const materializeFile = vi.fn(async (request: object) => ({
    lease: { conversationKey: "k", resourceId: "r", generation: 1 },
    request,
  }));
  const connection = connectInProcess(
    fakeDeps({
      serviceHost: { localPreviewRoots },
      browserRuntime: { materializeFile },
      windows: { mainRendererId: () => mainRendererId },
    })
  );
  closers.push(() => {
    connection.closeClient();
    connection.closeServer();
  });
  return { client: connection.client, materializeFile };
};

const conversationKey = sessionConversationKey("workspace-one", "chat-one");
const request = (filePath: string) => ({
  conversationKey,
  resourceId: "preview:report",
  filePath,
  hostRoot: checkout,
});

describe("browser.runtime.materializeFile (R4-T33)", () => {
  it("a pdf or html file inside the root reaches the runtime as real paths", async () => {
    const { client, materializeFile } = await connect();
    await client.browser.runtime.materializeFile(request("docs/report.pdf"));
    await client.browser.runtime.materializeFile(
      request(path.join(checkout, "page.HTML"))
    );
    expect(materializeFile.mock.calls.map(([call]) => call)).toEqual([
      {
        conversationKey,
        resourceId: "preview:report",
        file: path.join(checkout, "docs", "report.pdf"),
        root: checkout,
      },
      {
        conversationKey,
        resourceId: "preview:report",
        file: path.join(checkout, "page.HTML"),
        root: checkout,
      },
    ]);
  });

  it("refuses what the guard refuses, and never reaches the runtime", async () => {
    const { client, materializeFile } = await connect();
    const cases: Array<[string, object]> = [
      [
        "../secret.pdf",
        { code: "FORBIDDEN", data: { reason: "outside-root" } },
      ],
      ["linked.pdf", { code: "FORBIDDEN", data: { reason: "outside-root" } }],
      [
        "notes.txt",
        { code: "FORBIDDEN", data: { reason: "unsupported-type" } },
      ],
      ["missing.pdf", { code: "NOT_FOUND", data: { entity: "file" } }],
      ["folder.pdf", { code: "CONFLICT", data: { reason: "not-a-file" } }],
    ];
    for (const [filePath, error] of cases)
      await expect(
        client.browser.runtime.materializeFile(request(filePath))
      ).rejects.toMatchObject(error);
    expect(materializeFile).not.toHaveBeenCalled();
  });

  it("a root main did not derive for the conversation is refused", async () => {
    const { client, materializeFile } = await connect();
    const wtKey = sessionConversationKey("workspace-one", "chat-wt");
    const refused: Array<[ConversationKey, string, string]> = [
      [conversationKey, "/", path.join(root, "secret.pdf")],
      [conversationKey, root, "secret.pdf"],
      // A worktree session may not name the primary checkout.
      [wtKey, checkout, "docs/report.pdf"],
      // Another workspace's artifact folder.
      [conversationKey, path.join(root, "other"), "x.pdf"],
      [conversationKey, path.join(root, "missing"), "x.pdf"],
    ];
    for (const [key, hostRoot, filePath] of refused)
      await expect(
        client.browser.runtime.materializeFile({
          conversationKey: key,
          resourceId: "preview:report",
          filePath,
          hostRoot,
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "root-not-allowed" },
      });
    expect(materializeFile).not.toHaveBeenCalled();

    const allowed: Array<[ConversationKey, string, string]> = [
      [wtKey, worktree, "wt.pdf"],
      [conversationKey, path.join(checkout, "docs"), "report.pdf"],
      [conversationKey, artifacts, "out.pdf"],
      [draftConversationKey("workspace-one"), checkout, "docs/report.pdf"],
    ];
    for (const [key, hostRoot, filePath] of allowed)
      await client.browser.runtime.materializeFile({
        conversationKey: key,
        resourceId: "preview:report",
        filePath,
        hostRoot,
      });
    expect(materializeFile).toHaveBeenCalledTimes(allowed.length);
  }, 30_000);

  it("is restricted to the main renderer", async () => {
    const { client, materializeFile } = await connect(99);
    await expect(
      client.browser.runtime.materializeFile(request("docs/report.pdf"))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(materializeFile).not.toHaveBeenCalled();
  });
});
