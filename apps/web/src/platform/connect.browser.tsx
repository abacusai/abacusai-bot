/**
 * Browser boot (spec 09 D4, D12). Only the identity call blocks: a sign-in
 * or tier refusal replaces the app. Then the router mounts at once over the
 * page's host transport, which is still connecting; readiness (bootstrap,
 * `/healthz`, the socket) runs behind `hostConnection` and shows in the
 * shell's banner. Calls made meanwhile wait for the socket, writes until
 * the sign-in gate has confirmed from fresh host state; a replaced socket
 * refetches what a lost notice would have refreshed (`followReconnects`)
 * and re-runs the gate before writes go out again
 * (`followWriteAuthorization`).
 */
import type { SystemInfo } from "@abacus-ai/contract/contract";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Store } from "@tanstack/react-store";
import type { Root } from "react-dom/client";

import { lookStore, readLastKnown, writeLastKnown } from "#platform/last-known";
import { installLease } from "#platform/lease";
import { rpcCode } from "#renderer/data/ai/errors";
import { installDb } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { untilOpen } from "#renderer/data/queries/notices";
import { systemInfoQuery } from "#renderer/data/queries/system";
import { createQueryClient } from "#renderer/data/query-client";
import {
  createHostTransport,
  type HostTransport,
} from "#renderer/data/transport/websocket";
import { importLegacyDrafts } from "#renderer/features/chat/composer/draft-store";
import { followWriteAuthorization } from "#renderer/features/onboarding/gate";
import { ConnectScreen } from "#renderer/features/shell/connect";
import { followReconnects } from "#renderer/features/shell/connect/recovery";
import {
  identifyHost,
  runHostConnection,
  setPageTransport,
  takeRestartRequest,
} from "#renderer/features/shell/connect/services";
import { installActivity } from "#renderer/lib/activity";
import {
  installBrowserAttention,
  requestNotificationPermission,
} from "#renderer/lib/browser/notifications";
import { installUiContinuity } from "#renderer/lib/continuity";
import { changeLanguage, fixedT, resolveLanguage } from "#renderer/lib/i18n";
import { installLogRing } from "#renderer/lib/log-ring";
import { installTransitionTypes } from "#renderer/lib/navigation/transition-types";
import {
  applyBootLook,
  applyTheme,
  CONTRAST_QUERY,
  DARK_QUERY,
  setLookStore,
} from "#renderer/lib/theme";
import { createAppRouter } from "#renderer/router";

export { HostStatus } from "#renderer/features/shell/connect";

/** Until the host answers `system.info`: the browser's own view. */
const PLACEHOLDER_SYSTEM: SystemInfo = {
  appVersion: "",
  platform: "linux",
  arch: "",
  versions: {},
  homeDir: "",
  paths: { home: "", sessionHome: "", botHome: "" },
  materialIconsBasePath: null,
  contractVersion: 0,
  foundationApi: 0,
};

/** Background work: waits as long as the page lives. */
const BACKGROUND = { signal: new AbortController().signal };

/** `system.info` once a socket is open, retried on the next one if it drops. */
const loadSystem = async (
  transport: HostTransport,
  queryClient: ReturnType<typeof createQueryClient>,
  system: Store<SystemInfo>
): Promise<SystemInfo | null> => {
  while (await untilOpen(transport)) {
    try {
      const info = await queryClient.fetchQuery(
        systemInfoQuery(transport.orpc)
      );
      system.setState(() => info);
      // Facts only: legacy drafts are user text and are imported once.
      const { legacyComposerDrafts: _drafts, ...facts } = info;
      writeLastKnown("system", facts);
      return info;
    } catch (error) {
      if (rpcCode(error) === "FORBIDDEN" || rpcCode(error) === "NOT_FOUND") {
        console.error("[boot] system.info refused", error);
        return null;
      }
      console.warn("[boot] system.info failed; retrying", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
};

export const mountPlatformApp = async (root: Root): Promise<boolean> => {
  installBrowserAttention();
  window.addEventListener("pointerdown", requestNotificationPermission, {
    once: true,
  });
  let identity;
  try {
    identity = await identifyHost();
  } catch (error) {
    root.render(
      <ConnectScreen
        stage="starting"
        error={error instanceof Error ? error : new Error(String(error))}
      />
    );
    return true;
  }

  const transport = createHostTransport();
  setPageTransport(transport);
  // Asked once, by the boot that reaches its host (a failed identity check
  // leaves the request for the next one).
  void runHostConnection(transport, identity, {
    forceRestart: takeRestartRequest(),
  });

  const queryClient = createQueryClient();
  const db = installDb(async () => transport);
  // Closed is terminal on the web (sign-in, tier, contract): the banner or
  // the connect screen says why; nothing reloads.
  transport.onClose(() => db.stop());
  // A replaced socket missed the notices sent while none was open.
  followReconnects(transport, queryClient);

  const system = new Store<SystemInfo>(
    readLastKnown<SystemInfo>("system") ?? PLACEHOLDER_SYSTEM
  );
  void loadSystem(transport, queryClient, system).then((info) =>
    info == null
      ? undefined
      : importLegacyDrafts(info.legacyComposerDrafts ?? {}, (keys) =>
          transport.client.system.acknowledgeLegacyDrafts({ keys }, BACKGROUND)
        )
  );
  // The look follows prefs reactively (ThemeEffect, which also remembers
  // it here) once they load; until then this user's last look, from the
  // same per-user store as the system facts. The language once here.
  setLookStore(lookStore);
  applyTheme(
    document,
    applyBootLook(document, {
      dark: matchMedia(DARK_QUERY).matches,
      high: matchMedia(CONTRAST_QUERY).matches,
    })
  );
  void db.collections.prefs.preload().then(() =>
    changeLanguage(
      resolveLanguage(
        (db.collections.prefs.get("app") ?? DEFAULT_PREFS).language
      )
    ).catch((error: unknown) => {
      console.error("[renderer] locale failed; keeping English", error);
    })
  );

  installLease(() => transport.state === "open");
  installActivity(transport);
  installUiContinuity();
  installLogRing(transport);

  const router = createAppRouter({
    context: { queryClient, transport, system, db, t: fixedT() },
  });
  installTransitionTypes(router);
  followWriteAuthorization({ queryClient, transport }, router);
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return true;
};
