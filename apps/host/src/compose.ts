import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import { AgentMode } from "@abacus-ai/contract/agent-types";

import { composeHost } from "#main/compose-host";
import type { HostPlatformOperations } from "#main/handler";
import { CueArbiter } from "#main/notch/cue-arbiter";
import { abacusBotHome } from "#main/paths";
import type { RpcDeps } from "#main/rpc/deps";
import { unsupported } from "#main/rpc/errors";
import { mainEventBus } from "#main/rpc/event-bus";
import { createTables } from "#main/rpc/tables";
import { createEventTrackers } from "#main/rpc/trackers";
import { ServiceHost } from "#main/service-host";
import { PrefsStore } from "#main/services/config/prefs-store";
import { resolveAbacusApiKey } from "#main/services/providers/abacus";
import {
  abacusRoutellmV1,
  abacusUserAgent,
} from "#main/services/providers/abacus-host";

import { createNodeAppOperations } from "./app-operations";
import { createWebAuth, followProvisionedKey } from "./auth-web";
import { HostLease } from "./lease";
import { NudgeAgenda } from "./nudge-agenda";
import { channelsTransport, PhoneLane } from "./phone-lane";
import { shutdown } from "./shutdown";

const refuse = (procedure: string) => () => {
  throw unsupported(procedure);
};

/** Native sign-in, login items and local models have no web-host form. */
const nodeHostPlatform: HostPlatformOperations = {
  webAuth: createWebAuth,
  startAbacusAuth: refuse("auth.abacus.start"),
  startOpenRouterAuth: refuse("auth.openRouter.start"),
  cancelAbacusAuth: () => {},
  openAbacusAuthInBrowser: refuse("auth.abacus.openInBrowser"),
  listBrowserSignInProfiles: refuse("auth.abacus.browserProfiles"),
  shouldAutoSignIn: async () => false,
  cancelOpenRouterAuth: () => {},
  clearSignInSession: async () => {},
  rememberSessionAccount: () => {},
  registerLoginItem: () => {},
  relaunch: () => shutdown(75),
  requestMicrophoneAccess: async () => true,
  localModels: {
    state: refuse("localModels.state"),
    install: refuse("localModels.install"),
    cancelInstall: () => {},
    remove: refuse("localModels.remove"),
  },
};

const IDLE_UPDATE = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
};

