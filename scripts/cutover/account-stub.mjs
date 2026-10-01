import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

// This proxy never opens an outbound connection. CONNECT tunnels terminate at
// the local HTTPS stub. Only the synthetic fixture key can identify an account.
export async function accountStub(root) {
  const key = path.join(root, "stub-key.pem"),
    cert = path.join(root, "stub-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=routellm.abacus.ai",
    ],
    { stdio: "ignore" }
  );
  const requests = [];
  const respond = (request, response) => {
    const pathname = new URL(request.url, "https://routellm.abacus.ai")
      .pathname;
    const synthetic =
      request.headers.authorization === "Bearer synthetic-cutover-key";
    requests.push({
      method: request.method,
      path: pathname,
      syntheticCredential: synthetic,
    });
    response.setHeader("Content-Type", "application/json");
    if (synthetic && pathname === "/v1/account")
      response.end(
        JSON.stringify({
          user_id: "cutover-synthetic-user",
          organization_id: "cutover-synthetic-org",
          email: "fixture@example.invalid",
          name: "Synthetic fixture",
          subscription_tier: "free",
          credits_used: 0,
          credits_granted: 10000,
        })
      );
    else if (synthetic && pathname === "/v1/models")
      response.end(JSON.stringify({ data: [] }));
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  };
  const secure = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    respond
  );
  await new Promise((resolve) => secure.listen(0, "127.0.0.1", resolve));
  const proxy = http.createServer(respond);
  const sockets = new Set();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  secure.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (_request, client, head) => {
    const tunnel = net.connect(secure.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) tunnel.write(head);
      tunnel.pipe(client);
      client.pipe(tunnel);
    });
    sockets.add(tunnel);
    tunnel.on("close", () => sockets.delete(tunnel));
    tunnel.on("error", () => client.destroy());
    client.on("error", () => tunnel.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => secure.close(resolve)),
      ]);
    },
  };
}
