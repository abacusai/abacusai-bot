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
  await import("./host-dialog");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll("dialog").forEach((el) => el.remove());
});
const directory = (name: string) => ({
  kind: "directory",
  name,
  path: `/root/${name}`,
  sizeBytes: 0,
});
const clientFor = () => ({
  files: {
    listDirectory: vi.fn(async ({ path }: { path?: string }) => ({
      root: "/root",
      path: path ?? "/root",
      entries: path && path !== "/root" ? [] : [directory("empty")],
    })),
    mkdir: vi.fn(),
  },
});
it("renders an app dialog, clamps the root, opens an empty folder and goes up", async () => {
  const client = clientFor();
  const picked = pickHostFolder(client as unknown as AppClient);
  const dialog = await screen.findByRole("dialog", { name: "Choose a folder" });
  expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
  await screen.findByText("empty");
  expect(
    (
      screen.getByRole("button", {
        name: "Use this folder",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Up" }) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.click(screen.getByText("empty"));
  await screen.findByText("/root/empty");
  await screen.findByText("This folder is empty.");
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  expect(await picked).toBe("/root/empty");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("shows listing errors and retries without dismissing the picker", async () => {
  const client = clientFor();
  client.files.listDirectory.mockRejectedValueOnce(new Error("offline"));
  const picked = pickHostFolder(client as unknown as AppClient);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("empty");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await picked).toBeNull();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("navigates rows with arrows, Enter and Backspace and filters names", async () => {
  const client = clientFor();
  const picked = pickHostFolder(client as unknown as AppClient);
  await screen.findByText("empty");
  const filter = screen.getByRole("textbox", { name: "Filter names…" });
  fireEvent.change(filter, { target: { value: "missing" } });
  expect(screen.queryByRole("button", { name: "empty" })).toBeNull();
  fireEvent.change(filter, { target: { value: "" } });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toBe("empty");
  fireEvent.click(document.activeElement!);
  await screen.findByText("/root/empty");
  fireEvent.keyDown(screen.getByRole("group", { name: "Folders and files" }), {
    key: "Backspace",
  });
  await screen.findByText("/root");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await picked).toBeNull();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
