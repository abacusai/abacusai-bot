import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket, WebSocketServer } from "ws";

const owner = process.env.ABACUSAI_BOT_HOST_OWNER || "local-owner";
const org = process.env.ABACUSAI_BOT_HOST_ORG || "local-org";
const secret = readFileSync(process.env.ABACUSAI_BOT_HOST_SECRET_FILE, "utf8");
const origin = (
  process.env.ABACUSAI_BOT_HOST_ORIGINS || "https://apps.abacus.ai"
).split(",")[0];
const upstream = new URL(
  process.env.HOST_PROXY_TARGET || "http://127.0.0.1:7777"
);
const vite = new URL(process.env.HOST_PROXY_VITE || "http://127.0.0.1:5173");
const port = Number(process.env.HOST_PROXY_PORT || 443);
const previewHost = `local.preview.apps.abacus.ai${port === 443 ? "" : `:${port}`}`;
const token = () => {
  const payload = Buffer.from(
    JSON.stringify({ o: owner, g: org, e: Date.now() / 1000 + 600 })
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
};
const certDir = mkdtempSync(join(tmpdir(), "host-dev-cert-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(certDir, "key.pem"),
    "-out",
    join(certDir, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=apps.abacus.ai",
    "-addext",
    "subjectAltName=DNS:apps.abacus.ai,DNS:local.preview.apps.abacus.ai",
  ],
  { stdio: "ignore" }
);
const proxy = createServer(
  {
    key: readFileSync(join(certDir, "key.pem")),
    cert: readFileSync(join(certDir, "cert.pem")),
  },
  (req, res) => {
    // The production preview proxy supplies CORS; the host deliberately does not.
    const isHost = req.headers.host?.startsWith("local.preview.");
    const cors =
      isHost && req.headers.origin === origin
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers":
              "Authorization, Content-Type, REAI-UI",
            vary: "Origin",
          }
        : {};
    if (isHost && req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const mock = {
      "/api/_getOrCreateAbacusBotHost": {
        deploymentConversationId: "local",
        previewHost,
      },
      "/api/_getChatLLMComputer": { status: "ACTIVE", lifecycle: "ACTIVE" },
      "/api/_bootstrapAbacusBotHost": {
        token: token(),
        previewHost,
        version: process.env.ABACUSAI_BOT_HOST_VERSION || "1.0.86",
      },
      "/api/_keepAliveAbacusBotHost": { ok: true },
    }[req.url];
    if (mock) {
      req.resume();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(mock));
      return;
    }
    const isApi =
      req.url.startsWith("/api/") || req.url.startsWith("/chatllm/");
    const target = isHost ? upstream : isApi ? new URL(origin) : vite;
    const headers = { ...req.headers, host: target.host };
    if (isHost)
      Object.assign(headers, {
        origin,
        "x-abacus-user-id": owner,
        authorization: `Bearer ${token()}`,
      });
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      new URL(req.url, target),
      { method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode, { ...response.headers, ...cors });
        response.pipe(res);
      }
    );
    request.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(request);
  }
);
const sockets = new WebSocketServer({ noServer: true });
proxy.on("upgrade", (req, socket, head) => {
  const hmr = req.headers["sec-websocket-protocol"]?.includes("vite-hmr");
  const target = new URL(req.url, hmr ? vite : upstream);
  target.protocol = "ws:";
  const protocols = hmr
    ? ["vite-hmr"]
    : ["abacus-rpc", `abacus-token.${token()}`];
  const remote = new WebSocket(target, protocols, {
    headers: hmr ? {} : { Origin: origin, "x-abacus-user-id": owner },
  });
  remote.on("error", () => socket.destroy());
  remote.once("open", () =>
    sockets.handleUpgrade(req, socket, head, (local) => {
      local.on("message", (data, isBinary) =>
        remote.send(data, { binary: isBinary })
      );
      remote.on("message", (data, isBinary) =>
        local.send(data, { binary: isBinary })
      );
      local.on("close", () => remote.close());
      remote.on("close", () => local.close());
      local.on("error", () => remote.close());
    })
  );
});
proxy.listen(port, "127.0.0.1", () =>
  console.log(
    `Dev SPA: https://apps.abacus.ai${port === 443 ? "" : `:${port}`}/web/; host: https://${previewHost}`
  )
);
