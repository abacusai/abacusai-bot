/**
 * renderer-next boot (spec 01 §8.6): styles, the stored theme before the
 * first paint, i18n, then bootstrap() (transport, system facts, the
 * collections over that transport, prefs) before the router exists. Every
 * step is guarded: a failure anywhere renders the static BootFailure screen,
 * never a blank window, and tells main through a bounded readiness call.
 */
import "./styles/app.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { createDb, installDb, type Db } from "#next/data/db";
import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { createQueryClient } from "#next/data/query-client";
import { getTransport, type Transport } from "#next/data/transport";
import { BootFailure, isToasterMounted } from "#next/features/shell";
import {
  bootstrap,
  createTransportLostHandler,
  mountWhenOpen,
  reportFailedBoot,
  type BootError,
} from "#next/lib/bootstrap";
import {
  changeLanguage,
  i18n,
  initI18n,
  fixedT,
  resolveLanguage,
} from "#next/lib/i18n";
import { guardSingleViewTransition } from "#next/lib/navigation/single-transition";
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
// Dev and the acceptance build: a second view transition in one commit is
// reported (and counted for R1-T11b).
if (import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1")
  guardSingleViewTransition(document);

const container = document.getElementById("root");
if (container == null) throw new Error("renderer-next: #root is missing");
const root = createRoot(container, {
  onUncaughtError: (error) =>
    console.error("[renderer-next] render error", error),
});

/** `t` that never throws: English copy is bundled, keys are the last resort. */
const text = (key: string): string => {
  try {
    return i18n.isInitialized ? i18n.t(key) : key;
  } catch {
    return key;
  }
};

const renderFailure = (error: BootError | Error | null): void => {
  root.render(
    <BootFailure
      title={text("shell.boot.title")}
      description={text("shell.boot.description")}
      reloadLabel={text("shell.boot.reload")}
      detail={error?.message}
    />
  );
};

/** The port died before the app mounted: no Toaster exists yet. */
const renderConnectionLost = (): void => {
  root.render(
    <BootFailure
      title={text("shell.connectionLost")}
      description={text("shell.boot.description")}
      reloadLabel={text("shell.boot.reload")}
    />
  );
};

const start = async (): Promise<void> => {
  let transport: Transport | null = null;
  let db: Db | null = null;
  try {
    // 4. English is bundled; the user's language follows prefs.
    await initI18n();

    const queryClient = createQueryClient();
    const onTransportLost = createTransportLostHandler({
      // Through the adapter, not collection.cleanup(): a mounted query or a
      // loader would restart a cleaned-up sync on the dead port.
      stopSyncs: () => db?.stop(),
      notify: () => {
        if (isToasterMounted())
          toast.add({ title: i18n.t("shell.connectionLost"), type: "loading" });
        else renderConnectionLost();
      },
      reload: () => window.location.reload(),
      showError: () => renderFailure(null),
      storage: window.sessionStorage,
    });

    // The dev fixture tables (VITE_NEXT_DB_FIXTURES=1): the gallery and the
    // visual screenshot run only. Every acceptance run reads main's db.*.
    const fixtures =
      import.meta.env.VITE_NEXT_DB_FIXTURES === "1"
        ? (
            await import("#next/data/fixture-db/memory-source")
          ).createMemoryDbTransport()
        : null;

    // 5. Transport, system facts, the collections over that transport,
    // prefs; the close handler is registered the moment the transport exists.
    const result = await bootstrap({
      getTransport,
      queryClient,
      getDb: (resolved) => {
        db =
          fixtures === null
            ? installDb(async () => resolved)
            : createDb(fixtures.transport);
        return db;
      },
      onTransportLost,
    });
    transport = result.ok ? result.boot.transport : result.transport;
    if (!result.ok) {
      renderFailure(result.error);
      return;
    }
    const { boot } = result;

    // 6. Theme and language from prefs. A locale chunk that fails to load
    // keeps the bundled English.
    const prefs = boot.db.collections.prefs.get("app") ?? DEFAULT_PREFS;
    applyTheme(
      document,
      resolveTheme(prefs.theme, matchMedia(DARK_QUERY).matches)
    );
    await changeLanguage(resolveLanguage(prefs.language)).catch(
      (error: unknown) => {
        console.error("[renderer-next] locale failed; keeping English", error);
      }
    );

    // 7. Mount guard, re-checked after the awaited dev hooks import: a port
    // that died during boot or during that import already started the reload.
    if (boot.transport.state === "closed") return;
    const router = createAppRouter({
      context: {
        queryClient,
        transport: boot.transport,
        system: boot.system,
        db: boot.db,
        t: fixedT(),
      },
    });
    installTransitionTypes(router);

    await mountWhenOpen({
      transport: boot.transport,
      prepare:
        import.meta.env.VITE_UI_GALLERY === "1"
          ? async () => {
              try {
                const { installDevHooks } =
                  await import("#next/lib/dev/dev-hooks");
                installDevHooks(router, boot.db);
              } catch (error) {
                console.error("[renderer-next] dev hooks failed", error);
              }
            }
          : undefined,
      mount: () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        ),
    });
  } catch (error) {
    // Anything unexpected: the failure screen, and main hears it (bounded).
    console.error("[renderer-next] boot failed", error);
    renderFailure(error instanceof Error ? error : new Error(String(error)));
    void reportFailedBoot(
      transport,
      error instanceof Error ? error.message : String(error)
    );
  }
};

void start();
