import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";

import type { AppOperations } from "#main/rpc/deps";
import type { HostedMcpConnect } from "#main/services/mcp/hosted-mcp-connect";
import type { WhisperModelService } from "#main/services/voice/whisper-model-service";
import { openHostFile } from "#main/services/workspace/host-path";

import { authenticate, type HostIdentity } from "./auth";
import type { HostLease } from "./lease";
const json = (response: ServerResponse, status: number, value: unknown) =>
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(value));
/** A form post's body, or null past 4 KiB. */
const readSmallBody = async (
  request: IncomingMessage
): Promise<string | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    // Drained to the end either way, so the response can still be written.
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  }
  return size > 4096 ? null : Buffer.concat(chunks).toString("utf8");
};
export const createHostHttpServer = (
  identity: HostIdentity,
  app: AppOperations,
  lease: HostLease,
  uploadFolder: (workspaceId: string, sessionId: string) => string | null,
  whisper: Pick<WhisperModelService, "prepareFile">,
  mcp: Pick<HostedMcpConnect, "route"> | null = null
) =>
  createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, {
        ok: true,
        version: app.appVersion(),
        contractVersion: CONTRACT_VERSION,
        owner: identity.owner,
        uptime: process.uptime(),
        busy: lease.busy,
        lastActivityAt: lease.lastActivityAt,
      });
      return;
    }
    // MCP connects are top-level navigations, which carry no connect token;
    // HostedMcpConnect admits them (spec 08, D8 exception).
    if (url.pathname.startsWith("/mcp/") && mcp != null) {
      let form: URLSearchParams | undefined;
      if (request.method === "POST") {
        const body = await readSmallBody(request);
        if (body == null) {
          json(response, 413, { error: "too-large" });
          return;
        }
        form = new URLSearchParams(body);
      }
      const answer = await mcp.route(
        {
          method: request.method ?? "GET",
          pathname: url.pathname,
          query: url.searchParams,
          ...(form != null ? { form } : {}),
          headers: request.headers,
        },
        identity.owner
      );
      const headers = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      };
      switch (answer.kind) {
        case "redirect":
          response
            .writeHead(302, { ...headers, location: answer.location })
            .end();
          return;
        case "page":
          response
            .writeHead(answer.status, {
              ...headers,
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
              "x-frame-options": "DENY",
            })
            .end(answer.html);
          return;
        case "refused":
          json(response, 403, { error: "forbidden" });
          return;
        case "missing":
          json(response, 404, { error: "not-found" });
          return;
      }
    }
    const failure = authenticate(request, identity);
    if (failure) {
      console.warn(`[host-auth] ${failure}`);
      json(response, 403, { error: "forbidden" });
      request.resume();
      return;
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/files"
    ) {
      try {
        const whisperUrl = url.searchParams.get("whisperUrl");
        const model = whisperUrl
          ? await whisper.prepareFile(whisperUrl, {
              download: request.method !== "HEAD",
            })
          : null;
        if (model && !model.path) {
          json(
            response,
            model.status,
            model.status === 404
              ? { error: "not-found" }
              : model.status === 403
                ? { error: "forbidden", reason: "invalid-model-url" }
                : { error: "conflict", reason: "model-download-failed" }
          );
          return;
        }
        const file = model?.path
          ? {
              ok: true as const,
              realFile: model.path,
            }
          : await openHostFile(
              url.searchParams.get("path") ?? "",
              url.searchParams.get("hostRoot") ?? ""
            );
        if (file.ok === false) {
          json(
            response,
            file.error === "not-found"
              ? 404
              : file.error === "outside-root"
                ? 403
                : 409,
            file.error === "not-found"
              ? { error: "not-found" }
              : {
                  error:
                    file.error === "outside-root" ? "forbidden" : "conflict",
                  reason: file.error,
                }
          );
          return;
        }
        const handle = await open(file.realFile, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile()) {
            json(response, 409, { error: "conflict", reason: "not-a-file" });
            return;
          }
          const maxBytesQuery = url.searchParams.get("maxBytes");
          const maxBytes =
            maxBytesQuery == null ? info.size : Number(maxBytesQuery);
          if (
            maxBytesQuery != null &&
            (!/^\d+$/.test(maxBytesQuery) || !Number.isSafeInteger(maxBytes))
          ) {
            json(response, 400, { error: "invalid-max-bytes" });
            return;
          }
          // HEAD reports the same bounded representation without opening a stream.
          const range =
            request.method === "GET" && request.headers.range === "bytes=0-0";
          if (range && (info.size === 0 || maxBytes === 0)) {
            response
              .writeHead(416, {
                "content-range": `bytes */${info.size}`,
                "content-length": 0,
                "x-file-size": info.size,
                "cache-control": "no-store",
              })
              .end();
            return;
          }
          const length = Math.min(info.size, maxBytes, range ? 1 : info.size);
          response.writeHead(range ? 206 : 200, {
            "content-type": "application/octet-stream",
            "content-length": length,
            "x-file-size": info.size,
            ...(range ? { "content-range": `bytes 0-0/${info.size}` } : {}),
            "cache-control": "no-store",
          });
          lease.activity();
          if (request.method === "HEAD" || length === 0) response.end();
          else {
            let bytes = 0;
            const completeBody = new Transform({
              transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                callback(null, chunk);
              },
              flush(callback) {
                callback(
                  bytes === length ? null : new Error("short file read")
                );
              },
            });
            // A short EOF errors the pipeline and destroys the response before
            // it can end cleanly with fewer bytes than Content-Length.
            await pipeline(
              handle.createReadStream({ end: length - 1, autoClose: false }),
              completeBody,
              response
            );
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!response.headersSent) {
          const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
          json(
            response,
            missing ? 404 : 409,
            missing
              ? { error: "not-found" }
              : { error: "conflict", reason: "download-failed" }
          );
        } else response.destroy();
      }
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/upload") {
      json(response, 404, { error: "not-found" });
      return;
    }
    const folder = uploadFolder(
      url.searchParams.get("workspaceId") ?? "",
      url.searchParams.get("sessionId") ?? ""
    );
    if (!folder) {
      json(response, 400, { error: "session-required" });
      request.resume();
      return;
    }
    const limit = 256 * 1024 * 1024;
    if (Number(request.headers["content-length"]) > limit) {
      json(response, 413, { error: "too-large" });
      request.resume();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) {
          json(response, 413, { error: "too-large" });
          request.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      let files: Array<{ name: string; data: Uint8Array }>;
      if (request.headers["content-type"]?.startsWith("multipart/form-data")) {
        const form = await new Response(bytes, {
          headers: { "content-type": request.headers["content-type"] },
        }).formData();
        files = [];
        for (const value of form.values())
          if (typeof value !== "string")
            files.push({
              name: value.name,
              data: new Uint8Array(await value.arrayBuffer()),
            });
        if (!files.length) {
          json(response, 400, { error: "files-required" });
          return;
        }
      } else
        files = [
          { name: url.searchParams.get("name") || "attachment", data: bytes },
        ];
      const result = await app.savePastedTempFiles(
        folder,
        files.map((file) => ({
          ...file,
          name: `${randomUUID()}-${basename(file.name)}`,
        }))
      );
      lease.activity();
      json(response, result.success ? 200 : 400, result);
    } catch {
      if (!response.headersSent)
        json(response, 400, { error: "upload-failed" });
    }
  });
