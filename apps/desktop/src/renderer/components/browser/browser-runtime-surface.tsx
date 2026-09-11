import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Check,
  ExternalLink,
  Globe,
  LoaderCircle,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  SearchCode,
  Trash2,
  UserCircle,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type JSX,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  BrowserProfileInfo,
  BrowserRuntimeLease,
  BrowserRuntimeNavigation,
  BrowserRuntimeState,
} from "#shared/contracts";
import type { ConversationKey } from "#shared/conversation-scope";

import {
  describeNativeSurfaceOcclusion,
  hasNativeSurfaceOccluder,
  isNativeSurfaceHostVisible,
  subscribeNativeSurfaceEnvironment,
} from "../../lib/native-surface-occlusion";
import {
  browserResourceActions,
  type BrowserResource,
} from "../../stores/browser-resource-store";
import { Button } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const normalizeAddress = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "about:blank";
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const sameLease = (
  left: BrowserRuntimeLease | null,
  right: BrowserRuntimeLease
): boolean =>
  left?.conversationKey === right.conversationKey &&
  left.resourceId === right.resourceId &&
  left.generation === right.generation;

const roundedBounds = (element: HTMLElement) => {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
};

export const BrowserRuntimeSurface = ({
  scope,
  resource,
}: {
  scope: ConversationKey;
  resource: BrowserResource;
}): JSX.Element => {
  const { t } = useTranslation();
  const surfaceId = useId();
  const defaultBrowserTitle = t("workspace.rightPanel.browser");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const initialResourceRef = useRef(resource);
  const presentationGenerationRef = useRef(0);
  const occludedRef = useRef(true);
  const addressFocusedRef = useRef(false);
  const currentUrlRef = useRef(resource.url ?? "about:blank");
  const [lease, setLease] = useState<BrowserRuntimeLease | null>(null);
  const [runtimeState, setRuntimeState] = useState<BrowserRuntimeState | null>(
    null
  );
  const [address, setAddress] = useState(resource.url ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [profiles, setProfiles] = useState<BrowserProfileInfo[]>([]);
  const [environmentAllowsNative, setEnvironmentAllowsNative] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);

  const applyState = useCallback(
    (state: BrowserRuntimeState): void => {
      if (state.lease.resourceId !== resource.id) {
        return;
      }
      currentUrlRef.current = state.url;
      setLease((current) =>
        sameLease(current, state.lease) ? current : state.lease
      );
      setRuntimeState(state);
      if (!addressFocusedRef.current) {
        setAddress(state.url === "about:blank" ? "" : state.url);
      }
      browserResourceActions.setLocation(
        scope,
        resource.id,
        state.url,
        state.title || defaultBrowserTitle
      );
      browserResourceActions.setNavigation(scope, resource.id, {
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward,
        isLoading: state.loading,
      });
    },
    [defaultBrowserTitle, resource.id, scope]
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.agent
      .materializeBrowserRuntime({
        conversationKey: scope,
        resourceId: resource.id,
        ...(initialResourceRef.current.profileId == null
          ? {}
          : { profileId: initialResourceRef.current.profileId }),
        ...(initialResourceRef.current.url == null
          ? {}
          : { url: initialResourceRef.current.url }),
      })
      .then((state) => {
        if (!cancelled) applyState(state);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          toast.error(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [applyState, resource.id, scope]);

  useEffect(
    () =>
      window.api.agent.onEvent((event) => {
        if (event.type === "browser-runtime-state-updated")
          applyState(event.state);
      }),
    [applyState]
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.agent
      .listBrowserProfiles()
      .then((next) => {
        if (!cancelled) setProfiles(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host == null) return;
    const reconcile = (): void => {
      setEnvironmentAllowsNative(
        !hasNativeSurfaceOccluder(host) && isNativeSurfaceHostVisible(host)
      );
    };
    const resizeObserver = new ResizeObserver(reconcile);
    resizeObserver.observe(host);
    const unsubscribe = subscribeNativeSurfaceEnvironment(reconcile);
    reconcile();
    return () => {
      resizeObserver.disconnect();
      unsubscribe();
    };
  }, [resource.id]);

  const captureScreenshot = useCallback((): void => {
    if (lease == null) return;
    const capturedLease = lease;
    void window.api.agent
      .captureBrowserRuntime(capturedLease)
      .then(({ dataUrl }) => {
        // Keep the frame beneath the native surface warm, but freeze it while
        // it is exposed. Replacing a visible data URL forces a decode/paint and
        // creates the flash this placeholder is intended to prevent.
        if (!occludedRef.current) setScreenshot(dataUrl);
      })
      .catch(() => undefined);
  }, [lease]);

  useEffect(() => {
    if (runtimeState?.loading === false) captureScreenshot();
  }, [captureScreenshot, runtimeState?.loading, runtimeState?.url]);

  const occluded =
    menuOpen || !environmentAllowsNative || runtimeState?.error != null;
  occludedRef.current = occluded;

  // A pane that stays on its placeholder is a page that ignores every click
  // and never changes while the agent works. Say why in the renderer log,
  // so a report with a log dump names the overlay instead of a guess.
  useEffect(() => {
    if (!occluded || menuOpen || runtimeState?.error != null) return;
    const timer = setTimeout(() => {
      console.warn(
        `[browser-surface] native view hidden for 5s: ${describeNativeSurfaceOcclusion(hostRef.current)}`
      );
    }, 5_000);
    return () => clearTimeout(timer);
  }, [menuOpen, occluded, runtimeState?.error]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host == null || lease == null || occluded) return;

    const presentationId = `${surfaceId}:${++presentationGenerationRef.current}`;
    let frame = 0;
    let lastBounds = "";
    let disposed = false;
    const present = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !host.isConnected) return;
        const bounds = roundedBounds(host);
        if (bounds.width < 1 || bounds.height < 1) return;
        const serialized = JSON.stringify(bounds);
        if (serialized === lastBounds) return;
        lastBounds = serialized;
        void window.api.agent
          .presentBrowserRuntime({ lease, presentationId, bounds })
          .catch(() => undefined);
      });
    };
    const observer = new ResizeObserver(present);
    observer.observe(host);
    window.addEventListener("resize", present);
    window.addEventListener("scroll", present, true);
    present();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", present);
      window.removeEventListener("scroll", present, true);
      void window.api.agent
        .hideBrowserRuntime({ lease, presentationId })
        .catch(() => undefined);
    };
  }, [lease, occluded, surfaceId]);

  const runAction = (navigation: BrowserRuntimeNavigation): void => {
    if (lease == null) return;
    void window.api.agent
      .navigateBrowserRuntime({ lease, navigation })
      .then(applyState)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      );
  };

  const switchProfile = (profileId: string | null): void => {
    if (profileId === resource.profileId) return;
    void (async () => {
      if (profileId != null) {
        const imported = await window.api.agent.importBrowserProfile(profileId);
        if (!imported.success) {
          toast.error(
            imported.error ?? t("workspace.preview.browserProfileImportError")
          );
          return;
        }
      }
      const state = await window.api.agent.materializeBrowserRuntime({
        conversationKey: scope,
        resourceId: resource.id,
        ...(profileId == null ? {} : { profileId }),
        url: currentUrlRef.current,
      });
      browserResourceActions.setProfile(scope, resource.id, profileId);
      applyState(state);
      toast.success(
        t(
          profileId == null
            ? "workspace.preview.browserProfileCleared"
            : "workspace.preview.browserProfileImported"
        )
      );
    })().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    );
  };

  const navigate = (event: FormEvent): void => {
    event.preventDefault();
    addressFocusedRef.current = false;
    runAction({ action: "url", url: normalizeAddress(address) });
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const restoreAddress = (): void => {
    addressFocusedRef.current = false;
    setAddress(
      currentUrlRef.current === "about:blank" ? "" : currentUrlRef.current
    );
  };

  const handleAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    restoreAddress();
    event.currentTarget.blur();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="browser-runtime">
      <div className="border-border/50 flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!resource.navigation.canGoBack}
                onClick={() => runAction({ action: "back" })}
              />
            }
          >
            <ArrowLeft />
          </TooltipTrigger>
          <TooltipContent>{t("workspace.preview.back")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!resource.navigation.canGoForward}
                onClick={() => runAction({ action: "forward" })}
              />
            }
          >
            <ArrowRight />
          </TooltipTrigger>
          <TooltipContent>{t("workspace.preview.forward")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  runAction({
                    action: resource.navigation.isLoading ? "stop" : "reload",
                  })
                }
              />
            }
          >
            {resource.navigation.isLoading ? <X /> : <RefreshCw />}
          </TooltipTrigger>
          <TooltipContent>
            {resource.navigation.isLoading
              ? t("workspace.preview.stop")
              : t("workspace.preview.reload")}
          </TooltipContent>
        </Tooltip>
        <form className="min-w-0 flex-1" onSubmit={navigate}>
          <InputGroup>
            <InputGroupAddon>
              <Globe />
            </InputGroupAddon>
            <InputGroupInput
              value={address}
              onChange={(event) => setAddress(event.currentTarget.value)}
              onFocus={(event) => {
                addressFocusedRef.current = true;
                event.currentTarget.select();
              }}
              onBlur={restoreAddress}
              onKeyDown={handleAddressKeyDown}
              aria-label={t("workspace.preview.address")}
              placeholder={t("workspace.preview.addressPlaceholder")}
              className="text-xs"
            />
            {resource.navigation.isLoading && (
              <InputGroupAddon align="inline-end">
                <LoaderCircle className="animate-spin" />
              </InputGroupAddon>
            )}
          </InputGroup>
        </form>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            aria-label={t("workspace.preview.moreActions")}
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={5} className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                {t("workspace.preview.browserProfile")}
              </DropdownMenuLabel>
              <DropdownMenuItem onClick={() => switchProfile(null)}>
                <UserCircle />
                <span className="min-w-0 flex-1 truncate">
                  {t("workspace.preview.browserProfileNone")}
                </span>
                {resource.profileId == null && <Check className="ms-auto" />}
              </DropdownMenuItem>
              {profiles.map((profile) => (
                <DropdownMenuItem
                  key={profile.id}
                  onClick={() => switchProfile(profile.id)}
                >
                  <UserCircle />
                  <span className="min-w-0 flex-1 truncate">
                    {profile.browserName} · {profile.profileName}
                  </span>
                  {resource.profileId === profile.id && (
                    <Check className="ms-auto" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => runAction({ action: "hard-reload" })}
            >
              <RefreshCw />
              {t("workspace.preview.hardReload")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => runAction({ action: "open-devtools" })}
            >
              <SearchCode />
              {t("workspace.preview.developerTools")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center justify-between">
                {t("workspace.preview.zoom")}
                <span>
                  {Math.round((runtimeState?.zoomFactor ?? 1) * 100)}%
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => runAction({ action: "zoom-in" })}
              >
                <ZoomIn />
                {t("workspace.preview.zoomIn")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => runAction({ action: "zoom-out" })}
              >
                <ZoomOut />
                {t("workspace.preview.zoomOut")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => runAction({ action: "zoom-reset" })}
              >
                <RotateCcw />
                {t("workspace.preview.zoomReset")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => runAction({ action: "clear-site-data" })}
            >
              <Trash2 />
              {t("workspace.preview.clearSiteData")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={resource.url == null || resource.url === "about:blank"}
              onClick={() => {
                if (resource.url != null)
                  void window.api.openExternal(resource.url);
              }}
            >
              <ExternalLink />
              {t("workspace.preview.openExternal")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={hostRef} className="bg-background relative min-h-0 flex-1">
        {screenshot != null && runtimeState?.error == null && (
          <img
            src={screenshot}
            alt=""
            aria-hidden="true"
            data-placeholder-active={occluded ? "true" : "false"}
            className={`pointer-events-none absolute inset-0 size-full object-fill ${
              occluded ? "visible" : "invisible"
            }`}
          />
        )}
        {runtimeState?.error != null && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-72 space-y-3">
              <CircleAlert className="text-muted-foreground mx-auto size-6" />
              <div className="text-sm font-medium">
                {t("workspace.preview.pageUnavailable")}
              </div>
              <div className="text-muted-foreground text-xs">
                {runtimeState.error}
              </div>
              <Button
                size="sm"
                onClick={() => runAction({ action: "hard-reload" })}
              >
                {t("workspace.preview.tryAgain")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
