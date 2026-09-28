import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ChevronLeft,
  Circle,
  Download,
  Hammer,
  Home,
  Plus,
  Power,
  RefreshCw,
  Smartphone,
  Square,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { DeviceBuildPhase, LocalDeviceInfo } from "#shared/contracts";

import { workspaceQueryKeys } from "../../lib/query-keys";
import { useWorkspaceStore } from "../../stores/code-store";
import { Alert, AlertDescription, Button, Spinner } from "../ui";
import { Card, CardContent, CardDescription, CardTitle } from "../ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "../ui/empty";
import { NativeSelect } from "../ui/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  AndroidStreamPlayer,
  MjpegStreamPlayer,
  captureSimulatorWindow,
  ScreenPermissionError,
} from "./device-screen-stream";

const SCREENSHOT_POLL_MS = 1500;
const DEVICE_LIST_POLL_MS = 10_000;

export const XCODE_URL = "https://apps.apple.com/app/xcode/id497799835";
export const ANDROID_STUDIO_URL = "https://developer.android.com/studio";
export const MAESTRO_URL =
  "https://docs.maestro.dev/getting-started/installing-maestro";
export const ANDROID_AVD_DOCS_URL =
  "https://developer.android.com/studio/run/managing-avds";
export const IOS_SIM_DOCS_URL =
  "https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes";

type DevicePlatform = LocalDeviceInfo["platform"];

const deviceKey = (d: LocalDeviceInfo): string => `${d.platform}:${d.id}`;

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  ios: "iOS",
  android: "Android",
};

/**
 * iOS native mirror (sim-input helper `stream` mode): CoreSimulator's display
 * IOSurface as MJPEG, fully headless with no permissions and 1:1 taps. Falls
 * back to desktopCapturer window capture, then screenshot polling.
 */
const IOS_NATIVE_MIRROR_ENABLED = true;

/** How the screen is being displayed. Streams fall back to polling on error. */
type ScreenMode = "android-stream" | "ios-stream" | "ios-window" | "poll";

/**
 * Live, tap-through mirror of an iOS simulator / Android emulator, fully
 * headless. Android: scrcpy H.264 → WebCodecs → canvas, input over its control
 * socket. iOS: native framebuffer MJPEG → canvas, HID touch/keys. Both fall
 * back to screenshot polling. The toolbar can Build & Run the workspace.
 */
