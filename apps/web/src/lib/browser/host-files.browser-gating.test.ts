import { createServer } from "node:http";

import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import type { ArtifactRow } from "@abacus-ai/contract/contract/rows";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  awaitWebSocketOpen,
  createWebSocketTransport,
} from "#renderer/data/transport/websocket";
import { openArtifact } from "#renderer/features/artifacts/data";
import { resolveBrowserHost } from "#renderer/features/shell/connect/services";
import { configureVoice, fetchWhisperModel } from "#renderer/lib/voice/whisper";

import { viewHostFile } from "./files";
import { hostFiles } from "./host-files";

// The same-origin path the server proxies to the host.
const hostBase = "/api/botHost/1c0d9e2f7a";
const preview = location.origin + hostBase;
const file = { filePath: "/workspace/sample.txt", hostRoot: "/workspace" };
const originalFetch = globalThis.fetch;
let server: ReturnType<typeof createServer>;
let requests: {
  query: URLSearchParams;
  token: string | undefined;
  range: string | undefined;
}[];
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
      range: request.headers.range,
    });
    const body = files.get(url.searchParams.get("path") ?? "model");
    const status = statuses.shift() ?? (body == null ? 404 : 200);
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: status === 404 ? "not-found" : "forbidden" })
      );
      return;
    }
    const bytes = Buffer.from(body!);
    if (request.headers.range === "bytes=0-0") {
      response.writeHead(bytes.length ? 206 : 416, {
        "content-range": bytes.length
          ? `bytes 0-0/${bytes.length}`
          : "bytes */0",
        "content-length": bytes.length ? 1 : 0,
      });
      response.end(bytes.subarray(0, 1));
      return;
    }
    const maxBytes = url.searchParams.get("maxBytes");
    const sent = maxBytes == null ? bytes : bytes.subarray(0, Number(maxBytes));
    response.writeHead(status, {
      "content-type": "application/octet-stream",
      "content-length": sent.length,
    });
    response.end(sent);
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
            hostBase,
            previewHost: null,
          },
        });
      if (url === "/api/_bootstrapAbacusBotHost") {
        bootstrapCount++;
        return Response.json({
          success: true,
          result: {
            status: "ready",
            hostBase,
            previewHost: null,
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
  expect(text.content.length).toBe(524288);
  expect(text.sizeBytes).toBe(524289);
  expect(text.truncated).toBe(true);
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
it.each([10, 11])(
  "detects truncation of %s text bytes without X-File-Size",
  async (size) => {
    files.set(file.filePath, "a".repeat(size));
    const host = transport();
    expect(await host.client.files.readText({ ...file, maxBytes: 10 })).toEqual(
      {
        content: "a".repeat(Math.min(size, 10)),
        sizeBytes: Math.min(size, 11),
        truncated: size > 10,
      }
    );
    expect(requests[0]!.query.get("maxBytes")).toBe("11");
    host.close();
  }
);
it.each([0, 1, 10000])(
  "probes %s file bytes using Content-Range",
  async (size) => {
    files.set(file.filePath, "a".repeat(size));
    const host = transport();
    expect(await host.client.files.readText({ ...file, maxBytes: 1 })).toEqual({
      content: size ? "a" : "",
      sizeBytes: size,
      truncated: size > 1,
    });
    expect(requests[0]!.range).toBe("bytes=0-0");
    expect(requests[0]!.query.has("maxBytes")).toBe(false);
    host.close();
  }
);
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
it("refuses a deck whose parts inflate past the cap", async () => {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", "<p:presentation/>");
  // A few hundred kilobytes on the wire, 129 MiB once inflated.
  zip.file("ppt/slides/slide1.xml", new Uint8Array(129 * 1024 * 1024));
  const input = { ...file, filePath: "/workspace/bomb.pptx" };
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
  });
  expect(bytes.byteLength).toBeLessThan(2 * 1024 * 1024);
  files.set(input.filePath, bytes);
  const host = transport();
  await expect(host.client.files.readPptx(input)).rejects.toMatchObject({
    data: { reason: "too-large" },
  });
  host.close();
}, 60_000);
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
  await expect(hostFiles.blob(file)).rejects.toMatchObject({
    code: "FORBIDDEN",
    defined: true,
    data: { reason: "forbidden" },
  });
  expect(requests).toHaveLength(2);
  statuses.push(404);
  await expect(hostFiles.arrayBuffer(file)).rejects.toMatchObject({
    code: "NOT_FOUND",
    defined: true,
    data: { entity: "file", id: file.filePath },
  });
  expect(requests).toHaveLength(3);
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
  expect(document.querySelector("dialog pre")?.textContent?.length).toBe(
    524288
  );
  document.querySelector("dialog")?.remove();
  host.close();
});
it("keeps a real RPC socket open after a real host oversized snapshot error", async () => {
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

  const impl = implement(contract);
  const handler = new RPCHandler({
    db: {
      sessions: {
        snapshot: impl.db.sessions.snapshot.handler(() => {
          throw new ORPCError("PAYLOAD_TOO_LARGE", {
            status: 413,
            data: {
              limit: 1024 * 1024,
              alternative: "/files?hostRoot=<workspace>&path=<export-file>",
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
  const host = createWebSocketTransport(socket, {
    flowControl: false,
  });
  try {
    await expect(host.client.db.sessions.snapshot({})).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      data: {
        limit: 1024 * 1024,
        alternative: "/files?hostRoot=<workspace>&path=<export-file>",
      },
    });
    expect(host.state).toBe("open");
    expect(
      await host.client.files.treeChildren({ directoryPath: file.hostRoot })
    ).toEqual([]);
    expect(requests).toHaveLength(0);
  } finally {
    host.close();
    rpc.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => rpc.close(() => resolve()));
  }
});

it.each(["pdf", "png", "pptx"])(
  "opens %s artifacts through HTTP readers and the browser dialog",
  async (extension) => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:pdf");
        static override revokeObjectURL = vi.fn();
      }
    );
    const path = `/workspace/report.${extension}`;
    if (extension === "pptx") {
      const zip = new JSZip();
      zip.file(
        "ppt/presentation.xml",
        '<p:presentation><p:sldSz cx="100" cy="200"/></p:presentation>'
      );
      files.set(path, await zip.generateAsync({ type: "uint8array" }));
    } else files.set(path, new Uint8Array([0, 7, 7]));
    const host = transport();
    const client = {
      files: host.client.files,
      system: { info: async () => ({ paths: { home: file.hostRoot } }) },
    } as unknown as typeof host.client;
    try {
      expect(
        await openArtifact({ client }, {
          kind: "file",
          location: path,
        } as ArtifactRow)
      ).toBe("opened");
      expect(requests[0]!.range).toBe("bytes=0-0");
      expect(requests[0]!.query.has("maxBytes")).toBe(false);
      expect(
        document.querySelector(
          `dialog ${extension === "pdf" ? "iframe" : extension === "png" ? "img" : "pre"}`
        )
      ).not.toBeNull();
    } finally {
      document.querySelector("dialog")?.remove();
      host.close();
    }
  }
);
it("reports a missing artifact through the HTTP probe without opening a dialog", async () => {
  const host = transport();
  expect(
    await openArtifact(host, {
      kind: "file",
      location: "/workspace/missing.pdf",
    } as ArtifactRow)
  ).toBe("missing");
  expect(requests).toHaveLength(1);
  expect(document.querySelector("dialog")).toBeNull();
  host.close();
});
it.each([
  [404, { error: "outside-root" }, "FORBIDDEN", "outside-root"],
  [409, { error: "conflict", reason: "not-a-file" }, "CONFLICT", "not-a-file"],
  [404, { error: "not-a-file" }, "CONFLICT", "not-a-file"],
  [
    403,
    { error: "forbidden", reason: "outside-root" },
    "FORBIDDEN",
    "outside-root",
  ],
])(
  "maps host file errors (%s, %j) to defined RPC errors",
  async (status, body, code, reason) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: status as number }))
    );
    await expect(hostFiles.text(file)).rejects.toMatchObject({
      code,
      defined: true,
      data: { reason },
    });
  }
);
it("bounds the existence probe and cancels the stream", async () => {
  let delivered = 0;
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              delivered++;
              controller.enqueue(new Uint8Array(1024).fill(65));
            },
            cancel,
          }),
          {
            status: 206,
            headers: {
              "content-length": "1",
              "content-range": "bytes 0-0/1000000000",
            },
          }
        )
    )
  );
  const host = transport();
  expect(await host.client.files.readText({ ...file, maxBytes: 1 })).toEqual({
    content: "A",
    sizeBytes: 1000000000,
    truncated: true,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(delivered).toBeLessThanOrEqual(2);
  host.close();
});
it.each(["readImageAsDataUrl", "readPptx"] as const)(
  "caps %s before reading a declared oversized body",
  async (procedure) => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(61 * 1024 * 1024) },
          })
      )
    );
    const host = transport();
    await expect(
      host.client.files[procedure]({
        ...file,
        filePath: "/workspace/image.png",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "too-large" },
    });
    expect(cancel).toHaveBeenCalledOnce();
    host.close();
  }
);
it("rejects unsupported image extensions before fetching", async () => {
  const host = transport();
  await expect(
    host.client.files.readImageAsDataUrl(file)
  ).rejects.toMatchObject({
    code: "CONFLICT",
    data: { reason: "unsupported-extension" },
  });
  expect(requests).toHaveLength(0);
  host.close();
});
it("concurrent delayed 403s use a single forced refresh", async () => {
  const fetch = globalThis.fetch;
  const stale = (
    await import("#renderer/features/shell/connect/services")
  ).browserConnection().token;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (
        String(input).includes("/files?") &&
        new Headers(init?.headers).get("Authorization") === `Bearer ${stale}`
      ) {
        if (++oldRequests === 2) await delayed;
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return fetch(input, init);
    })
  );
  const first = hostFiles.text(file);
  const second = hostFiles.text(file);
  await first;
  release();
  await second;
  expect(bootstrapCount).toBe(2);
});

