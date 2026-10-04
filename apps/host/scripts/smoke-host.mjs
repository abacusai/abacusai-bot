import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = process.argv[2];
const require = createRequire(join(root, "host/package.json"));
const { WebSocket } = require("ws");
const home = await mkdtemp(join(tmpdir(), "abacus-host-smoke-"));
const secret = "smoke-secret";
await writeFile(join(home, "secret"), secret, { mode: 0o600 });
const env = {
  ...process.env,
  ABACUSAI_BOT_HOME: home,
  ABACUSAI_BOT_RESOURCES: join(root, "resources"),
  ABACUSAI_BOT_HOST_OWNER: "owner",
  ABACUSAI_BOT_HOST_ORG: "org",
  ABACUSAI_BOT_HOST_SECRET_FILE: join(home, "secret"),
  ABACUSAI_BOT_HOST_ORIGINS: "https://apps.abacus.ai",
  ABACUSAI_BOT_HOST_PORT: "0",
};
const child = spawn(join(root, "node"), [join(root, "host/index.js")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
try {
  let port;
  for (let i = 0; i < 200; i++) {
    port = output.match(/listening on (\d+)/)?.[1];
    if (port) break;
    if (child.exitCode !== null) throw new Error(output);
    await delay(50);
  }
  assert.ok(port, output);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), null);
  assert.equal((await health.json()).owner, "owner");
  const payload = Buffer.from(
    JSON.stringify({ o: "owner", g: "org", e: Date.now() / 1000 + 600 })
  ).toString("base64url");
  const token = `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const connect = (origin, owner, tokenValue = token, accepted = false) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}`,
        ["abacus-rpc", ...(tokenValue ? [`abacus-token.${tokenValue}`] : [])],
        { headers: { Origin: origin, "x-abacus-user-id": owner } }
      );
      socket.on("error", () => {});
      socket.on("unexpected-response", (_request, response) => {
        try {
          assert.equal(response.statusCode, 403);
          assert.equal(accepted, false);
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.on("open", () => {
        socket.close();
        if (accepted) resolve();
        else reject(new Error("Unauthorized connection accepted"));
      });
    });
  await connect("https://foreign.example", "owner");
  await connect("https://apps.abacus.ai", "owner", "");
  await connect("https://apps.abacus.ai", "wrong");
  await connect("https://apps.abacus.ai", "owner", token, true);
  for (const tool of ["rg", "fd"])
    execFileSync(join(root, "resources/agent/vendor", tool), ["--version"]);
  // Each native check runs under the shipped Node and its own package resolution root.
  execFileSync(
    join(root, "node"),
    [
      "--input-type=module",
      "-e",
      `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(root, "host/package.json"))}); const pty=require('@lydell/node-pty').spawn('/bin/sh',['-c','printf pty-ok'],{name:'xterm',cols:80,rows:24,cwd:${JSON.stringify(home)},env:process.env}); let output=''; pty.onData(d=>output+=d); pty.onExit(()=>{if(!output.includes('pty-ok')) process.exitCode=1});`,
    ],
    { timeout: 10_000 }
  );
  await writeFile(join(home, "native-search-canary.txt"), "canary");
  execFileSync(
    join(root, "node"),
    [
      "--input-type=module",
      "-e",
      `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(root, "host/package.json"))}); const {FileFinder}=await import('@ff-labs/fff-node'); const result=FileFinder.create({basePath:${JSON.stringify(home)}}); if(!result.ok) throw new Error('finder'); const finder=result.value; await finder.waitForScan(10000); const found=finder.mixedSearch('native-search-canary',{pageSize:20}); if(!found.ok || !found.value.items.length) throw new Error('native search'); finder.destroy();`,
    ],
    { timeout: 15_000, cwd: join(root, "host") }
  );
  const agent = spawn(
    join(root, "node"),
    [
      join(root, "resources/agent/main.js"),
      "--wire",
      "agui",
      "--thread-id",
      "verify-host",
      "--permission-mode",
      "YOLO",
    ],
    {
      env: { ...env, ABACUSAI_BOT_SANDBOX: "off" },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let agentOutput = "";
  agent.stdout.on("data", (d) => (agentOutput += d));
  agent.stderr.on("data", (d) => (agentOutput += d));
  try {
    for (let i = 0; i < 200 && !agentOutput.includes("ready"); i++) {
      if (agent.exitCode !== null) break;
      await delay(50);
    }
    assert.match(agentOutput, /ready/, agentOutput);
  } finally {
    agent.kill("SIGTERM");
  }
  console.log(
    "Host bundle smoke passed: health, auth refusals, pty, native search, agent ready"
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(home, { recursive: true, force: true });
}
