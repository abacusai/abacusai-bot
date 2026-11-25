/**
 * `browser.runtime.materializeFile`'s guard (spec 04 §12.8): main picks the
 * root from the chat (ServiceHost's real `previewSources`): its checkout,
 * the folders added to it, the folders of files it made, a file attached to
 * it. Then the readers' containment, a regular file, a pdf/html/htm type,
 * and the main renderer only. What reaches the runtime are real paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentSessionListItem,
  SessionArtifact,
  WorkspaceListItem,
} from "@abacus-ai/contract/contracts";
import {
  draftConversationKey,
  sessionConversationKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewSources } from "../../services/browser/local-preview-file";
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
let added = "";
let loose = "";
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
  added = path.join(root, "project");
  await fs.mkdir(path.join(added, "site"), { recursive: true });
  await fs.writeFile(path.join(added, "site", "index.html"), "<p>made</p>");
  loose = path.join(root, "desktop");
  await fs.mkdir(loose);
  await fs.writeFile(path.join(loose, "given.pdf"), "%PDF-1.4\n");
  await fs.writeFile(path.join(loose, "beside.pdf"), "%PDF-1.4\n");
});

/** ServiceHost's own derivation, over a real CheckoutService. */
const previewSources = async (): Promise<
  (key: ConversationKey) => PreviewSources
> => {
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
      id === "chat-one" || id === "chat-wt" || id === "chat-two"
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
    sessionId: string,
    location: string,
    kind: SessionArtifact["kind"] = "file"
  ): SessionArtifact =>
    ({
      workspaceId: "workspace-one",
      sessionId,
      kind,
      location,
    }) as SessionArtifact;
  const host = {
    checkouts,
    sessionArtifactsService: {
      list: () => [
        artifact("chat-one", path.join(artifacts, "out.pdf")),
        // The same Auto workspace, another chat: not this chat's to show.
        artifact("chat-two", path.join(root, "other", "x.pdf")),
        artifact("chat-one", "https://example.com/", "link"),
      ],
    },
    agentSessionManagerService: {
      folders: (id: string) => (id === "chat-one" ? [added] : []),
      attachedFiles: (id: string) =>
        id === "chat-one" ? [path.join(loose, "given.pdf")] : [],
    },
  };
  return (key) => ServiceHost.prototype.previewSources.call(host as never, key);
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
  await fs.rm(root, { recursive: true, force: true });
});

const connect = async (mainRendererId: number | null = 1) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const sources = await previewSources();
  const materializeFile = vi.fn(async (request: { root?: string }) => ({
    lease: { conversationKey: "k", resourceId: "r", generation: 1 },
    request,
  }));
  const connection = connectInProcess(
    fakeDeps({
      serviceHost: { previewSources: sources },
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
const request = (filePath: string, key: ConversationKey = conversationKey) => ({
  conversationKey: key,
  resourceId: "preview:report",
  filePath,
});

describe("browser.runtime.materializeFile", () => {
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
        { code: "FORBIDDEN", data: { reason: "outside-folders" } },
      ],
      [
        "linked.pdf",
        { code: "FORBIDDEN", data: { reason: "outside-folders" } },
      ],
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

  it("main picks the root: an added folder, a file the chat made, an attached file", async () => {
    const { client, materializeFile } = await connect();
    const wtKey = sessionConversationKey("workspace-one", "chat-wt");
    const shown: Array<[ConversationKey, string, string]> = [
      [wtKey, "wt.pdf", worktree],
      [conversationKey, path.join(added, "site", "index.html"), added],
      [conversationKey, path.join(artifacts, "out.pdf"), artifacts],
      [
        conversationKey,
        path.join(loose, "given.pdf"),
        path.join(loose, "given.pdf"),
      ],
      [draftConversationKey("workspace-one"), "docs/report.pdf", checkout],
    ];
    for (const [key, filePath] of shown)
      await client.browser.runtime.materializeFile(request(filePath, key));
    expect(materializeFile.mock.calls.map(([call]) => call.root)).toEqual(
      shown.map(([, , picked]) => picked)
    );
  });

  it("refuses what is in none of the chat's folders", async () => {
    const { client, materializeFile } = await connect();
    const wtKey = sessionConversationKey("workspace-one", "chat-wt");
    const refused: Array<[ConversationKey, string]> = [
      [conversationKey, path.join(root, "secret.pdf")],
      // A worktree chat does not see the primary checkout.
      [wtKey, path.join(checkout, "docs", "report.pdf")],
      // Another chat's file in the same workspace.
      [conversationKey, path.join(root, "other", "x.pdf")],
      // Beside an attached file: the file alone was given.
      [conversationKey, path.join(loose, "beside.pdf")],
      // Missing outside: refused, not "not found".
      [conversationKey, path.join(root, "missing", "x.pdf")],
      // Added to one chat only.
      [wtKey, path.join(added, "site", "index.html")],
    ];
    for (const [key, filePath] of refused)
      await expect(
        client.browser.runtime.materializeFile(request(filePath, key))
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "outside-folders" },
      });
    expect(materializeFile).not.toHaveBeenCalled();
  }, 30_000);

  it("answers previewRoot with the same root, or the folder to add", async () => {
    const { client } = await connect();
    await expect(
      client.browser.runtime.previewRoot({
        conversationKey,
        filePath: path.join(added, "site", "notes.md"),
      })
    ).resolves.toEqual({ ok: true, root: added });
    await expect(
      client.browser.runtime.previewRoot({
        conversationKey,
        filePath: path.join(loose, "beside.pdf"),
      })
    ).resolves.toEqual({ ok: false, reason: "outside-folders", folder: loose });
  });

  it("is restricted to the main renderer", async () => {
    const { client, materializeFile } = await connect(99);
    await expect(
      client.browser.runtime.materializeFile(request("docs/report.pdf"))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(materializeFile).not.toHaveBeenCalled();
  });
});
