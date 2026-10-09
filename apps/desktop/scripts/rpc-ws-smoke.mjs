#!/usr/bin/env node
/**
 * Development smoke for the oRPC router over a WebSocket (spec 00 A.8).
 *
 *   node apps/desktop/scripts/rpc-ws-smoke.mjs           # run the checks, exit
 *   node apps/desktop/scripts/rpc-ws-smoke.mjs --serve   # keep it up, print the URL
 *
 * Bundles the real router, `startWebSocketTransport` and the test fakes
 * (main/rpc/testing.ts) with rolldown, with `electron` made to throw on
 * import, then starts the server on loopback with its random token. The
 * checks mirror A-T5: `system.info` answers, `update.events` opens on the
 * current status and streams a change, `window.state` is FORBIDDEN (a socket
 * has no window), and a connection without the token is refused. Not wired
 * into the app; nothing here runs in a build.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DESKTOP, "src");
// Inside the package, so the bundle resolves its externals from node_modules.
const OUT = join(DESKTOP, "node_modules", ".tmp", "rpc-ws-smoke");
const serve = process.argv.includes("--serve");

const entry = `
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
import { MainEventBus } from "#main/rpc/event-bus";
import { createRouter } from "#main/rpc/router";
import { fakeDeps, IDLE_UPDATE_STATUS } from "#main/rpc/testing";
import { startWebSocketTransport } from "#main/rpc/transports/websocket";

export const run = async ({ serve }) => {
  const bus = new MainEventBus();
  const server = await startWebSocketTransport({
    router: createRouter(),
    deps: fakeDeps({
      bus,
      app: { appVersion: () => "smoke", homeDir: () => "/h", botHome: () => "/h/.abacusai-bot", account: { get: () => ({ account: null, apps: [], onboarded: true }) }, markRendererActivity: () => {} },
      host: { sessionHomePath: () => "/h/AbacusAI", readSettings: () => ({ apiKeys: { ABACUS_API_KEY: "smoke" } }), getAbacusAccount: () => null, listModels: () => [], readApiKeyProviders: () => [], getConnectorStatuses: () => ({}) },
      serviceHost: {
 ensureSessionHomeWorkspace: () => null, getMetadata: () => ({ materialIconsBasePath: null, workspaces: [], activeWorkspaceId: null }),
 listAllAgentSessions: () => [], listSessionTurnStates: () => [], listBots: () => [], listRoutines: () => [], listRoutineHistories: () => [], listSessionArtifacts: () => [], listBotMemories: () => [], listMemories: () => ({ global: [], bots: [] }),
 listBotChatPreviews: () => [], listBotSenderChats: () => [], getNotificationSettings: () => ({ enabled: true, sound: true }),
 getMessagingSnapshot: () => ({ platforms: [], pending: [], approved: [], autoReplies: [], workspaceId: null, botId: null, gatewayEnabled: false, respondToInbound: false, autoApproveTools: false }), listConnectorRequests: () => [], listConnectorStatuses: () => ({}),
 },
    }),
  });
  if (serve) {
    console.log("[rpc-ws-smoke] serving on " + server.url);
    console.log("[rpc-ws-smoke] Ctrl-C to stop");
    return new Promise(() => undefined);
  }

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(ok);
    console.log((ok ? "ok   " : "FAIL ") + name + (detail ? "  " + detail : ""));
  };
  const websocket = new WebSocket(server.url);
  const client = createORPCClient(
    new RPCLink({ websocket, customJsonSerializers: CUSTOM_JSON_SERIALIZERS })
  );
  try {
    const info = await client.system.info();
    check("system.info answers", info.appVersion === "smoke", info.platform + " " + info.arch);

    const events = await client.update.events();
    const first = await events.next();
    check("update.events opens on the current status", first.value?.checking === false);
    bus.dispatchChannel("update", { ...IDLE_UPDATE_STATUS, checking: true });
    const second = await events.next();
    check("update.events streams a change", second.value?.checking === true);
    await events.return();

    const refused = await client.window.state().then(
      () => null,
      (error) => error?.code
    );
    check("window.state is FORBIDDEN without a window", refused === "FORBIDDEN", String(refused));

    const tokenless = await new Promise((resolve) => {
      const socket = new WebSocket(server.url.replace(/\\?token=.*/, ""));
      socket.addEventListener("close", (event) => resolve(event.code));
      socket.addEventListener("error", () => undefined);
    });
    check("a connection without the token is refused", tokenless === 1008, "close " + tokenless);
  } finally {
    websocket.close();
    await server.close();
  }
  return results.every(Boolean);
};
`;

mkdirSync(OUT, { recursive: true });
const entryFile = join(OUT, "entry.ts");
const bundleFile = join(OUT, "smoke.mjs");
writeFileSync(entryFile, entry);

const { build } = await import("rolldown");
await build({
  input: entryFile,
  platform: "node",
  // Photon resolves its WASM beside its CommonJS entry; keep that package intact.
  // `ws`'s native helpers are optional.
  external: [
    /^@orpc\//,
    "ws",
    "bufferutil",
    "utf-8-validate",
    "valibot",
    "@silvia-odwyer/photon-node",
  ],
  resolve: {
    alias: {
      "@abacus-ai/contract": join(SRC, "../../../packages/contract/src"),
      "#main": join(SRC, "main"),
    },
  },
  plugins: [
    {
      // The router must not need Electron: importing it fails the smoke.
      name: "no-electron",
      resolveId: (id) => (id === "electron" ? "\0no-electron" : null),
      load: (id) =>
        id === "\0no-electron"
          ? 'throw new Error("the router must not import electron");'
          : null,
    },
  ],
  logLevel: "silent",
  output: { file: bundleFile, format: "esm" },
  write: true,
});

const { run } = await import(pathToFileURL(bundleFile).href);
const passed = await run({ serve });
if (!serve) {
  rmSync(OUT, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}
