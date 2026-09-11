import { existsSync } from "fs";
import fs from "fs/promises";
import { createServer } from "http";
import type { Server } from "http";
import path from "path";

import { app, net } from "electron";

// Proxy-aware spellcheck dictionary download. On Windows/Linux Chromium fetches
// its Hunspell `.bdic` from Google's CDN directly, which corporate proxies
// block, so nothing is ever flagged as misspelled. This loopback shim re-issues
// each dictionary request through Electron `net` (system proxy / PAC / VPN,
// like ApiRelayServer) and caches the result on disk so one success is
// permanent. macOS uses the native spellchecker and never hits this path.

const UPSTREAM_BASE = "https://redirector.gvt1.com/edgedl/chrome/dict/";
const VALID_DICT = /^[A-Za-z0-9._-]+\.bdic$/;

let server: Server | null = null;

function fetchUpstream(fileName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = net.request(UPSTREAM_BASE + fileName);
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.on("data", () => {});
        response.on("end", () =>
          reject(
            new Error(
              `dictionary ${fileName} upstream HTTP ${response.statusCode}`
            )
          )
        );
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Start the shim and return the base URL for Chromium, or null if it could not
 * start (caller leaves the default CDN URL). Idempotent.
 */
export async function startSpellcheckDictionaryServer(): Promise<
  string | null
> {
  if (process.platform === "darwin") return null; // native spellchecker, no download

  const cacheDir = path.join(app.getPath("userData"), "spellcheck-dicts");

  const listeningServer = await new Promise<Server | null>((resolve) => {
    if (server) {
      resolve(server);
      return;
    }
    const srv = createServer(async (req, res) => {
      try {
        const name = path.basename(req.url || "");
        if (!VALID_DICT.test(name)) {
          res.writeHead(400);
          res.end();
          return;
        }
        const cachePath = path.join(cacheDir, name);
        let data: Buffer;
        if (existsSync(cachePath)) {
          data = await fs.readFile(cachePath);
        } else {
          data = await fetchUpstream(name);
          await fs.mkdir(cacheDir, { recursive: true });
          await fs.writeFile(cachePath, data);
        }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(data.length),
        });
        res.end(data);
      } catch (err) {
        console.warn("[spellcheck] dictionary fetch failed", err);
        res.writeHead(502);
        res.end();
      }
    });
    srv.once("error", (err) => {
      console.warn("[spellcheck] dictionary server failed to start", err);
      resolve(null);
    });
    srv.listen(0, "127.0.0.1", () => {
      server = srv;
      resolve(srv);
    });
  });

  if (!listeningServer) return null;
  const address = listeningServer.address();
  if (!address || typeof address === "string") return null;
  return `http://127.0.0.1:${address.port}/`;
}
