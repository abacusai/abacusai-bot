/**
 * renderer-next boot (spec 01 §8.6): styles, the stored theme before the
 * first paint, i18n, then bootstrap() (transport, system facts, prefs) before
 * the router exists. A failure renders a static screen, never the router.
 */
import "./styles/app.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import {
  getCollections,
  setDbSource,
  type Collections,
} from "#next/data/collections";
import { DEFAULT_PREFS } from "#next/data/collections/prefs";
import { createQueryClient } from "#next/data/query-client";
import { getTransport } from "#next/data/transport";
import { BootFailure } from "#next/features/shell";
import {
  bootstrap,
  createTransportLostHandler,
  type BootError,
} from "#next/lib/bootstrap";
import {
  changeLanguage,
  i18n,
  initI18n,
  fixedT,
  resolveLanguage,
} from "#next/lib/i18n";
import { installTransitionTypes } from "#next/lib/navigation/transition-types";
import { applyTheme, DARK_QUERY, resolveTheme } from "#next/lib/theme";
import { toast } from "#next/ui/toast";

import { createAppRouter } from "./router";

// 1–2. The stored theme: main set nativeTheme from prefs before the window
// existed, so the media query already is the user's choice (§7.7).
applyTheme(document, resolveTheme("system", matchMedia(DARK_QUERY).matches));

// 3. Surface what would otherwise vanish.
window.addEventListener("error", (event) => {
  console.error("[renderer-next] uncaught", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer-next] unhandled rejection", event.reason);
});

const container = document.getElementById("root");
if (container == null) throw new Error("renderer-next: #root is missing");
const root = createRoot(container, {
  onUncaughtError: (error) =>
    console.error("[renderer-next] render error", error),
});

const renderFailure = (error: BootError | null): void => {
  root.render(
    <BootFailure
      title={i18n.t("shell.boot.title")}
      description={i18n.t("shell.boot.description")}
      reloadLabel={i18n.t("shell.boot.reload")}
      detail={error?.message}
    />
  );
};

const stopSyncs = (collections: Collections | null): void => {
  if (collections == null) return;
  for (const collection of Object.values(collections))
    void collection.cleanup().catch(() => undefined);
};

const start = async (): Promise<void> => {
  // 4. English is bundled; the user's language follows prefs.
  await initI18n();

  // Until spec 00 sub-slice B lands, main's db.* answers UNAVAILABLE; the dev
  // fixture mode serves the tables from an in-renderer memory transport.
  if (import.meta.env.VITE_NEXT_DB_FIXTURES === "1") {
    const { createMemoryDbSource } =
      await import("#next/data/fixture-db/memory-source");
    setDbSource(createMemoryDbSource().source);
  }

  let collections: Collections | null = null;
  const queryClient = createQueryClient();
  const onTransportLost = createTransportLostHandler({
    stopSyncs: () => stopSyncs(collections),
    notify: () =>
      toast.add({ title: i18n.t("shell.connectionLost"), type: "loading" }),
    reload: () => window.location.reload(),
    showError: () => renderFailure(null),
    storage: window.sessionStorage,
  });

  // 5. Transport, system facts, prefs; the close handler is registered the
  // moment the transport exists.
  const result = await bootstrap({
    getTransport,
    queryClient,
    getCollections: () => {
      collections = getCollections();
      return collections;
    },
    onTransportLost,
  });
  if (!result.ok) {
    renderFailure(result.error);
    return;
  }
  const { boot } = result;

  // 6. Theme and language from prefs.
  const prefs = boot.collections.prefs.get("app") ?? DEFAULT_PREFS;
  applyTheme(
    document,
    resolveTheme(prefs.theme, matchMedia(DARK_QUERY).matches)
  );
  await changeLanguage(resolveLanguage(prefs.language));

  // 7. Mount guard: a port that died during boot already started the reload.
  if (boot.transport.state === "closed") return;
  const router = createAppRouter({
    context: {
      queryClient,
      transport: boot.transport,
      system: boot.system,
      collections: boot.collections,
      t: fixedT(),
    },
  });
  installTransitionTypes(router);

  if (import.meta.env.VITE_UI_GALLERY === "1") {
    const { installDevHooks } = await import("#next/lib/dev/dev-hooks");
    installDevHooks(router, boot.collections);
  }

  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};

void start();
