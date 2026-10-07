import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

import type { AppClient } from "#renderer/data/transport/types";
import serverFixtures from "#renderer/features/shell/connect/fixtures/bootstrap-server.json";
import { resolveBrowserHost } from "#renderer/features/shell/connect/services";
import { initI18n } from "#renderer/lib/i18n";

import { pickHostFolder, uploadFiles } from "./files";
beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  await initI18n();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll("dialog").forEach((el) => el.remove());
});
const directory = (name: string) => ({
  kind: "directory",
  name,
  absolutePath: `/root/${name}`,
});
const clientFor = () => ({
  db: {
    workspaces: {
      snapshot: async () => ({ rows: [{ isActive: true, path: "/root" }] }),
    },
  },
  files: {
    treeRoot: async () => ({ fileTree: [directory("empty")] }),
    treeChildren: vi.fn().mockResolvedValue([]),
  },
});
it("selects the initial root, browses an empty directory, and returns up/root", async () => {
  const client = clientFor();
  const picked = pickHostFolder(client as unknown as AppClient);
  await screen.findByText("empty");
  fireEvent.click(screen.getByText("empty"));
  await waitFor(() => expect(screen.getByText("/root/empty")).toBeDefined());
  fireEvent.click(screen.getByText("Up"));
  await waitFor(() => expect(screen.getByText("/root")).toBeDefined());
  fireEvent.click(screen.getByText("Open folder"));
  expect(await picked).toBe("/root");
  const another = pickHostFolder(client as unknown as AppClient);
  await screen.findByText("empty");
  fireEvent.click(screen.getByText("empty"));
  await screen.findByText("/root/empty");
  fireEvent.click(screen.getByText("Open folder"));
  expect(await another).toBe("/root/empty");
});
it("ignores an old directory response after root navigation", async () => {
  const client = clientFor();
  let stale!: (nodes: unknown[]) => void;
  client.files.treeChildren
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stale = resolve;
        })
    )
    .mockResolvedValue([]);
  const picked = pickHostFolder(client as unknown as AppClient);
  await screen.findByText("empty");
  fireEvent.click(screen.getByText("empty"));
  fireEvent.click(screen.getByText("Root"));
  await screen.findByText("/root");
  stale([directory("stale")]);
  await Promise.resolve();
  await Promise.resolve();
  expect(screen.queryByText("stale")).toBeNull();
  fireEvent.click(screen.getByText("Open folder"));
  expect(await picked).toBe("/root");
});
it("refreshes old upload credentials while leaving the RPC URL intact and retries auth once", async () => {
  vi.useFakeTimers();
  const token = btoa(JSON.stringify({ o: "owner" })) + ".signature";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          deploymentConversationId: "conversation",
          previewHost: null,
        },
      })
    )
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          ...serverFixtures.find(
            (fixture) => fixture.result.status === "ready"
          )!.result,
          token,
        },
      })
    )
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        owner: "owner",
        contractVersion: CONTRACT_VERSION,
        version: serverFixtures.find(
          (fixture) => fixture.result.status === "ready"
        )!.result.version,
      })
    );
  vi.stubGlobal("fetch", fetch);
  const host = await resolveBrowserHost(() => {});
  const url = host.url;
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  fetch
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          ...serverFixtures.find(
            (fixture) => fixture.result.status === "ready"
          )!.result,
          token: "fresh.token",
        },
      })
    )
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          ...serverFixtures.find(
            (fixture) => fixture.result.status === "ready"
          )!.result,
          token: "retry.token",
        },
      })
    )
    .mockResolvedValueOnce(
      Response.json({ success: true, dir: "/root", paths: ["/root/upload"] })
    );
  expect(
    await uploadFiles([new File(["content"], "test.txt")], {
      workspaceId: "workspace",
      sessionId: "session",
    })
  ).toEqual(["/root/upload"]);
  expect(host.url).toBe(url);
  const uploads = fetch.mock.calls.filter(([url]) =>
    String(url).includes("/upload?")
  );
  const { hostBase } = serverFixtures.find(
    (fixture) => fixture.result.status === "ready"
  )!.result;
  expect(uploads.map(([url]) => url)).toEqual(
    Array(2).fill(
      `${location.origin}${hostBase}/upload?workspaceId=workspace&sessionId=session`
    )
  );
  expect(uploads.map(([, options]) => options)).toEqual([
    expect.objectContaining({
      credentials: "include",
      headers: { Authorization: "Bearer fresh.token" },
    }),
    expect.objectContaining({
      credentials: "include",
      headers: { Authorization: "Bearer retry.token" },
    }),
  ]);
});