export const DevicePanel = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Active platform tab; null until the device list + workspace decide the default. */
  const [platformTab, setPlatformTab] = useState<DevicePlatform | null>(null);
  const [booting, setBooting] = useState(false);
  const [buildPhase, setBuildPhase] = useState<DeviceBuildPhase | null>(null);
  const [installingMaestro, setInstallingMaestro] = useState(false);
  const [creatingDevice, setCreatingDevice] = useState(false);
  /** Setup guidance from a failed create, shown in place rather than as a toast. */
  const [createError, setCreateError] = useState<string | null>(null);
  const [screenMode, setScreenMode] = useState<ScreenMode>("poll");
  /** Device key whose stream errored. Stops the upgrade effect from retry-looping. */
  const [streamFailedKey, setStreamFailedKey] = useState<string | null>(null);
  /** iOS device key whose native framebuffer stream failed; falls back to window capture. */
  const [iosStreamFailedKey, setIosStreamFailedKey] = useState<string | null>(
    null
  );
  /** iOS device key whose window capture also failed; last stop before polling. */
  const [windowCaptureFailedKey, setWindowCaptureFailedKey] = useState<
    string | null
  >(null);
  const [screenPermissionNeeded, setScreenPermissionNeeded] = useState(false);
  const [axPermissionNeeded, setAxPermissionNeeded] = useState(false);
  const pointerStart = useRef<{ fx: number; fy: number; time: number } | null>(
    null
  );
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Device screen aspect (w/h), used to locate the content area inside the captured Simulator window. */
  const deviceAspectRef = useRef<number | null>(null);

  const statusQuery = useQuery({
    queryKey: workspaceQueryKeys.deviceStatus,
    queryFn: async () => (await window.api?.agent?.getDeviceStatus?.()) ?? null,
    staleTime: 60_000,
  });
  const projectQuery = useQuery({
    queryKey: workspaceQueryKeys.deviceProjectInfo(
      activeWorkspaceId ?? undefined
    ),
    queryFn: async () =>
      (await window.api?.agent?.getDeviceProjectInfo?.()) ?? null,
    staleTime: 30_000,
  });
  const devicesQuery = useQuery({
    queryKey: workspaceQueryKeys.localDevicesRoot,
    queryFn: async () => (await window.api?.agent?.listLocalDevices?.()) ?? [],
    refetchInterval: DEVICE_LIST_POLL_MS,
  });
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const project = projectQuery.data;
  const status = statusQuery.data;

  const selected = devices.find((d) => deviceKey(d) === selectedKey) ?? null;
  const selectedId = selected?.id ?? null;
  const selectedName = selected?.name ?? null;
  const selectedPlatform = selected?.platform ?? null;
  const selectedBooted = selected != null && selected.state === "booted";

  // Platforms worth showing a tab for: any with a device, plus any whose
  // toolchain is installed (so an empty tab can still explain what's missing).
  const platforms = useMemo<DevicePlatform[]>(() => {
    const present = new Set<DevicePlatform>(devices.map((d) => d.platform));
    if (status?.ios === true) present.add("ios");
    if (status?.android === true) present.add("android");
    return (["ios", "android"] as DevicePlatform[]).filter((p) =>
      present.has(p)
    );
  }, [devices, status]);

  // Pick the opening tab from what the workspace actually builds, then from
  // what's already running, then whatever exists.
  useEffect(() => {
    if (platformTab != null || platforms.length === 0) return;
    const projectPlatform: DevicePlatform | null =
      project?.ios === true && project?.android !== true
        ? "ios"
        : project?.android === true && project?.ios !== true
          ? "android"
          : null;
    const bootedPlatform =
      devices.find((d) => d.state === "booted")?.platform ?? null;
    const preferred = [projectPlatform, bootedPlatform].find(
      (p) => p != null && platforms.includes(p)
    );
    setPlatformTab(preferred ?? platforms[0]);
  }, [platformTab, platforms, project, devices]);

  // A workspace targeting a different platform re-derives the tab (clearing it
  // re-runs the effect above) so the panel follows the code being worked on.
  const projectTargets = `${project?.ios === true}/${project?.android === true}`;
  const lastProjectTargets = useRef<string | null>(null);
  useEffect(() => {
    if (project == null) return; // not loaded yet; don't clear a valid tab
    if (lastProjectTargets.current === projectTargets) return;
    const isFirst = lastProjectTargets.current == null;
    lastProjectTargets.current = projectTargets;
    if (!isFirst) setPlatformTab(null);
  }, [projectTargets, project]);

  const tabDevices = useMemo(
    () =>
      platformTab != null
        ? devices.filter((d) => d.platform === platformTab)
        : [],
    [devices, platformTab]
  );

  // An Android AVD is keyed by NAME while shut down and by adb SERIAL once
  // booted (`Pixel_8` → `emulator-5554`), so booting changes its key.
  // Remembering the name per platform re-attaches across that change.
  const lastNameByPlatform = useRef<Partial<Record<DevicePlatform, string>>>(
    {}
  );
  useEffect(() => {
    if (selected != null)
      lastNameByPlatform.current[selected.platform] = selected.name;
  }, [selected]);

  // Keep the selection inside the active tab: re-attach to the remembered
  // device, else prefer a booted one, else the first listed.
  useEffect(() => {
    if (platformTab == null) return;
    if (selected != null && selected.platform === platformTab) return;
    const lastName = lastNameByPlatform.current[platformTab];
    const pick =
      (lastName != null ? tabDevices.find((d) => d.name === lastName) : null) ??
      tabDevices.find((d) => d.state === "booted") ??
      tabDevices[0];
    setSelectedKey(pick != null ? deviceKey(pick) : null);
  }, [tabDevices, selected, platformTab]);

  // Build phase events from main (buildAndRunLocalDevice emits them)
  useEffect(() => {
    const off = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "device-build-state") {
        setBuildPhase(
          event.phase === "done" || event.phase === "error" ? null : event.phase
        );
      }
    });
    return () => off?.();
  }, []);

  // Reset to polling whenever the device changes; the stream effects upgrade
  // it. This effect must stay declared FIRST and each stream effect must assert
  // its mode unconditionally: setState calls batch, so the last write wins.
  useEffect(() => {
    setScreenMode("poll");
    setStreamFailedKey(null);
    setIosStreamFailedKey(null);
    setWindowCaptureFailedKey(null);
  }, [selectedKey]);

  // ── Android H.264 stream ─────────────────────────────────────────────────
  useEffect(() => {
    if (selectedId == null || !selectedBooted || selectedPlatform !== "android")
      return;
    if (streamFailedKey === selectedKey) return;
    // Assert the mode unconditionally: on the device-change commit the reset
    // effect has already queued 'poll', and this must be the last write.
    setScreenMode("android-stream");
    const canvas = canvasRef.current;
    // Start only once the mode has actually settled, so the canvas we grab is
    // the one that will stay mounted. The dep below re-runs us then.
    if (canvas == null || screenMode !== "android-stream") return;
    const failedKey = selectedKey;
    const player = new AndroidStreamPlayer(canvas, () => {
      setStreamFailedKey(failedKey);
      setScreenMode("poll");
    });
    void player.start(selectedId);
    return () => player.dispose();
  }, [
    selectedId,
    selectedPlatform,
    selectedKey,
    selectedBooted,
    streamFailedKey,
    screenMode,
  ]);

  // ── iOS native framebuffer stream (primary) ──────────────────────────────
  useEffect(() => {
    if (!IOS_NATIVE_MIRROR_ENABLED) return;
    if (selectedId == null || !selectedBooted || selectedPlatform !== "ios")
      return;
    if (iosStreamFailedKey === selectedKey) return; // gave up → window-capture effect takes over
    setScreenMode("ios-stream"); // unconditional; see the Android effect above
    const canvas = canvasRef.current;
    if (canvas == null || screenMode !== "ios-stream") return;
    const failedKey = selectedKey;
    const player = new MjpegStreamPlayer(
      canvas,
      (reason) => {
        if (reason.includes("accessibility-required"))
          setAxPermissionNeeded(true);
        if (reason.includes("screen-recording-required"))
          setScreenPermissionNeeded(true);
        setIosStreamFailedKey(failedKey);
      },
      () => {
        setAxPermissionNeeded(false);
        setScreenPermissionNeeded(false);
        setScreenMode("ios-stream");
      }
    );
    const start = async (): Promise<void> => {
      // Ensure the sim is booted AND Simulator.app is running: the mirror
      // fullscreens its window (into an invisible Space) and captures it.
      await window.api?.agent?.bootLocalDevice?.({
        platform: "ios",
        deviceId: selectedId,
      });
      await player.start(selectedId);
    };
    void start();
    return () => player.dispose();
  }, [
    selectedId,
    selectedPlatform,
    selectedKey,
    selectedBooted,
    iosStreamFailedKey,
    screenMode,
  ]);

  // ── iOS Simulator window capture (primary; framebuffer is off by default) ──
  // The capture includes the title bar, so only the device-screen region (a
  // device-aspect rect pinned to the frame's bottom) is drawn: taps map 1:1.

  useEffect(() => {
    if (
      selectedId == null ||
      selectedName == null ||
      !selectedBooted ||
      selectedPlatform !== "ios"
    )
      return;
    // When the native mirror is enabled, wait for it to give up first.
    if (IOS_NATIVE_MIRROR_ENABLED && iosStreamFailedKey !== selectedKey) return;
    if (windowCaptureFailedKey === selectedKey) return; // gave up → polling
    setScreenMode("ios-window"); // unconditional; see the Android effect above
    const canvas = canvasRef.current;
    if (canvas == null || screenMode !== "ios-window") return;
    const failedKey = selectedKey;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId = 0;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const draw = (): void => {
      if (cancelled) return;
      rafId = requestAnimationFrame(draw);
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) return;
      const aspect = deviceAspectRef.current;
      // Device content is pinned to the bottom of the window; the title bar is
      // whatever height remains above it. Unknown aspect → show the full frame.
      const contentH =
        aspect != null ? Math.min(vh, Math.round(vw / aspect)) : vh;
      const sy = vh - contentH;
      if (canvas.width !== vw || canvas.height !== contentH) {
        canvas.width = vw;
        canvas.height = contentH;
      }
      canvas
        .getContext("2d")
        ?.drawImage(video, 0, sy, vw, contentH, 0, 0, vw, contentH);
    };
    const run = async (): Promise<void> => {
      try {
        // Boot is a no-op for a booted sim but ensures Simulator.app is running
        // so a capturable window exists.
        await window.api?.agent?.bootLocalDevice?.({
          platform: "ios",
          deviceId: selectedId,
        });
        if (cancelled) return;
        // One screenshot to learn the device aspect ratio (locates the device
        // screen inside the captured window).
        const shot = await window.api?.agent?.captureDeviceScreenshot?.({
          platform: "ios",
          deviceId: selectedId,
        });
        if (shot?.dataUrl != null) {
          const img = new Image();
          img.src = shot.dataUrl;
          await img.decode().catch(() => undefined);
          if (img.naturalWidth > 0)
            deviceAspectRef.current = img.naturalWidth / img.naturalHeight;
        }
        // The window can take a beat to appear after a backgrounded launch.
        for (let attempt = 0; ; attempt++) {
          try {
            stream = await captureSimulatorWindow(selectedName);
            break;
          } catch (err) {
            if (
              cancelled ||
              err instanceof ScreenPermissionError ||
              attempt >= 3
            )
              throw err;
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setScreenPermissionNeeded(false);
        setScreenMode("ios-window");
        video.srcObject = stream;
        await video.play();
        draw();
      } catch (err) {
        if (!cancelled) {
          console.warn(
            "[device-stream] iOS window capture failed, falling back to polling:",
            err instanceof Error ? err.message : err
          );
          if (err instanceof ScreenPermissionError)
            setScreenPermissionNeeded(true);
          setWindowCaptureFailedKey(failedKey); // latch, else the assert above retry-loops
          setScreenMode("poll");
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      video.srcObject = null;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [
    selectedId,
    selectedName,
    selectedPlatform,
    selectedKey,
    selectedBooted,
    iosStreamFailedKey,
    windowCaptureFailedKey,
    screenMode,
  ]);

  const pollingActive = screenMode === "poll";
  const screenshotQuery = useQuery({
    queryKey: workspaceQueryKeys.deviceScreenshot(
      selected?.platform ?? "none",
      selected?.id ?? "none"
    ),
    queryFn: async () => {
      if (selected == null) return null;
      const result = await window.api?.agent?.captureDeviceScreenshot?.({
        platform: selected.platform,
        deviceId: selected.id,
      });
      if (result?.error != null) throw new Error(result.error);
      return result?.dataUrl ?? null;
    },
    enabled: selected != null && selectedBooted && pollingActive,
    refetchInterval: pollingActive ? SCREENSHOT_POLL_MS : false,
    placeholderData: (prev) => prev,
  });

  const canInteract =
    selectedBooted &&
    (selected.platform === "android" ||
      status?.maestro === true ||
      status?.iosNativeInput === true);

  const refreshScreen = (): void => {
    if (selected != null && pollingActive) {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.deviceScreenshot(
          selected.platform,
          selected.id
        ),
      });
    }
  };

  const sendInteraction = async (request: {
    action: "tap" | "long_press" | "swipe" | "scroll" | "type" | "press_key";
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    direction?: "up" | "down" | "left" | "right";
    amount?: number;
  }): Promise<void> => {
    if (selected == null) return;
    const result = await window.api?.agent?.interactLocalDevice?.({
      platform: selected.platform,
      deviceId: selected.id,
      ...request,
    });
    if (result?.success !== true && result?.error != null) {
      toast.error(result.error);
    }
    refreshScreen();
  };

  /**
   * Maps a pointer event to a fraction (0..1) of the DEVICE screen. For the
   * ios <video> the capture includes the title bar, so the content area is
   * found by fitting the device aspect to the bottom of the frame.
   */
  const toDeviceFraction = (
    e: ReactPointerEvent<HTMLElement>
  ): {
    fx: number;
    fy: number;
    devW: number | null;
    devH: number | null;
  } | null => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    let devW: number | null = null;
    let devH: number | null = null;
    if (screenMode === "poll" && imgRef.current != null) {
      devW = imgRef.current.naturalWidth || null;
      devH = imgRef.current.naturalHeight || null;
    } else if (canvasRef.current != null) {
      // All stream modes (android-stream / ios-stream / ios-window) paint the
      // device screen into the canvas, so the element box maps 1:1 to the screen.
      devW = canvasRef.current.width || null;
      devH = canvasRef.current.height || null;
    }
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { fx, fy, devW, devH };
  };

  const streamTouch = (
    phase: "down" | "move" | "up" | "tap",
    fx: number,
    fy: number
  ): void => {
    if (selected == null) return;
    window.api?.agent?.streamDeviceTouch?.({
      platform: selected.platform,
      deviceId: selected.id,
      phase,
      x: fx,
      y: fy,
      deviceWidth:
        selected.platform === "android"
          ? imgRef.current?.naturalWidth ||
            canvasRef.current?.width ||
            undefined
          : undefined,
      deviceHeight:
        selected.platform === "android"
          ? imgRef.current?.naturalHeight ||
            canvasRef.current?.height ||
            undefined
          : undefined,
    });
  };

  /**
   * Forward the PHYSICAL key (`code`) + modifiers; the device applies its own
   * layout, so typing works on any host layout.
   */
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (!canInteract || selected == null) return;
    if (
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Alt" ||
      e.key === "Meta"
    )
      return;
    window.api?.agent?.streamDeviceKey?.({
      platform: selected.platform,
      deviceId: selected.id,
      code: e.code,
      key: e.key,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
    });
    // Consume plain keystrokes so the browser doesn't act on them, but let
    // Cmd/Ctrl combos through so app shortcuts still work.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    refreshScreen();
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!canInteract) return;
    const point = toDeviceFraction(e);
    if (point == null) return;
    // Focus the mirror so keystrokes route to the device.
    e.currentTarget.focus?.();
    pointerStart.current = { fx: point.fx, fy: point.fy, time: Date.now() };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Begin a live gesture. iOS streams true HID down/move/up; Android
    // records the origin (its swipe is reconstructed on up).
    streamTouch("down", point.fx, point.fy);
    refreshScreen();
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!canInteract || pointerStart.current == null) return;
    const point = toDeviceFraction(e);
    if (point == null) return;
    streamTouch("move", point.fx, point.fy);
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!canInteract || selected == null) return;
    const start = pointerStart.current;
    pointerStart.current = null;
    const end = toDeviceFraction(e);
    if (start == null || end == null) return;
    // Both platforms stream a real down/move/up, so this 'up' completes taps,
    // drags and long-presses alike. Nothing may return early: skipping the
    // 'up' strands the touch down.
    streamTouch("up", end.fx, end.fy);
    refreshScreen();
  };

  const handleCreateDevice = async (
    platform: DevicePlatform
  ): Promise<void> => {
    if (creatingDevice) return;
    setCreatingDevice(true);
    setCreateError(null);
    try {
      const result = await window.api?.agent?.createLocalDevice?.({
        platform,
      });
      if (result?.success === true) {
        toast.success(
          t("devicePanel.deviceCreated", { name: result.device?.name ?? "" })
        );
        await queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.localDevicesRoot,
        });
        if (result.device != null) setSelectedKey(deviceKey(result.device));
      } else {
        // Setup guidance from main: show it in place, not as a toast that
        // disappears before it can be acted on.
        setCreateError(result?.error ?? t("devicePanel.createDeviceFailed"));
      }
    } finally {
      setCreatingDevice(false);
    }
  };

  const handleBoot = async (): Promise<void> => {
    if (selected == null || booting) return;
    setBooting(true);
    try {
      const result = await window.api?.agent?.bootLocalDevice?.({
        platform: selected.platform,
        deviceId: selected.id,
      });
      if (result?.success !== true) {
        toast.error(result?.error ?? t("devicePanel.bootFailed"));
      }
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.localDevicesRoot,
      });
    } finally {
      setBooting(false);
    }
  };

  const handleBuildRun = async (): Promise<void> => {
    if (selected == null || buildPhase != null) return;
    setBuildPhase("building");
    try {
      const result = await window.api?.agent?.buildAndRunLocalDevice?.({
        platform: selected.platform,
        deviceId: selected.id,
      });
      if (result?.success === true) {
        toast.success(t("devicePanel.buildDone"));
      } else {
        // The toast only has room for the tail; the full toolchain output is in
        // the main-process log (`[device-build]`).
        toast.error(
          result?.error != null
            ? result.error.slice(-500)
            : t("devicePanel.buildFailed")
        );
      }
    } finally {
      setBuildPhase(null);
      refreshScreen();
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.localDevicesRoot,
      });
    }
  };

  const handleOpenNative = (): void => {
    if (selected == null) return;
    // For a booted iOS sim, boot() short-circuits into `open -a Simulator`.
    void window.api?.agent?.bootLocalDevice?.({
      platform: selected.platform,
      deviceId: selected.id,
      focus: true,
    });
  };

  const handleInstallMaestro = async (): Promise<void> => {
    if (installingMaestro) return;
    setInstallingMaestro(true);
    try {
      const result = await window.api?.agent?.installMaestro?.();
      if (result?.success === true) {
        toast.success(t("devicePanel.maestroInstalled"));
        await queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.deviceStatus,
        });
      } else {
        toast.error(result?.error ?? t("devicePanel.maestroInstallFailed"));
        void window.api?.openExternal?.(MAESTRO_URL);
      }
    } finally {
      setInstallingMaestro(false);
    }
  };

  const projectTargetsSelected =
    selected != null &&
    ((selected.platform === "ios" && project?.ios === true) ||
      (selected.platform === "android" && project?.android === true));
  const buildPhaseLabel =
    buildPhase != null ? t(`devicePanel.phase.${buildPhase}`) : null;

  if (!devicesQuery.isLoading && devices.length === 0) {
    return (
      <DeviceSetupGuide
        iosToolchain={status?.ios === true}
        androidToolchain={status?.android === true}
      />
    );
  }

  const screenClasses = `max-h-full max-w-full select-none rounded-xl border border-border object-contain shadow-lg outline-none focus:ring-2 focus:ring-primary ${canInteract ? "cursor-pointer" : ""}`;

  return (
    <div className="flex h-full flex-col" data-id="device-panel">
      {platforms.length > 1 && (
        <div
          className="border-border flex items-center gap-1 border-b px-2 py-1.5"
          data-id="device-panel-platform-tabs"
        >
          {platforms.map((p) => {
            const isActive = platformTab === p;
            const targeted =
              p === "ios" ? project?.ios === true : project?.android === true;
            return (
              <Button
                key={p}
                variant="ghost"
                size="sm"
                onClick={() => setPlatformTab(p)}
                aria-pressed={isActive}
                className={
                  isActive ? "bg-secondary text-foreground" : undefined
                }
                data-id={`device-panel-tab-${p}`}
              >
                <span>{PLATFORM_LABEL[p]}</span>
                {targeted && (
                  // The workspace builds for this platform: marks the tab that
                  // Build & Run will actually work on.
                  <span
                    className="bg-primary h-1.5 w-1.5 rounded-full"
                    aria-hidden
                  />
                )}
              </Button>
            );
          })}
        </div>
      )}
      <div className="border-border flex items-center gap-2 border-b px-2 py-1.5">
        <NativeSelect
          value={selectedKey ?? ""}
          onChange={(e) =>
            setSelectedKey(e.target.value !== "" ? e.target.value : null)
          }
          disabled={tabDevices.length === 0}
          className="min-w-0 flex-1"
          aria-label={t("devicePanel.selectDevice")}
          data-id="device-panel-select"
        >
          {tabDevices.length === 0 && (
            <option value="">{t("devicePanel.noDevices")}</option>
          )}
          {tabDevices.map((d) => (
            <option key={deviceKey(d)} value={deviceKey(d)}>
              {`${d.name}${d.state === "booted" ? "" : ` (${t("devicePanel.stateShutdown")})`}`}
            </option>
          ))}
        </NativeSelect>
        {selected != null && !selectedBooted && (
          <Button
            size="sm"
            onClick={() => void handleBoot()}
            disabled={booting}
            data-id="device-panel-boot"
          >
            {booting ? (
              <Spinner fontSize={12} className="text-current" />
            ) : (
              <Power size={12} />
            )}
            <span>{t("devicePanel.boot")}</span>
          </Button>
        )}
        {selected != null && (
          // Always shown; the tooltip says why it's disabled rather than the
          // button silently not existing.
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  onClick={() => void handleBuildRun()}
                  disabled={buildPhase != null || !projectTargetsSelected}
                  className="disabled:pointer-events-auto"
                  data-id="device-panel-build-run"
                />
              }
            >
              {buildPhase != null ? (
                <Spinner fontSize={12} className="text-current" />
              ) : (
                <Hammer />
              )}
              <span>{buildPhaseLabel ?? t("devicePanel.buildRun")}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {projectTargetsSelected
                ? t("devicePanel.buildRunHint", {
                    platform: PLATFORM_LABEL[selected.platform],
                  })
                : t("devicePanel.buildRunUnavailable", {
                    platform: PLATFORM_LABEL[selected.platform],
                  })}
            </TooltipContent>
          </Tooltip>
        )}
        {selected?.platform === "ios" && selectedBooted && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleOpenNative}
                  aria-label={t("devicePanel.openNative")}
                  data-id="device-panel-open-native"
                />
              }
            >
              <AppWindow />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("devicePanel.openNative")}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: workspaceQueryKeys.localDevicesRoot,
                  })
                }
                aria-label={t("devicePanel.refresh")}
                data-id="device-panel-refresh"
              />
            }
          >
            <RefreshCw />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("devicePanel.refresh")}
          </TooltipContent>
        </Tooltip>
      </div>

      {axPermissionNeeded && selected?.platform === "ios" && (
        <div
          className="border-border bg-primary/10 flex items-center gap-2 border-b px-3 py-2 text-xs"
          data-id="device-panel-ax-permission"
        >
          <span className="text-secondary-foreground flex-1">
            {t("devicePanel.axPermissionNeeded")}
          </span>
          <Button
            size="sm"
            onClick={() =>
              void window.api?.agent?.openAccessibilitySettings?.()
            }
            data-id="device-panel-grant-ax"
          >
            {t("devicePanel.grantAccess")}
          </Button>
        </div>
      )}

      {screenPermissionNeeded && selected?.platform === "ios" && (
        <div
          className="border-border bg-primary/10 flex items-center gap-2 border-b px-3 py-2 text-xs"
          data-id="device-panel-screen-permission"
        >
          <span className="text-secondary-foreground flex-1">
            {t("devicePanel.screenPermissionNeeded")}
          </span>
          <Button
            size="sm"
            onClick={() =>
              void window.api?.agent?.openScreenRecordingSettings?.()
            }
            data-id="device-panel-grant-screen"
          >
            {t("devicePanel.grantAccess")}
          </Button>
        </div>
      )}

      <div className="bg-muted/40 relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        {selectedBooted && (
          <div
            className="pointer-events-none absolute top-2 right-2 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[0.625rem] text-white/80"
            data-id="device-panel-mode"
          >
            {screenMode === "poll"
              ? t("devicePanel.modePoll")
              : t("devicePanel.modeLive")}
          </div>
        )}
        {selected == null || !selectedBooted ? (
          tabDevices.length === 0 && platformTab != null ? (
            <NoDevicesForPlatform
              platform={platformTab}
              creating={creatingDevice}
              error={createError}
              onCreate={() => void handleCreateDevice(platformTab)}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <Smartphone size={28} className="text-muted-foreground" />
              <div className="text-muted-foreground text-xs">
                {t("devicePanel.notBooted")}
              </div>
            </div>
          )
        ) : screenMode !== "poll" ? (
          <canvas
            ref={canvasRef}
            tabIndex={canInteract ? 0 : -1}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onKeyDown={handleKeyDown}
            className={screenClasses}
            data-id="device-panel-screen-stream"
          />
        ) : screenshotQuery.data != null ? (
          <img
            ref={imgRef}
            src={screenshotQuery.data}
            alt={t("devicePanel.screenAlt", { name: selected?.name ?? "" })}
            tabIndex={canInteract ? 0 : -1}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onKeyDown={handleKeyDown}
            draggable={false}
            className={screenClasses}
            data-id="device-panel-screen"
          />
        ) : screenshotQuery.isError ? (
          <div
            className="text-muted-foreground max-w-xs text-center text-xs"
            data-id="device-panel-error"
          >
            {(screenshotQuery.error as Error | undefined)?.message ??
              t("devicePanel.captureFailed")}
          </div>
        ) : (
          <Spinner fontSize={20} />
        )}
      </div>

      {selectedBooted && (
        <div className="border-border flex items-center gap-1.5 border-t px-2 py-1.5">
          {canInteract ? (
            <>
              {selected.platform === "android" && (
                <>
                  <NavKey
                    icon={ChevronLeft}
                    label={t("devicePanel.keyBack")}
                    onClick={() =>
                      void sendInteraction({ action: "press_key", key: "back" })
                    }
                    dataId="device-panel-key-back"
                  />
                  <NavKey
                    icon={Circle}
                    label={t("devicePanel.keyHome")}
                    onClick={() =>
                      void sendInteraction({ action: "press_key", key: "home" })
                    }
                    dataId="device-panel-key-home"
                  />
                  <NavKey
                    icon={Square}
                    label={t("devicePanel.keyRecents")}
                    onClick={() =>
                      void sendInteraction({
                        action: "press_key",
                        key: "recents",
                      })
                    }
                    dataId="device-panel-key-recents"
                  />
                </>
              )}
              {selected.platform === "ios" && (
                <NavKey
                  icon={Home}
                  label={t("devicePanel.keyHome")}
                  onClick={() =>
                    void sendInteraction({ action: "press_key", key: "home" })
                  }
                  dataId="device-panel-key-home"
                />
              )}
              <span
                className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-xs"
                data-id="device-panel-type-hint"
              >
                {t("devicePanel.typeHint")}
              </span>
            </>
          ) : (
            <Button
              variant="link"
              size="sm"
              onClick={() => void handleInstallMaestro()}
              disabled={installingMaestro}
              data-id="device-panel-maestro-install"
            >
              {installingMaestro ? (
                <Spinner fontSize={12} className="text-current" />
              ) : (
                <Download size={12} />
              )}
              <span>
                {installingMaestro
                  ? t("devicePanel.installingMaestro")
                  : t("devicePanel.interactMaestroHint")}
              </span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

const NavKey = ({
  icon: Icon,
  label,
  onClick,
  dataId,
}: {
  icon: typeof ChevronLeft;
  label: string;
  onClick: () => void;
  dataId: string;
}): JSX.Element => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          aria-label={label}
          data-id={dataId}
        />
      }
    >
      <Icon />
    </TooltipTrigger>
    <TooltipContent side="top">{label}</TooltipContent>
  </Tooltip>
);

/**
 * Empty state for a platform tab with a toolchain but no devices. Offers to
 * create one from what's ALREADY on disk, never a multi-GB download behind a
 * button; otherwise main's setup instructions are shown verbatim.
 */
const NoDevicesForPlatform = ({
  platform,
  creating,
  error,
  onCreate,
}: {
  platform: DevicePlatform;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const label = PLATFORM_LABEL[platform];
  return (
    <Empty
      className="max-w-sm gap-3 p-4"
      data-id={`device-panel-empty-${platform}`}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Smartphone />
        </EmptyMedia>
        <EmptyDescription>
          {t("devicePanel.noPlatformDevices", { platform })}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          size="sm"
          onClick={onCreate}
          disabled={creating}
          data-id={`device-panel-create-${platform}`}
        >
          {creating ? (
            <Spinner fontSize={12} className="text-current" />
          ) : (
            <Plus />
          )}
          <span>
            {creating
              ? t("devicePanel.creatingDevice")
              : t("devicePanel.createDevice", { platform: label })}
          </span>
        </Button>
        {error != null && (
          <Alert
            variant="destructive"
            data-id={`device-panel-create-error-${platform}`}
          >
            <AlertDescription className="text-left whitespace-pre-line">
              {error}
            </AlertDescription>
          </Alert>
        )}
        <Button
          variant="link"
          size="sm"
          onClick={() =>
            void window.api?.openExternal?.(
              platform === "ios" ? IOS_SIM_DOCS_URL : ANDROID_AVD_DOCS_URL
            )
          }
          data-id={`device-panel-help-${platform}`}
        >
          {t("devicePanel.howToAddDevice", { platform: label })}
        </Button>
      </EmptyContent>
    </Empty>
  );
};

/**
 * Shown when there are no devices, including with no toolchain at all. iOS is
 * macOS-only, so that card is hidden elsewhere.
 */
const DeviceSetupGuide = ({
  iosToolchain,
  androidToolchain,
}: {
  iosToolchain: boolean;
  androidToolchain: boolean;
}): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const isMac = window.navigator.platform.toLowerCase().includes("mac");

  // Toolchain detection is cached for the life of the main process, so
  // installing Xcode/Android Studio mid-run needs a way to re-probe.

  const recheck = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    try {
      await window.api?.agent?.refreshDeviceStatus?.();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.deviceStatus,
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.localDevicesRoot,
        }),
      ]);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-6"
      data-id="device-panel-setup"
    >
      <Smartphone size={28} className="text-muted-foreground" />
      <div className="text-secondary-foreground text-sm">
        {t("devicePanel.noDevices")}
      </div>
      <div className="flex w-full max-w-sm flex-col gap-3">
        {isMac && (
          <SetupCard
            title={t("deviceSetup.iosTitle")}
            description={
              iosToolchain
                ? t("deviceSetup.iosRuntimeDesc")
                : t("deviceSetup.iosDesc")
            }
            url={XCODE_URL}
            dataId="device-setup-ios"
          />
        )}
        <SetupCard
          title={t("deviceSetup.androidTitle")}
          description={
            androidToolchain
              ? t("deviceSetup.androidAvdDesc")
              : t("deviceSetup.androidDesc")
          }
          url={ANDROID_STUDIO_URL}
          dataId="device-setup-android"
        />
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void recheck()}
        disabled={checking}
        data-id="device-setup-recheck"
      >
        {checking ? (
          <Spinner fontSize={12} className="text-current" />
        ) : (
          <RefreshCw size={12} />
        )}
        <span>{t("deviceSetup.recheck")}</span>
      </Button>
    </div>
  );
};

const SetupCard = ({
  title,
  description,
  url,
  dataId,
}: {
  title: string;
  description: string;
  url: string;
  dataId: string;
}): JSX.Element => {
  const { t } = useTranslation();
  return (
    <Card size="sm" className="bg-sidebar" data-id={dataId}>
      <CardContent className="space-y-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void window.api?.openExternal?.(url)}
          className="mt-2"
          data-id={`${dataId}-download`}
        >
          <Download />
          <span>{t("deviceSetup.download")}</span>
        </Button>
      </CardContent>
    </Card>
  );
};
