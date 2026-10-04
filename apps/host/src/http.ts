import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";

import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";

import type { AppOperations } from "#main/rpc/deps";
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
export const createHostHttpServer = (
  identity: HostIdentity,
  app: AppOperations,
  lease: HostLease,
  uploadFolder: (
    workspaceId: string,
    sessionId: string
  ) => string | null = () => null,
  whisper?: Pick<WhisperModelService, "prepareFile">
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
    const failure = authenticate(request, identity);
    if (failure) {
      console.warn(`[host-auth] ${failure}`);
      json(response, 403, { error: "forbidden" });
      request.resume();
      return;
    }
    if (
      request.method === "GET" &&
      ["/files", "/file"].includes(url.pathname)
    ) {
      try {
        const whisperUrl = url.searchParams.get("whisperUrl");
        const model =
          whisperUrl && whisper ? await whisper.prepareFile(whisperUrl) : null;
        if (whisperUrl && (!model || model.status !== 200 || !model.path)) {
          json(response, model?.status ?? 400, {
            error: model?.error ?? "model-unavailable",
          });
          return;
        }
        const file = model?.path
          ? {
              ok: true as const,
              realFile: model.path,
              stat: await stat(model.path),
            }
          : await openHostFile(
              url.searchParams.get("path") ?? "",
              url.searchParams.get("hostRoot") ?? ""
            );
        if (file.ok === false) {
          json(response, 404, { error: file.error });
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": file.stat.size,
          "cache-control": "no-store",
        });
        lease.activity();
        if (file.stat.size === 0) response.end();
        else
          await pipeline(
            createReadStream(file.realFile, { end: file.stat.size - 1 }),
            response
          );
      } catch {
        if (!response.headersSent)
          json(response, 400, { error: "download-failed" });
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
