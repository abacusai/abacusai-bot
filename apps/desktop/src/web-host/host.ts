/**
 * One signed-in user's server for the hosted web app: the desktop's own main
 * process services (bots, chats, memory, connectors, the AG-UI relay) and
 * its oRPC router, run without Electron and rooted at that user's home.
 *
 * Started by the gateway (gateway.ts), never by a browser. Everything that
 * decides whose data this is arrives in the environment the gateway sets:
 *
 *   ABACUSAI_BOT_HOME         the user's home directory
 *   ABACUSAI_BOT_WEB_KEY      the user's API key; never written to disk
 *   ABACUSAI_BOT_WEB_SOCKET   the Unix socket the gateway reaches us on
 *   ABACUSAI_BOT_WEB_EMAIL, ABACUSAI_BOT_WEB_NAME   for the greeting
 *
 * Browser tabs reach the router through the gateway over that socket. The
 * key is used here and handed to the agents this process starts; it never
 * travels back over the socket.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import { RPCHandler } from "@orpc/server/ws";
import { WebSocketServer } from "ws";

import { abacusBotHome } from "#main/paths";
import { setHostedPolicy } from "#main/services/config/hosted";

import { setOpenExternalHandler } from "./electron-shim";

const required = (name: string): string => {
  const value = (process.env[name] ?? "").trim();
  if (value.length === 0) {
    console.error(`[web-host] ${name} is required`);
    process.exit(2);
  }
  return value;
};

/**
 * Toolsets a hosted agent may use. Nothing that reads or writes files, runs
 * commands, drives a browser or reaches devices: those would act on our
 * machine, not the user's. Coding goes through the user's desktop instead.
 */
const HOSTED_TOOLSETS = [
  "connectors",
  "memory",
  "todo",
  "web",
  "x_search",
  "session_search",
  "skills",
] as const;

/**
 * Withheld even inside allowed or always-on toolsets: `web_fetch` reads any
 * URL from inside our network, and the process tools reach processes this
 * machine runs for other users.
 */
const HOSTED_EXCLUDED_TOOLS = [
  "web_fetch",
  "fetch_background_output",
  "kill_process",
  "read_output",
] as const;

/**
 * The greeting's name and email, as the desktop's sign-in leaves them. It
 * authenticates nothing; written once so the user can still edit it.
 */
const seedAccount = (): void => {
  const file = join(abacusBotHome(), "account.json");
  const email = (process.env.ABACUSAI_BOT_WEB_EMAIL ?? "").trim();
  if (existsSync(file) || email.length === 0) return;
  const username = (process.env.ABACUSAI_BOT_WEB_NAME ?? "").trim();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        account: { username, email, createdAt: new Date().toISOString() },
        apps: [],
        onboarded: false,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
};

const main = async (): Promise<void> => {
  required("ABACUSAI_BOT_HOME");
  const key = required("ABACUSAI_BOT_WEB_KEY");
  const socketPath = required("ABACUSAI_BOT_WEB_SOCKET");
  // Agents get the key through the settings overlay, not by inheriting ours.
  delete process.env.ABACUSAI_BOT_WEB_KEY;

  setHostedPolicy({
    toolsets: HOSTED_TOOLSETS,
    excludedTools: HOSTED_EXCLUDED_TOOLS,
    apiKeys: { ABACUS_API_KEY: key },
  });
  seedAccount();

  // Loaded after the policy and the environment are in place: several of
  // these modules read the home directory when they load.
  const { createServices } = await import("./services");
  const services = await createServices();

  setOpenExternalHandler((url) =>
    services.bus.dispatchChannel("system", { type: "open-url", url })
  );

  const handler = new RPCHandler(services.router, services.handlerOptions);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host");
    // The gateway's liveness and idle probe.
    if (request.method === "GET" && url.pathname === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ sockets: sockets.clients.size, busy: services.busy() })
      );
      return;
    }
    // The gateway says whether the user's desktop is attached for coding.
    if (request.method === "POST" && url.pathname === "/runner") {
      services.setRunnerAttached(url.searchParams.get("attached") === "1");
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server });
  // A tab is a window to the window-scoped procedures; ids are per process.
  let nextWindowId = 1;
  sockets.on("connection", (socket) => {
    void handler.upgrade(socket, {
      context: {
        transport: "websocket",
        webContentsId: nextWindowId++,
        windowKind: "web",
        deps: services.deps,
      },
    });
  });

  mkdirSync(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  console.log("[web-host] ready");

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    for (const client of sockets.clients) client.terminate();
    server.close();
    void services.dispose().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // The gateway is our parent; if it is gone, nobody can reach us.
  process.on("disconnect", stop);
};

void main().catch((error: unknown) => {
  console.error("[web-host] failed to start", error);
  process.exit(1);
});
