/**
 * Browser boot (spec 09 D4, D12). Only the bot account setup and the identity
 * call block: a sign-in or tier refusal replaces the app. Then the router mounts at once over the
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
import { installDb } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { untilOpen } from "#renderer/data/queries/notices";
import { systemInfoQuery } from "#renderer/data/queries/system";
import { createQueryClient, isRpcError } from "#renderer/data/query-client";
import {
  createHostTransport,
  type HostTransport,
} from "#renderer/data/transport/websocket";
import { followWriteAuthorization } from "#renderer/features/onboarding/gate";
import {
  DESKTOP_INSTALLER_URL,
  DesktopWhatsAppApp,
  PhoneErrorScreen,
  PhoneWhatsAppApp,
  stashWhatsAppClaim,
  whatsappChatQuery,
} from "#renderer/features/onboarding/whatsapp";
import { ConnectScreen } from "#renderer/features/shell/connect";
import { followReconnects } from "#renderer/features/shell/connect/recovery";
import {
  callApps,
  ConnectError,
  identifyHost,
  readyHost,
  runHostConnection,
  setPageTransport,
  setUpBotAccount,
  takeRestartRequest,
} from "#renderer/features/shell/connect/services";
import { installActivity } from "#renderer/lib/activity";
import {
  installBrowserAttention,
  requestNotificationPermission,
} from "#renderer/lib/browser/notifications";
import {
  installSignOutPeers,
  installSignOutUnmount,
  signOutWithoutApp,
  switchAccountWithoutApp,
} from "#renderer/lib/browser/sign-out";
import { installUiContinuity } from "#renderer/lib/continuity";
import { importLegacyDrafts } from "#renderer/lib/continuity/composer-drafts";
import { changeLanguage, fixedT, resolveLanguage } from "#renderer/lib/i18n";
import { installLogRing } from "#renderer/lib/log-ring";
import { installTransitionTypes } from "#renderer/lib/navigation/transition-types";
import { webSignUpHref } from "#renderer/lib/navigation/web-sign-in";
import { isPhone } from "#renderer/lib/phone";
import {
  applyBootLook,
  applyTheme,
  CONTRAST_QUERY,
  DARK_QUERY,
  setLookStore,
  holdTheme,
} from "#renderer/lib/theme";
import { BootThemeEffect } from "#renderer/lib/theme-effect";
import { showError } from "#renderer/lib/toast";
import { createAppRouter } from "#renderer/router";

export { HostStatus } from "#renderer/features/shell/connect";

/** The phone layout's width (the app's own breakpoint). */
const PHONE_QUERY = "(max-width: 799px)";

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
      if (
        isRpcError(error) &&
        (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
      ) {
        console.error("[boot] system.info refused", error);
        return null;
      }
      console.warn("[boot] system.info failed; retrying", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
};

/** ChatLLM on this host: where an account that ChatLLM bills settles a refusal. */
const CHATLLM_PATH = "/chatllm/";

/** Tries at reading the phone's WhatsApp chat, a second apart. */
const PHONE_CHAT_ATTEMPTS = 4;

/**
 * The bot in a browser is WhatsApp: a phone gets its two screens, a computer
 * connects WhatsApp and then downloads the desktop app. The host is started
 * and warmed in the background (the server signs it in and wakes it for each
 * message). Where the server offers no number, a computer goes straight to
 * the download and a phone (`false`) to the full app; a check that cannot
 * complete gets the error page.
 */
const mountWhatsAppApp = async (
  root: Root,
  phone: boolean
): Promise<boolean> => {
  const queryClient = createQueryClient({ showError });
  let chat;
  let failure: unknown;
  for (let attempt = 1; ; attempt += 1) {
    try {
      chat = await queryClient.fetchQuery(whatsappChatQuery(callApps));
      break;
    } catch (error) {
      // Signed out, tier, limit: the connect screen says so.
      if (
        error instanceof ConnectError &&
        ["signin", "tier", "limit"].includes(error.kind)
      )
        throw error;
      const refused = error instanceof ConnectError && error.kind === "refused";
      if (refused || attempt >= PHONE_CHAT_ATTEMPTS) {
        console.warn("[whatsapp] chat unavailable", error);
        failure = error;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (chat && !chat.available) {
    if (phone) return false;
    location.replace(DESKTOP_INSTALLER_URL);
    return true;
  }
  const trialEnded = isBotTrialEnded(failure);
  if (!trialEnded && followBillingRefusal(failure)) return true;
  // For the page's life: these screens are light only.
  holdTheme("light");
  applyTheme(
    document,
    applyBootLook(document, {
      dark: false,
      high: matchMedia(CONTRAST_QUERY).matches,
    })
  );
  await changeLanguage(resolveLanguage("system")).catch((error: unknown) => {
    console.error("[renderer] locale failed; keeping English", error);
  });
  if (!chat) {
    const refusal =
      failure instanceof ConnectError && failure.kind === "refused"
        ? failure
        : null;
    root.render(
      <PhoneErrorScreen
        reason={trialEnded ? "trial_ended" : refusal ? "refused" : "connection"}
        detail={refusal?.detail}
        retry={refusal ? undefined : () => location.reload()}
        switchAccount={switchAccountWithoutApp}
        signOut={() => signOutWithoutApp()}
      />
    );
    return true;
  }
  void identifyHost()
    .then((identity) => readyHost(identity, () => {}))
    .catch((error: unknown) =>
      console.warn("[whatsapp] host warm-up failed", error)
    );
  root.render(
    <QueryClientProvider client={queryClient}>
      {phone ? (
        <PhoneWhatsAppApp callApps={callApps} />
      ) : (
        <DesktopWhatsAppApp callApps={callApps} />
      )}
    </QueryClientProvider>
  );
  return true;
};

const SIGN_UP_HOP_KEY = "abacusai-bot:sign-up-hop";
const SIGN_UP_HOP_MS = 2 * 60_000;

/**
 * Whether a signed-out visit may go straight to the sign-up page: once per
 * tab in a while, so a session that page still takes for signed in cannot
 * bounce between the two (the sign-in screen shows instead).
 */
const takeSignUpHop = (): boolean => {
  try {
    const last = Number(sessionStorage.getItem(SIGN_UP_HOP_KEY) ?? 0);
    if (Date.now() - last < SIGN_UP_HOP_MS) return false;
    sessionStorage.setItem(SIGN_UP_HOP_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
};

/** The bot's own free plan whose trial ended: it upgrades on the bot's upgrade page. */
const isBotTrialEnded = (error: unknown): boolean =>
  error instanceof ConnectError &&
  error.billing?.reason === "trial_ended" &&
  error.billing.botOnly;

/**
 * Any other billing refusal (a lapsed or unpaid plan, a ChatLLM trial) is
 * ChatLLM's account to settle: its own page says why and how. True when it
 * navigated.
 */
const followBillingRefusal = (error: unknown): boolean => {
  if (
    !(error instanceof ConnectError) ||
    !error.billing ||
    isBotTrialEnded(error)
  )
    return false;
  location.replace(CHATLLM_PATH);
  return true;
};

const renderConnectError = (root: Root, error: unknown): void =>
  root.render(
    <>
      {/* Before the app: its screens' theme scopes still reach the page. */}
      <BootThemeEffect />
      <ConnectScreen
        stage="starting"
        error={error instanceof Error ? error : new Error(String(error))}
      />
    </>
  );

export const mountPlatformApp = async (root: Root): Promise<boolean> => {
  stashWhatsAppClaim();
  let identity;
  try {
    await setUpBotAccount();
    if (await mountWhatsAppApp(root, isPhone())) return true;
    identity = await identifyHost();
  } catch (error) {
    if (followBillingRefusal(error)) return true;
    if (
      error instanceof ConnectError &&
      error.kind === "signin" &&
      takeSignUpHop()
    ) {
      location.replace(webSignUpHref());
      return true;
    }
    renderConnectError(root, error);
    return true;
  }
  installBrowserAttention();
  window.addEventListener("pointerdown", requestNotificationPermission, {
    once: true,
  });

  const transport = createHostTransport();
  setPageTransport(transport);
  // Asked once, by the boot that reaches its host (a failed identity check
  // leaves the request for the next one).
  void runHostConnection(transport, identity, {
    forceRestart: takeRestartRequest(),
    // Written once the first socket's system facts arrive.
    firstVisit: readLastKnown("system") == null,
  });

  const queryClient = createQueryClient({ showError });
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
  // Phones get the light theme only (a product choice); wider screens follow
  // the user's theme. Rotating or resizing across the width switches it.
  const phone = matchMedia(PHONE_QUERY);
  let releasePhone: (() => void) | null = null;
  const followPhone = () => {
    releasePhone?.();
    releasePhone = phone.matches ? holdTheme("light") : null;
  };
  followPhone();
  phone.addEventListener("change", followPhone);
  applyTheme(
    document,
    applyBootLook(document, {
      dark: !phone.matches && matchMedia(DARK_QUERY).matches,
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

  const stopLease = installLease(() => transport.state === "open");
  installSignOutUnmount(() => {
    root.unmount();
    stopLease();
  });
  installActivity(transport);
  installUiContinuity();
  installLogRing(transport);

  const router = createAppRouter({
    context: { queryClient, transport, system, db, t: fixedT() },
  });
  installTransitionTypes(router);
  followWriteAuthorization({ queryClient, transport }, router);
  installSignOutPeers(router.options.context);
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return true;
};
