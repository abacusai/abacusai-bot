/**
 * R4-T33, `browser.runtime.materializeFile`'s guard (spec 04 §12.8, §26.4
 * f): the readers' containment (symlinks resolved first), a regular file, a
 * pdf/html/htm type, and the main renderer only. What reaches the runtime
 * are real paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionConversationKey } from "#shared/conversation-scope";

import { connectInProcess, fakeDeps } from "../testing";

let root = "";
let checkout = "";
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
  await fs.rm(root, { recursive: true, force: true });
});

const connect = (mainRendererId: number | null = 1) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const materializeFile = vi.fn(async (request: object) => ({
    lease: { conversationKey: "k", resourceId: "r", generation: 1 },
    request,
  }));
  const connection = connectInProcess(
    fakeDeps({
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
    const { client, materializeFile } = connect();
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
    const { client, materializeFile } = connect();
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

  it("is restricted to the main renderer", async () => {
    const { client, materializeFile } = connect(99);
    await expect(
      client.browser.runtime.materializeFile(request("docs/report.pdf"))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(materializeFile).not.toHaveBeenCalled();
  });
});
