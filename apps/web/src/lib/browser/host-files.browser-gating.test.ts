import { createServer } from "node:http";

import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  awaitWebSocketOpen,
  createWebSocketTransport,
} from "#renderer/data/transport/websocket";
import { resolveBrowserHost } from "#renderer/features/shell/connect/services";
import { configureVoice, fetchWhisperModel } from "#renderer/lib/voice/whisper";

import { viewHostFile } from "./files";
import { browserFileCall, hostFiles } from "./host-files";

const preview = "https://pod.preview.apps.abacus.ai";
const file = { filePath: "/workspace/sample.txt", hostRoot: "/workspace" };
const originalFetch = globalThis.fetch;
let server: ReturnType<typeof createServer>;
let requests: { query: URLSearchParams; token: string | undefined }[];
let statuses: number[];
let files: Map<string, Uint8Array | string>;
let bootstrapCount: number;

beforeEach(async () => {
  requests = [];
  statuses = [];
  files = new Map([[file.filePath, "transcript ".repeat(120_000)]]);
  bootstrapCount = 0;
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push({
      query: url.searchParams,
      token: request.headers.authorization,
    });
    const status = statuses.shift() ?? 200;
    response.writeHead(status, { "content-type": "application/octet-stream" });
    response.end(
      status === 200
        ? files.get(url.searchParams.get("path") ?? "model")
        : "forbidden"
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${preview}/files?`))
        return originalFetch(
          url.replace(preview, `http://127.0.0.1:${address.port}`),
          init
        );
      if (url === `${preview}/healthz`)
        return Response.json({
          ok: true,
          owner: "owner",
          contractVersion: CONTRACT_VERSION,
        });
      if (url === "/api/_getOrCreateAbacusBotHost")
        return Response.json({
          success: true,
          result: {
            deploymentConversationId: "conversation",
            previewHost: new URL(preview).host,
          },
        });
      if (url === "/api/_bootstrapAbacusBotHost") {
        bootstrapCount++;
        return Response.json({
          success: true,
          result: {
            status: "ready",
            previewHost: new URL(preview).host,
            token: `${btoa(JSON.stringify({ o: "owner", n: bootstrapCount }))}.signature`,
            version: null,
            detail: null,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    })
  );
  await resolveBrowserHost(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

const transport = () =>
  createWebSocketTransport("wss://unused.invalid/rpc", {
    WebSocket: class {
      readyState = 1;
      addEventListener() {}
      removeEventListener() {}
      send() {
        throw new Error("File readers must not send RPC frames");
      }
      close() {}
    } as unknown as typeof WebSocket,
  });

it("reads large transcripts, snapshots and diff/preview text through the browser client and query utilities", async () => {
  const host = transport();
  const text = await host.client.files.readText(file);
  expect(text.content.length).toBeGreaterThan(1024 * 1024);
  expect(text.truncated).toBe(false);
  const query = host.orpc.files.readText.queryOptions({
    input: { ...file, maxBytes: 10 },
  });
  expect(
    await query.queryFn!({ signal: new AbortController().signal } as never)
  ).toMatchObject({ content: "transcript", truncated: true });
  expect(requests[0]!.query.get("path")).toBe(file.filePath);
  expect(requests[0]!.query.get("hostRoot")).toBe(file.hostRoot);
  expect(requests[0]!.token).toMatch(/^Bearer /);
  host.close();
});
it("reads large images for every preview and thumbnail consumer with the correct MIME", async () => {
  const image = { ...file, filePath: "/workspace/photo.png" };
  files.set(image.filePath, new Uint8Array(2 * 1024 * 1024).fill(7));
  const host = transport();
  const result = await host.client.files.readImageAsDataUrl(image);
  expect(result.dataUrl).toMatch(/^data:image\/png;base64,BwcH/);
  expect(result.sizeBytes).toBe(2 * 1024 * 1024);
  expect(result.mimeType).toBe("image/png");
  host.close();
});
it("parses downloaded deck bytes with embedded media and slide relationships", async () => {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    '<p:presentation><p:sldSz cx="100" cy="200"/></p:presentation>'
  );
  zip.file(
    "ppt/slides/slide1.xml",
    '<p:sld><p:cSld name="Sample"><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="1" name="Photo"/></p:nvPicPr><p:blipFill><a:blip r:embed="r1"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>'
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    '<Relationships><Relationship Id="r1" Target="../media/photo.png"/></Relationships>'
  );
  zip.file("ppt/media/photo.png", new Uint8Array(2 * 1024 * 1024).fill(7));
  const input = { ...file, filePath: "/workspace/deck.pptx" };
  files.set(
    input.filePath,
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  );
  const host = transport();
  const result = await host.client.files.readPptx(input);
  expect(result.deck).toMatchObject({ widthEmu: 100, heightEmu: 200 });
  expect(result.deck.slides).toHaveLength(1);
  expect(JSON.stringify(result.deck)).toContain("data:image/png;base64,BwcH");
  host.close();
});
it("Whisper downloads model files through HTTP without calling the denied procedure", async () => {
  files.set("model", new Uint8Array(2 * 1024 * 1024).fill(8));
  const host = transport();
  configureVoice(host);
  const url =
    "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/model.onnx";
  const result = await fetchWhisperModel(url);
  expect((await result.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
  expect(requests[0]!.query.get("whisperUrl")).toBe(url);
  host.close();
});
it.each([401, 403])(
  "refreshes stale credentials and retries one %s with a fresh token",
  async (status) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 9 * 60_000);
    statuses.push(status, 200);
    expect((await hostFiles.text(file)).length).toBeGreaterThan(1024 * 1024);
    expect(bootstrapCount).toBe(3);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.token).not.toBe(requests[1]!.token);
  }
);
it("does not retry a repeated auth failure or an unrelated HTTP error", async () => {
  statuses.push(403, 403);
  await expect(hostFiles.blob(file)).rejects.toThrow("403");
  expect(requests).toHaveLength(2);
  statuses.push(404);
  await expect(hostFiles.arrayBuffer(file)).rejects.toThrow("404");
  expect(requests).toHaveLength(3);
});
it("retries PAYLOAD_TOO_LARGE through its concrete export alternative and leaves RPC usable", async () => {
  files.set(
    "/workspace/export.json",
    JSON.stringify({ rows: ["snapshot"], content: "transcript" })
  );
  const failure = {
    code: "PAYLOAD_TOO_LARGE",
    data: {
      alternative: `/files?${new URLSearchParams({ hostRoot: file.hostRoot, path: "/workspace/export.json" })}`,
    },
  };
  const next = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ ok: true });
  expect(
    await browserFileCall(["db", "sessions", "snapshot"], {}, next)
  ).toEqual({ rows: ["snapshot"], content: "transcript" });
  expect(await browserFileCall(["system", "info"], {}, next)).toEqual({
    ok: true,
  });
  failure.data.alternative = "/files?hostRoot=<workspace>&path=<export-file>";
  await expect(
    browserFileCall(["db", "sessions", "snapshot"], {}, async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  expect(requests).toHaveLength(1);
});

it("renders downloaded images and text in the host-file dialog", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  const host = transport();
  const client = {
    files: host.client.files,
    system: { info: async () => ({ paths: { home: file.hostRoot } }) },
  } as unknown as typeof host.client;
  files.set("/workspace/photo.png", new Uint8Array([7, 7, 7]));
  await viewHostFile(client, "/workspace/photo.png");
  expect(document.querySelector("dialog img")?.getAttribute("src")).toBe(
    "data:image/png;base64,BwcH"
  );
  document.querySelector("dialog")?.remove();
  await viewHostFile(client, file.filePath);
  expect(
    document.querySelector("dialog pre")?.textContent?.length
  ).toBeGreaterThan(1024 * 1024);
  document.querySelector("dialog")?.remove();
  host.close();
});
it("returns Blob data with fresh credentials without a bootstrap refresh", async () => {
  const blob = await hostFiles.blob(file);
  expect(blob.size).toBeGreaterThan(1024 * 1024);
  expect(bootstrapCount).toBe(1);
});

it("keeps a real RPC socket open after retrying an oversized snapshot over HTTP", async () => {
  const [
    { contract },
    { implement, ORPCError },
    { RPCHandler },
    { WebSocketServer, WebSocket: NodeSocket },
  ] = await Promise.all([
    import("@abacus-ai/contract/contract"),
    import("@orpc/server"),
    import("@orpc/server/ws"),
    import("ws"),
  ]);
  const snapshot = { epoch: "sample", seq: 1, rows: [] };
  files.set("/workspace/snapshot.json", JSON.stringify(snapshot));
  const impl = implement(contract);
  const handler = new RPCHandler({
    db: {
      sessions: {
        snapshot: impl.db.sessions.snapshot.handler(() => {
          throw new ORPCError("PAYLOAD_TOO_LARGE", {
            status: 413,
            data: {
              alternative: `/files?${new URLSearchParams({ hostRoot: file.hostRoot, path: "/workspace/snapshot.json" })}`,
            },
          });
        }),
      },
    },
    files: { treeChildren: impl.files.treeChildren.handler(() => []) },
  });
  const rpc = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => rpc.once("listening", resolve));
  rpc.on("connection", (socket) => handler.upgrade(socket as never));
  const url = `ws://127.0.0.1:${(rpc.address() as { port: number }).port}`;
  const socket = new NodeSocket(url) as unknown as WebSocket;
  await awaitWebSocketOpen(socket);
  const host = createWebSocketTransport(url, {
    flowControl: false,
    WebSocket: class {
      constructor() {
        return socket;
      }
    } as unknown as typeof WebSocket,
  });
  try {
    expect(await host.client.db.sessions.snapshot({})).toEqual(snapshot);
    expect(host.state).toBe("open");
    expect(
      await host.client.files.treeChildren({ directoryPath: file.hostRoot })
    ).toEqual([]);
    expect(requests).toHaveLength(1);
  } finally {
    host.close();
    rpc.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => rpc.close(() => resolve()));
  }
});
