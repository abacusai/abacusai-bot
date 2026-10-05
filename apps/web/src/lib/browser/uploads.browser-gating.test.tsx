import { createServer } from "node:http";

import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import { sessionReady } from "#renderer/features/chat/fixtures/builders";
import { FakeRelay } from "#renderer/features/chat/fixtures/relay";
import {
  inertHostActions,
  hostActionsFor,
} from "#renderer/features/chat/runtime/host-actions";
import { renderRelay } from "#renderer/features/chat/testing";
import { renderApp } from "#renderer/test-support/app-harness";
const host = vi.hoisted(() => ({ base: "", token: "fixture-token" }));
vi.mock("#renderer/features/shell/connect/services", async (original) => ({
  ...(await original<
    typeof import("#renderer/features/shell/connect/services")
  >()),
  refreshUploadToken: async () => host,
}));
vi.mock("#renderer/lib/voice/use-dictation", () => ({
  useConnectedDictation: () => ({ supported: false }),
}));
import { uploadFiles } from "./files";
afterEach(() => vi.restoreAllMocks());
it("fake HTTP host requires session/workspace, accepts multipart and returns the host success shape", async () => {
  const queries: URLSearchParams[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    queries.push(url.searchParams);
    expect(request.headers.authorization).toBe("Bearer fixture-token");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const multipart = Buffer.concat(chunks).toString();
    expect(request.headers["content-type"]).toContain("multipart/form-data");
    expect(multipart).toContain('name="files"; filename="test.txt"');
    expect(multipart).toContain("hello");
    const ok =
      url.searchParams.get("workspaceId") === "w" &&
      url.searchParams.get("sessionId") === "s";
    response.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        ok
          ? {
              success: true,
              dir: "/workspace/.temp",
              paths: ["/workspace/.temp/test.txt"],
            }
          : { error: "session-required" }
      )
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nativeFetch = globalThis.fetch;
  // Node fetch cannot encode jsdom FormData. Serialize the browser form at the
  // fixture boundary, then exercise the actual HTTP request/response contract.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const parts = [];
    for (const [key, file] of (init!.body as FormData).entries()) {
      if (typeof file === "string") continue;
      const bytes = await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
      parts.push(
        Buffer.from(
          `--fixture\r\nContent-Disposition: form-data; name="${key}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        Buffer.from(bytes),
        Buffer.from("\r\n")
      );
    }
    parts.push(Buffer.from("--fixture--\r\n"));
    return nativeFetch(url, {
      ...init,
      headers: {
        ...init!.headers,
        "content-type": "multipart/form-data; boundary=fixture",
      },
      body: Buffer.concat(parts),
    });
  });
  try {
    await expect(
      uploadFiles([new File(["hello"], "test.txt")], {
        workspaceId: "w",
        sessionId: "s",
      })
    ).resolves.toEqual(["/workspace/.temp/test.txt"]);
    await expect(
      uploadFiles([new File(["hello"], "test.txt")], {
        workspaceId: "w",
        sessionId: "wrong",
      })
    ).rejects.toThrow("Upload failed (400)");
    await expect(uploadFiles([])).rejects.toThrow("Select a session");
    expect(queries).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("composer catches a rejected upload and renders an actionable error", async () => {
  const relay = new FakeRelay();
  relay.emitAll(sessionReady());
  const context = async () => ({ workspaceId: "w", sessionId: "s" });
  const pick = vi.fn(async () => {
    throw new Error("Upload failed (400). Try again.");
  });
  const view = await renderRelay(
    relay,
    "session",
    { attachmentContext: context },
    {},
    { ...inertHostActions, pickFiles: pick }
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Files or images" })
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Try again"
    );
    expect(pick).toHaveBeenCalledWith(context);
  } finally {
    await view.cleanup();
  }
});
it("native chooser forwards the selected composer's context and removes itself on failure", async () => {
  const actions = hostActionsFor({ client: {} } as Transport);
  const context = vi.fn(async () => ({ workspaceId: "w", sessionId: "s" }));
  const pick = actions.pickFiles(context);
  const input = document.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["content"], "test.txt")],
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 400 })
  );
  fireEvent.change(input);
  await expect(pick).rejects.toThrow("Upload failed (400)");
  expect(context).toHaveBeenCalledOnce();
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("new-session attachments persist the identity before asking the host to upload", async () => {
  const { contract } = await import("@abacus-ai/contract/contract");
  const { implement } = await import("@orpc/server");
  const { MODEL_CATALOG } = await import("@abacus-ai/contract/models");
  const impl = implement(contract);
  const app = await renderApp("/sessions/new", {
    procedures: {
      models: { list: impl.models.list.handler(() => MODEL_CATALOG as never) },
    },
  });
  const { startDraftStore } =
    await import("#renderer/features/sessions/start/start-session");
  try {
    await screen.findByRole("button", { name: "Attach" });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Files or images" })
    );
    const input = document.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [new File(["content"], "test.txt")],
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ success: true, paths: ["/workspace/test.txt"] })
      );
    await act(async () => fireEvent.change(input));
    await screen.findByText("test.txt");
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.searchParams.get("workspaceId")).toBe(
      startDraftStore.state.workspaceId
    );
    expect(url.searchParams.get("sessionId")).toBe(startDraftStore.state.id);
    expect(
      app.collections.sessions.get(startDraftStore.state.id)?.workspaceId
    ).toBe(startDraftStore.state.workspaceId);
    expect(startDraftStore.state.stage).toBe("draft");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
