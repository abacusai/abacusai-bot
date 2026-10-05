import "./styles/app.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { createDb, DbProvider } from "#next/data/db";
import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { createQueryClient } from "#next/data/query-client";
import { getTransport } from "#next/data/transport";
import { createChatRuntime } from "#next/features/chat";
import { createTransportLostHandler } from "#next/lib/bootstrap";
import {
  initI18n,
  changeLanguage,
  resolveLanguage,
  i18n,
} from "#next/lib/i18n";
import { applyTheme } from "#next/lib/theme";

import { createNotchRouter } from "./notch-router";
applyTheme(document, "dark");
const root = createRoot(document.getElementById("root")!);
const start = async () => {
  await initI18n();
  const transport = await getTransport();
  const db = createDb(async () => transport);
  transport.onClose(
    createTransportLostHandler({
      stopSyncs: () => db.stop(),
      notify: () => undefined,
      reload: () => location.reload(),
      showError: () => {
        root.render(<p role="alert">{i18n.t("shell.connectionLost")}</p>);
      },
      storage: sessionStorage,
    })
  );
  await db.collections.prefs.preload();
  await Promise.all([
    db.collections.sessions.preload(),
    db.collections.bots.preload(),
    db.collections.routines.preload(),
  ]);
  await changeLanguage(
    resolveLanguage((db.collections.prefs.get("app") ?? DEFAULT_PREFS).language)
  );
  const queryClient = createQueryClient();
  const layout = await transport.client.notch.layout({});
  const chat = createChatRuntime(transport.client.ai, { maxSessions: 2 });
  const router = createNotchRouter({
    transport,
    db,
    queryClient,
    chat,
    layout,
  });
  await router.load();
  root.render(
    <QueryClientProvider client={queryClient}>
      <DbProvider value={db}>
        <RouterProvider router={router} />
      </DbProvider>
    </QueryClientProvider>
  );
};
void start().catch(async (error) => {
  console.error("[notch] boot failed", error);
  const transport = await getTransport().catch(() => null);
  await transport?.client.window.ready({
    barrier: "failed",
    reason: "notch-boot",
  });
});