export const composeNodeHost = async () => {
  const serviceHost = new ServiceHost("web-host");
  const lease = new HostLease(
    () =>
      serviceHost.aguiRelay.busy ||
      phoneLane.busy ||
      serviceHost
        .listRoutineHistories()
        .some(({ id }) =>
          serviceHost
            .listRoutineRuns(id)
            .some((run) => run.outcome === "running")
        )
  );
  const appOps = createNodeAppOperations(lease);
  const host = await composeHost({
    serviceHost,
    hostPlatform: nodeHostPlatform,
  });
  const stopProvisionedKey = followProvisionedKey(
    process.env.ABACUSAI_BOT_HOST_KEY_FILE,
    () => resolveAbacusApiKey() != null,
    host.adoptAbacusCredential
  );
  // Chromium from ABACUSAI_BOT_CHROMIUM, else one lookup now, retried in the background while missing.
  void serviceHost.prepareHostedBrowser();
  if (process.env.ABACUSAI_BOT_DEBUG_SYNC_URL)
    serviceHost.startBackgroundSync();
  const tables = createTables({
    bus: mainEventBus,
    sources: serviceHost,
    prefsStore: new PrefsStore(),
  });
  const trackers = createEventTrackers(mainEventBus);
  const refuseBrowser = refuse("browser");
  const deps: RpcDeps = {
    serviceHost,
    host,
    app: appOps,
    windows: {
      mainRendererId: () => null,
      contents: () => null,
      state: () => null,
      chrome: () => null,
      reportReady: () => {},
    },
    browserRuntime: {
      materialize: refuseBrowser,
      materializeFile: refuseBrowser,
      present: refuseBrowser,
      navigate: refuseBrowser,
      capture: refuseBrowser,
      hide: refuseBrowser,
      close: refuseBrowser,
      promoteScope: refuseBrowser,
    },
    update: {
      checkForUpdates: async () => refuse("update.check")(),
      installUpdate: async () => refuse("update.install")(),
      getStatus: () => IDLE_UPDATE,
    },
    cues: new CueArbiter({
      windows: {
        mainRendererId: () => null,
        mainFocused: () => false,
        audible: () => null,
        canPlay: () => false,
      },
      onWindowGone: (_id, forget) => forget(),
    }),
    bus: mainEventBus,
    tables,
    ai: serviceHost.aguiRelay,
    threads: serviceHost.threadStore,
    trackers,
  };
  // The user's WhatsApp number runs here, never in the desktop app.
  const phoneDir = join(abacusBotHome(), "phone");
  /** The phone loop's session, once minted: its waits and turns feed the agenda. */
  let phoneSessionId: string | null = null;
  const openPhoneSession = async (): Promise<{
    workspaceId: string;
    sessionId: string;
  }> => {
    mkdirSync(phoneDir, { recursive: true });
    // Nobody can approve a tool call over WhatsApp.
    const session = await serviceHost.openLaneSession(
      "phone",
      { ABACUSAI_BOT_PHONE_DIR: phoneDir },
      AgentMode.Auto,
      WHATSAPP_CHANNEL
    );
    phoneSessionId = session.sessionId;
    return session;
  };
  const channels = channelsTransport({
    baseUrl: abacusRoutellmV1,
    key: resolveAbacusApiKey,
    userAgent: abacusUserAgent,
  });
  const nudgeAgenda = new NudgeAgenda({
    call: channels,
    phoneDir,
    waits: async () =>
      phoneSessionId == null ? [] : serviceHost.waitsFor(phoneSessionId),
  });
  const phoneLane = new PhoneLane({
    call: channels,
    hasKey: () => resolveAbacusApiKey() != null,
    openSession: openPhoneSession,
    stop: (workspaceId, sessionId) =>
      serviceHost.abandonAgentTurn({ workspaceId, sessionId }),
    send: (workspaceId, sessionId, message, messageId) =>
      serviceHost.sendAgentMessage({
        workspaceId,
        sessionId,
        message,
        messageId,
      }),
    onAgentEvent: (listener) => serviceHost.onAgentEvent(listener),
    activity: () => lease.activity(),
    resolveMedia: (ref, sessionId) =>
      serviceHost.mediaStore.resolve(ref, sessionId),
    pinMedia: (ref, sessionId, pinned) =>
      pinned
        ? serviceHost.mediaStore.pin(ref, sessionId)
        : serviceHost.mediaStore.unpin(ref, sessionId),
    onPolled: (result) => nudgeAgenda.polled(result),
    turnNotes: (entry) => nudgeAgenda.notes(entry),
  });
  const stopTurns = serviceHost.onAgentEvent((sessionId, payload) => {
    if (
      sessionId === phoneSessionId &&
      payload.type === "event" &&
      payload.event.type === "turn_reply"
    )
      nudgeAgenda.turnEnded();
    else if (
      sessionId === phoneSessionId &&
      payload.type === "event" &&
      payload.event.type === "tool_execution_complete" &&
      /(^|_)checkins$/.test(payload.event.tool.name) &&
      payload.event.tool.input.op === "language"
    )
      nudgeAgenda.languageCallEnded();
  });
  // A connector the phone loop offered connected: nobody is at a card on a
  // phone, so the loop hears it as a turn and tells the user.
  const stopConnected = serviceHost.onLaneNote("phone", (note) =>
    phoneLane.note(note)
  );
  const stopOutput = mainEventBus.listen(
    (event) => event.type === "terminal-output",
    () => lease.terminalOutput()
  );
  return {
    serviceHost,
    deps,
    lease,
    appOps,
    phoneLane,
    nudgeAgenda,
    dispose: async () => {
      stopProvisionedKey();
      phoneLane.stop();
      nudgeAgenda.stop();
      stopTurns();
      stopConnected();
      stopOutput();
      trackers.dispose();
      tables.dispose();
      serviceHost.stopCronScheduler();
      await serviceHost.dispose();
    },
  };
};
