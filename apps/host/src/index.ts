import { join } from "node:path";

// Pod credentials must be removed before modules capture the inherited environment.
delete process.env.ABACUS_API_KEY;
process.env.ABACUSAI_BOT_RESOURCES ??= join(
  import.meta.dirname,
  "..",
  "resources"
);
process.env.ABACUSAI_BOT_SANDBOX = "off";

const main = async () => {
  const { readHostIdentity, authenticate } = await import("./auth");
  const { installMainLogCollector } =
    await import("#main/services/diagnostics/log-dump");
  const { logStore } = await import("#main/services/diagnostics/log-store");
  const { installCrashGuard } = await import("#main/crash-guard");
  logStore().start();
  installMainLogCollector((line) => logStore().append("main", line));
  installCrashGuard();
  const { createHostHttpServer } = await import("./http");
  const { createRouter } = await import("#main/rpc/router");
  const { startWebSocketTransport } =
    await import("#main/rpc/transports/websocket");
  const identity = readHostIdentity();
  const { composeNodeHost } = await import("./compose");
  const composition = await composeNodeHost();
  const { appOps, lease } = composition;
  const httpServer = createHostHttpServer(
    identity,
    appOps,
    lease,
    (workspaceId, sessionId) =>
      composition.serviceHost.hostUploadFolder(workspaceId, sessionId),
    composition.serviceHost.whisperModelService
  );
  const transport = await startWebSocketTransport({
    router: createRouter(),
    deps: composition.deps,
    httpServer,
    host: "0.0.0.0",
    port: Number(process.env.ABACUSAI_BOT_HOST_PORT || 7777),
    platform: "web-host",
    flowControl: true,
    verifyClient: ({ req }, done) => {
      const failure = authenticate(req, identity);
      if (failure) console.warn(`[host-auth] ${failure}`);
      done(!failure, 403, "Forbidden");
    },
  });
  console.log(`[host] listening on ${transport.port}`);
  const { sweepTrash } = await import("./filesystem");
  void sweepTrash(appOps.botHome());
  const { installShutdown, shutdown } = await import("./shutdown");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await transport.close();
    await composition.dispose();
    logStore().flush();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  installShutdown(stop);
  process.once("SIGTERM", () => {
    shutdown();
  });
  process.once("SIGINT", () => {
    shutdown();
  });
};
if (process.argv.includes("--verify")) {
  const { verifyRuntime } = await import("./verify");
  await verifyRuntime();
} else await main();
