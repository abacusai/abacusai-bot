import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";

import { canSignOutOfAbacus } from "#shared/settings";

import { BrowserPermissionPrompt } from "./components/browser/browser-permission-prompt";
import { CriticalUpdateDialog } from "./components/common/critical-update-dialog";
import { UpdateStalledBanner } from "./components/common/update-stalled-banner";
import { FirstBotDialog } from "./components/onboarding/first-bot-dialog";
import { OnboardingFlow } from "./components/onboarding/onboarding-flow";
import { WelcomeTourGate } from "./components/onboarding/welcome-tour";
import { TooltipProvider } from "./components/ui/tooltip";
import { useConversationActivator } from "./components/workspace/workspace-activation";
import { useWorkspaceConversationBridge } from "./conversation/store";
import { useKeepAwake } from "./hooks/use-keep-awake";
import { useNotifications } from "./hooks/use-notifications";
import { useTheme } from "./hooks/use-theme";
import { useWindowFullScreen } from "./hooks/use-window-fullscreen";
import { useCredentialRefresh } from "./lib/credential-refresh";
import { defaultWorkspaceSearch } from "./lib/route-search";
import { settingsQueryKeys } from "./lib/settings-query-keys";
import {
  isMacOS,
  TITLEBAR_DEFAULT_START_INSET,
  TITLEBAR_HEIGHT,
} from "./lib/window-chrome";
import { WorkspaceStateProvider } from "./providers/workspace-state-provider";
import { useAccountStore } from "./stores/account-store";
import { useGlobalContext } from "./stores/app-global";
import { useWorkspaceStore } from "./stores/code-store";
import { useTourStore } from "./stores/tour-store";
import { usePreviewOpenBridge } from "./utils/preview-utils";

/**
 * Owed when onboarding was never answered or no Abacus.AI credential is held:
 * the app requires an account, so a sign-out lands back on the sign-in screen.
 * The credential check is the stored key, not a network read, so being offline
 * never walls off a signed-in user.
 */
export const resolveNeedsOnboarding = ({
  current,
  accountLoaded,
  credentialPending,
  hasAbacusCredential,
  onboarded,
}: {
  current: boolean | null;
  accountLoaded: boolean;
  credentialPending: boolean;
  hasAbacusCredential: boolean;
  onboarded: boolean;
}): boolean | null => {
  if (!accountLoaded || credentialPending) return current;
  return !onboarded || !hasAbacusCredential;
};

/** Root shell for route content and app-lifetime Electron event bridges. */
function App(): React.JSX.Element {
  const { theme } = useTheme();

  // A renderer swap keeps the old renderer until the first commit fires this.
  useEffect(() => {
    window.api?.signalRendererReady?.();
  }, []);
  const fullScreen = useWindowFullScreen();
  const setHomeDir = useGlobalContext((state) => state.setHomeDir);
  const loadAccount = useAccountStore((state) => state.load);
  const accountLoaded = useAccountStore((state) => state.loaded);
  const onboarded = useAccountStore((state) => state.onboarded);
  // The stored key, not the /v1/account fetch: local, offline-safe, and
  // refreshed by useCredentialRefresh on every credentials-changed event.
  const credentialQuery = useQuery({
    queryKey: settingsQueryKeys.models.abacusCredential,
    queryFn: async () =>
      canSignOutOfAbacus(await window.api.agent.getSettings()),
    staleTime: 60_000,
  });
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // The flow opens the tour on its last step; the app behind it must render.
  const tourRunning = useTourStore((state) => state.isOpen);
  const navigate = useNavigate();

  useEffect(() => {
    setNeedsOnboarding((current) =>
      resolveNeedsOnboarding({
        current,
        accountLoaded,
        credentialPending: credentialQuery.isPending,
        hasAbacusCredential: credentialQuery.data === true,
        onboarded,
      })
    );
  }, [
    credentialQuery.data,
    credentialQuery.isPending,
    accountLoaded,
    onboarded,
  ]);

  // Onboarding ends at the composer. A navigation issued from the flow itself
  // is lost (its subtree unmounts in that moment), so this runs once the app is
  // mounted for good.
  const wasOnboarding = useRef(false);
  // A ref-derived flag, not storage, so an existing user whose localStorage was
  // cleared is never handed a bot they did not ask for.
  const [firstBotArmed, setFirstBotArmed] = useState(false);
  const disarmFirstBot = useCallback(() => setFirstBotArmed(false), []);
  useEffect(() => {
    if (needsOnboarding === true) wasOnboarding.current = true;
    else if (needsOnboarding === false && wasOnboarding.current) {
      wasOnboarding.current = false;
      setFirstBotArmed(true);
      void navigate({ to: "/", search: defaultWorkspaceSearch });
    }
  }, [navigate, needsOnboarding]);

  // Home directory backs the workspace picker's path shortening.
  useEffect(() => {
    window.api.getHomeDir().then(setHomeDir);
  }, [setHomeDir]);

  // Read once from account.json. Until it resolves the overlay stays down, so a
  // returning user never sees onboarding flash over their app.
  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  // See lib/credential-refresh.ts for why this is not each component's own job.
  useCredentialRefresh();

  // Mounted at the shell so it stays subscribed for the whole app lifetime.
  const activateSelection = useConversationActivator();
  useEffect(() => {
    const unsubscribe = window.api.onNotificationClicked((metadata) => {
      const workspaceId = metadata?.workspaceId;
      const sessionId = metadata?.sessionId;
      if (!workspaceId) return;
      activateSelection({ workspaceId, sessionId: sessionId ?? null });
      if (sessionId != null) {
        useWorkspaceStore.getState().markSessionViewed(sessionId);
      }
    });
    return unsubscribe;
  }, [activateSelection]);

  // Focus-gated OS notifications for the local agent.
  useNotifications();

  // Main broadcasts live with no replay, so this must stay subscribed for the
  // whole app lifetime: a missed `status_changed: idle` leaves the final text
  // segment stuck streaming forever.
  useWorkspaceConversationBridge();

  // Same lifetime argument: the preview panel unmounts when its tab is hidden,
  // so a listener there misses the very event that should open it.
  usePreviewOpenBridge();

  // Hold a power-save blocker while the agent is mid-turn (user-toggleable).
  useKeepAwake();

  return (
    <TooltipProvider delay={300}>
      <div
        className="text-foreground absolute inset-0 bg-transparent"
        style={
          {
            "--workspace-topbar-height": `${TITLEBAR_HEIGHT}px`,
            "--titlebar-start-inset": `${
              isMacOS && fullScreen ? 16 : TITLEBAR_DEFAULT_START_INSET
            }px`,
          } as React.CSSProperties
        }
      >
        <Toaster
          position="top-right"
          offset={{ top: TITLEBAR_HEIGHT + 10 }}
          richColors
          theme={theme}
        />
        <BrowserPermissionPrompt />
        <UpdateStalledBanner />
        <CriticalUpdateDialog />

        {/* `null` is "not known yet": rendering through that window let a
            signed-out user click a working app while the credential resolved.
            The tour spotlights this subtree, so it renders during the flow's
            last step too. */}
        {(needsOnboarding === false || tourRunning) && (
          <WorkspaceStateProvider>
            <Outlet />
            {/* Last, so the tour points at a window that is actually there:
                both gates above cover the app entirely. */}
            <WelcomeTourGate />
            <FirstBotDialog armed={firstBotArmed} onDone={disarmFirstBot} />
          </WorkspaceStateProvider>
        )}

        {needsOnboarding === true && <OnboardingFlow />}
      </div>
    </TooltipProvider>
  );
}

export default App;
