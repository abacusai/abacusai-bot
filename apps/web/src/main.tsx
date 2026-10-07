import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Store } from "@tanstack/react-store";
import { createRoot } from "react-dom/client";

/**
 * renderer boot (spec 01 §8.6): styles, the stored theme before the
 * first paint, i18n, then bootstrap() (transport, system facts, the
 * collections over that transport, prefs) before the router exists. Every
 * step is guarded: a failure anywhere renders the static BootFailure screen,
 * never a blank window, and tells main through a bounded readiness call.
 * The browser mounts its app before its host is reachable instead
 * (`mountPlatformApp`, spec 09 D12).
 */
import "./styles/app.css";
import { mountPlatformApp } from "#platform/connect";
import { installLease } from "#platform/lease";
import { createDb, installDb, type Db } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { createQueryClient } from "#renderer/data/query-client";
import { getTransport, type Transport } from "#renderer/data/transport";
import { importLegacyDrafts } from "#renderer/features/chat/composer/draft-store";
import { isToasterMounted } from "#renderer/features/shell/app-toaster";
import { BootFailure } from "#renderer/features/shell/screens";
import { installActivity } from "#renderer/lib/activity";
import {
  bootstrap,
  createTransportLostHandler,
  mountWhenOpen,
  reportFailedBoot,
  type BootError,
} from "#renderer/lib/bootstrap";
import { installUiContinuity } from "#renderer/lib/continuity";
import {
  changeLanguage,
  i18n,
  initI18n,
  fixedT,
  resolveLanguage,
} from "#renderer/lib/i18n";
import { installLogRing } from "#renderer/lib/log-ring";
import { resolvePrefsLook } from "#renderer/lib/look";
import {
  guardSingleViewTransition,
  settleSkippedViewTransitions,
} from "#renderer/lib/navigation/single-transition";
import { installTransitionTypes } from "#renderer/lib/navigation/transition-types";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { staleBuildCheck } from "#renderer/lib/stale-build";
import {
  applyBootLook,
  applyLook,
  applyTheme,
  CONTRAST_QUERY,
  DARK_QUERY,
  localLookStore,
  setLookStore,
} from "#renderer/lib/theme";
import { showError } from "#renderer/lib/toast";
import { toast } from "#renderer/ui/toast";

import { createAppRouter } from "./router";

// 1–2. The stored theme: main set nativeTheme from prefs before the window
// existed, so the media query already is the user's choice (§7.7). On the
// desktop app the last look (theme colours, fonts) paints with it before
// prefs arrive; the browser applies its user's once the host is identified
// (platform/connect.browser.tsx, with the other last-known facts).
const media = () => ({
  dark: matchMedia(DARK_QUERY).matches,
  high: matchMedia(CONTRAST_QUERY).matches,
});
if (IS_ELECTRON) setLookStore(localLookStore);
applyTheme(document, applyBootLook(document, media()));

// 3. Surface what would otherwise vanish.
window.addEventListener("error", (event) => {
  console.error("[renderer] uncaught", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] unhandled rejection", event.reason);
});
// A tab still running an older browser build reloads onto the new one.
if (!IS_ELECTRON) {
  const check = staleBuildCheck(
    async () =>
      (await fetch(import.meta.env.BASE_URL, { cache: "no-store" })).text(),
    () => [...document.scripts].map((script) => script.src),
    () => location.reload()
  );
  window.addEventListener("vite:preloadError", () => void check());
}
// TanStack/router#7906: a route transition the browser skips (hidden window)
// must not surface as an unhandled rejection.
settleSkippedViewTransitions(document);
// Dev and the acceptance build: a second view transition in one commit is
// reported (and counted for R1-T11b).
if (import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1")
  guardSingleViewTransition(document);

const container = document.getElementById("root");
if (container == null) throw new Error("renderer: #root is missing");
const root = createRoot(container, {
  onUncaughtError: (error) => console.error("[renderer] render error", error),
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
    if (await mountPlatformApp(root)) return;

    const queryClient = createQueryClient({ showError });
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
            await import("#renderer/data/fixture-db/memory-source")
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
    await importLegacyDrafts(boot.system.legacyComposerDrafts ?? {}, (keys) =>
      boot.transport.client.system.acknowledgeLegacyDrafts({ keys })
    );
    installLease(() => boot.transport.state === "open");
    installActivity(boot.transport);
    installUiContinuity();
    installLogRing(boot.transport);

    // 6. Theme, the whole look and language from prefs. A locale chunk that fails to load
    // keeps the bundled English.
    const prefs = boot.db.collections.prefs.get("app") ?? DEFAULT_PREFS;
    const look = resolvePrefsLook(prefs, null, media());
    applyTheme(document, look.mode);
    applyLook(document, look, prefs.appearance?.translucency !== false, prefs);
    await changeLanguage(resolveLanguage(prefs.language)).catch(
      (error: unknown) => {
        console.error("[renderer] locale failed; keeping English", error);
      }
    );

    // 7. Mount guard, re-checked after the awaited dev hooks import: a port
    // that died during boot or during that import already started the reload.
    if (boot.transport.state === "closed") return;
    const router = createAppRouter({
      context: {
        queryClient,
        transport: boot.transport,
        system: new Store(boot.system),
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
                  await import("#renderer/lib/dev/dev-hooks");
                installDevHooks(router, boot.db);
              } catch (error) {
                console.error("[renderer] dev hooks failed", error);
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
    console.error("[renderer] boot failed", error);
    renderFailure(error instanceof Error ? error : new Error(String(error)));
    void reportFailedBoot(
      transport,
      error instanceof Error ? error.message : String(error)
    );
  }
};

void start();