it("reveals a directory artifact from the host not-a-file response", async () => {
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) =>
      String(input).includes("/files?")
        ? Response.json({ error: "not-a-file" }, { status: 404 })
        : fetch(input, init)
    )
  );
  const host = transport();
  expect(
    await openArtifact(host, {
      kind: "file",
      location: "/workspace/folder",
    } as ArtifactRow)
  ).toBe("directory");
  expect(document.querySelector("dialog")).toBeNull();
  host.close();
});
it.each(["readImageAsDataUrl", "readPptx"] as const)(
  "caps %s streams without Content-Length",
  async (procedure) => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    let chunks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                chunks++;
                controller.enqueue(chunk);
              },
              cancel,
            })
          )
      )
    );
    const host = transport();
    await expect(
      host.client.files[procedure]({
        ...file,
        filePath: "/workspace/image.png",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "too-large" },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(procedure === "readPptx" ? 62 : 10);
    host.close();
  }
);
it("does not inflate deck audio or video entries", async () => {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    '<p:presentation><p:sldSz cx="100" cy="200"/></p:presentation>'
  );
  zip.file("ppt/media/movie.mp4", new Uint8Array([1, 2]));
  zip.file("ppt/media/audio.mp3", new Uint8Array([1, 2]));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const archive = await JSZip.loadAsync(bytes);
  const movie = vi.spyOn(archive.files["ppt/media/movie.mp4"]!, "async");
  const audio = vi.spyOn(archive.files["ppt/media/audio.mp3"]!, "async");
  vi.spyOn(JSZip, "loadAsync").mockResolvedValue(archive);
  files.set("/workspace/deck.pptx", bytes);
  const host = transport();
  await host.client.files.readPptx({
    ...file,
    filePath: "/workspace/deck.pptx",
  });
  expect(movie).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
  host.close();
});
