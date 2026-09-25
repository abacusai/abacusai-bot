/**
 * The live device mirror and everything that fights over its transports:
 * stream start/stop/crash-restart across scrcpy, screenrecord, and the iOS
 * streamer; low-latency touch/key injection from the panel; and Build & Run,
 * which shares the adb transport with the mirror.
 */
import type {
  BuildAndRunLocalDeviceRequest,
  BuildAndRunLocalDeviceResult,
  DeviceBuildPhase,
  IpcEvent,
  StartDeviceStreamRequest,
  StartDeviceStreamResult,
  StreamDeviceKeyRequest,
  StreamDeviceTouchRequest,
} from "#shared/contracts";

import { AndroidScrcpyService } from "./android-scrcpy-service";
import type { DeviceService } from "./device-service";
import { DeviceStreamService } from "./device-stream-service";
import { IosStreamService } from "./ios-stream-service";

/** `KeyboardEvent.code` to Android KEYCODE_*. A Map, not a record: the code
 * arrives over IPC, and a record answers for every Object.prototype name. */
const ANDROID_KEYCODE_BY_CODE = new Map<string, number>([
  ["Enter", 66],
  ["Backspace", 67],
  ["Tab", 61],
  ["Escape", 111],
  ["Space", 62],
  ["ArrowUp", 19],
  ["ArrowDown", 20],
  ["ArrowLeft", 21],
  ["ArrowRight", 22],
]);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// The stream* payloads arrive over fire-and-forget IPC, so a malformed one
// has no reply channel to fail on and must be dropped rather than throw.
export const isValidStreamTouchRequest = (
  request: unknown
): request is StreamDeviceTouchRequest => {
  const r = request as StreamDeviceTouchRequest | null;
  return (
    r != null &&
    typeof r === "object" &&
    (r.platform === "ios" || r.platform === "android") &&
    typeof r.deviceId === "string" &&
    ["down", "move", "up", "tap"].includes(r.phase) &&
    isFiniteNumber(r.x) &&
    isFiniteNumber(r.y) &&
    (r.deviceWidth == null || isFiniteNumber(r.deviceWidth)) &&
    (r.deviceHeight == null || isFiniteNumber(r.deviceHeight))
  );
};

export const isValidStreamKeyRequest = (
  request: unknown
): request is StreamDeviceKeyRequest => {
  const r = request as StreamDeviceKeyRequest | null;
  return (
    r != null &&
    typeof r === "object" &&
    (r.platform === "ios" || r.platform === "android") &&
    typeof r.deviceId === "string" &&
    typeof r.code === "string" &&
    typeof r.key === "string"
  );
};

/** Crash-restart budget for the Android mirror; reset by a user-driven start. */
const MAX_ANDROID_MIRROR_RESTARTS = 3;
const ANDROID_MIRROR_RESTART_DELAY_MS = 800;

type DeviceMirrorDeps = {
  emitEvent: (event: IpcEvent) => void;
  /** Null when remote or none. */
  resolveWorkspacePath: () => string | null;
};

export class DeviceMirrorService {
  private readonly deviceStreamService: DeviceStreamService;
  private readonly scrcpyService: AndroidScrcpyService;
  private readonly iosStreamService = new IosStreamService();
  /** streamId of the mirror currently serving frames. */
  private activeDeviceStreamId: number | null = null;
  /** Bumped per startDeviceStream call so a superseded start can bail out. */
  private deviceStreamGeneration = 0;
  /** Tail of the adb-transport queue; see withAdbTransport. */
  private adbTransportQueue: Promise<void> = Promise.resolve();
  private androidRestartAttempts = 0;
  /** Per-device drag origin for the screenrecord fallback. */
  private readonly touchDragStart = new Map<string, { x: number; y: number }>();

  constructor(
    private readonly deviceService: DeviceService,
    private readonly deps: DeviceMirrorDeps
  ) {
    this.deviceStreamService = new DeviceStreamService(deviceService);
    this.scrcpyService = new AndroidScrcpyService(deviceService);
  }

  dispose(): void {
    this.scrcpyService.stop("service host disposed");
    this.deviceStreamService.stop();
    this.iosStreamService.stop();
  }

  async buildAndRunLocalDevice(
    request: BuildAndRunLocalDeviceRequest
  ): Promise<BuildAndRunLocalDeviceResult> {
    const emitPhase = (phase: DeviceBuildPhase, error?: string): void => {
      this.deps.emitEvent({
        type: "device-build-state",
        phase,
        ...(error != null ? { error } : {}),
        emittedAt: new Date().toISOString(),
      });
    };
    const workspacePath = this.deps.resolveWorkspacePath();
    if (workspacePath == null) {
      return { success: false, error: "No active local workspace." };
    }
    try {
      emitPhase("booting");
      const device = await this.deviceService.boot(
        request.platform,
        request.deviceId
      );
      emitPhase("building");
      const build = await this.deviceService.build(
        workspacePath,
        request.platform
      );
      if (!build.success || build.artifactPath == null) {
        emitPhase("error", build.output);
        return { success: false, error: build.output };
      }
      emitPhase("installing");
      // Held across install and launch: a mirror (re)start in between would
      // race the same adb transport. The build stays outside; it takes minutes
      // and does not touch adb.
      await this.withAdbTransport(async () => {
        await this.deviceService.installApp(
          request.platform,
          build.artifactPath as string,
          device.id
        );
        if (build.appId != null) {
          emitPhase("launching");
          await this.deviceService.launchApp(
            request.platform,
            build.appId,
            device.id
          );
        }
      });
      if (build.appId == null) {
        // Installed but no app id resolved, so nothing launches; silent
        // success would read as "Build & Run did nothing".
        console.warn(
          "[device-build] installed but NOT launched: no app id resolved from the project"
        );
      }
      emitPhase("done");
      return { success: true, appId: build.appId };
    } catch (err) {
      console.error(
        "[device-build] FAILED:",
        err instanceof Error ? err.message : err
      );
      const message = err instanceof Error ? err.message : String(err);
      emitPhase("error", message);
      return { success: false, error: message };
    }
  }

  async startDeviceStream(
    request: StartDeviceStreamRequest,
    sender: Electron.WebContents,
    opts?: { keepStreamId?: number | null; isRestart?: boolean }
  ): Promise<StartDeviceStreamResult> {
    if (opts?.isRestart !== true) this.androidRestartAttempts = 0;
    // Starting is slow and the panel starts more than once (StrictMode, mode
    // flips). A superseded start must not keep acting: its screenrecord
    // fallback would tear down the newer scrcpy stream already painting.
    const generation = ++this.deviceStreamGeneration;
    const superseded = (): boolean => {
      if (generation === this.deviceStreamGeneration) return false;
      return true;
    };
    // Only one mirror streams at a time.
    if (request.platform === "ios") {
      this.scrcpyService.stop("switching the mirror to iOS");
      this.deviceStreamService.stop();
      const ios = await this.iosStreamService.start(request.deviceId, sender);
      if (superseded()) return { success: false, error: "superseded" };
      this.activeDeviceStreamId = ios.success ? (ios.streamId ?? null) : null;
      return ios;
    }
    this.iosStreamService.stop();
    // Android: scrcpy is the live path; screenrecord buffers and is barely a
    // mirror, so it is only the fallback when the scrcpy server cannot start.
    this.deviceStreamService.stop();
    // An `adb install` in flight and a scrcpy startup on the same device fight
    // over the adb transport and both die.
    const scrcpy = await this.withAdbTransport(() =>
      this.scrcpyService.start(request.deviceId, sender)
    );
    if (superseded()) return { success: false, error: "superseded" };
    if (scrcpy.success) {
      this.activeDeviceStreamId = scrcpy.streamId ?? null;
      const rendererStreamId = opts?.keepStreamId ?? scrcpy.streamId ?? null;
      // The renderer scopes its stop() to the id it was handed, so a restart
      // must keep reporting that id or the stream can never be stopped.
      this.activeDeviceStreamId = rendererStreamId;
      this.scrcpyService.onUnexpectedExit = () => {
        void this.restartAndroidMirror(
          request.deviceId,
          sender,
          this.deviceStreamGeneration,
          rendererStreamId
        );
      };
      return { ...scrcpy, streamId: rendererStreamId ?? scrcpy.streamId };
    }
    console.warn(
      `[device-stream] scrcpy unavailable (${scrcpy.error ?? "?"}), falling back to screenrecord`
    );
    const fallback = await this.deviceStreamService.start(
      request.deviceId,
      sender
    );
    if (superseded()) {
      this.deviceStreamService.stop();
      return { success: false, error: "superseded" };
    }
    this.activeDeviceStreamId = fallback.success
      ? (fallback.streamId ?? null)
      : null;
    return fallback;
  }

  /**
   * Bring the Android mirror back after the scrcpy server died on its own.
   * Bounded so a device that always kills it is not an endless respawn loop.
   */
  private async restartAndroidMirror(
    deviceId: string,
    sender: Electron.WebContents,
    generation: number,
    keepStreamId: number | null
  ): Promise<void> {
    if (generation !== this.deviceStreamGeneration || sender.isDestroyed())
      return;
    if (this.androidRestartAttempts >= MAX_ANDROID_MIRROR_RESTARTS) {
      console.warn(
        `[device-stream] scrcpy died ${this.androidRestartAttempts}x in a row, leaving the mirror down`
      );
      return;
    }
    this.androidRestartAttempts += 1;
    await new Promise((resolve) =>
      setTimeout(resolve, ANDROID_MIRROR_RESTART_DELAY_MS)
    );
    if (generation !== this.deviceStreamGeneration || sender.isDestroyed())
      return;
    const result = await this.startDeviceStream(
      { platform: "android", deviceId },
      sender,
      {
        keepStreamId,
        isRestart: true,
      }
    );
    if (!result.success)
      console.warn(
        `[device-stream] mirror restart failed: ${result.error ?? "?"}`
      );
  }

  /**
   * Serializes operations on the same adb transport (install, launch, scrcpy
   * startup); run concurrently, both sides fail.
   */
  private async withAdbTransport<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.adbTransportQueue;
    let release = (): void => {};
    this.adbTransportQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * `streamId` scopes the stop to the stream the caller started: a superseded
   * player's teardown can land after the next player has started, and an
   * unscoped stop would kill the live stream.
   */
  stopDeviceStream(streamId?: number): void {
    if (
      streamId != null &&
      this.activeDeviceStreamId != null &&
      streamId !== this.activeDeviceStreamId
    )
      return;
    this.activeDeviceStreamId = null;
    this.scrcpyService.stop(`stopDeviceStream(${streamId ?? "all"})`);
    this.deviceStreamService.stop();
    this.iosStreamService.stop();
  }

  /**
   * Fire-and-forget touch from the mirror panel. iOS and scrcpy stream real
   * down/move/up; the screenrecord fallback reconstructs a tap or swipe.
   */
  streamDeviceTouch(request: StreamDeviceTouchRequest): void {
    if (!isValidStreamTouchRequest(request)) return;
    const { platform, deviceId, phase, x, y } = request;
    if (platform === "ios") {
      if (phase === "tap") {
        void this.deviceService
          .iosTouch(deviceId, "down", x, y)
          .then(() => this.deviceService.iosTouch(deviceId, "up", x, y))
          .catch((err) => console.debug("[DeviceMirror] iosTouch tap:", err));
      } else {
        void this.deviceService
          .iosTouch(deviceId, phase, x, y)
          .catch((err) => console.debug("[DeviceMirror] iosTouch:", err));
      }
      return;
    }
    if (phase !== "tap" && this.scrcpyService.touch(phase, x, y)) return;
    if (phase === "tap" && this.scrcpyService.touch("down", x, y)) {
      this.scrcpyService.touch("up", x, y);
      return;
    }
    // Screenrecord fallback: reconstruct the gesture from down and up.
    const w = request.deviceWidth ?? 1080;
    const h = request.deviceHeight ?? 1920;
    const px = Math.round(x * w);
    const py = Math.round(y * h);
    if (phase === "tap") {
      this.deviceService.androidTap(deviceId, px, py);
    } else if (phase === "down") {
      this.touchDragStart.set(deviceId, { x: px, y: py });
    } else if (phase === "up") {
      const start = this.touchDragStart.get(deviceId);
      this.touchDragStart.delete(deviceId);
      if (start == null) {
        this.deviceService.androidTap(deviceId, px, py);
      } else {
        const dist = Math.hypot(px - start.x, py - start.y);
        if (dist < 12) this.deviceService.androidTap(deviceId, px, py);
        else
          this.deviceService.androidSwipe(deviceId, start.x, start.y, px, py);
      }
    }
  }

  /** Fire-and-forget keyboard press from the mirror. */
  streamDeviceKey(request: StreamDeviceKeyRequest): void {
    if (!isValidStreamKeyRequest(request)) return;
    const { platform, deviceId, code, key } = request;
    const mods = {
      shift: request.shift,
      ctrl: request.ctrl,
      alt: request.alt,
      meta: request.meta,
    };
    if (platform === "ios") {
      void this.deviceService
        .iosKeyPress(deviceId, code, mods)
        .catch((err) => console.debug("[DeviceMirror] iosKeyPress:", err));
      return;
    }
    // Prefer scrcpy's control socket (~8ms) over `adb shell input` (~150ms+).
    const noMod = mods.ctrl !== true && mods.meta !== true && mods.alt !== true;
    if (noMod && key.length === 1 && this.scrcpyService.text(key)) return;
    const keycode = ANDROID_KEYCODE_BY_CODE.get(code);
    if (keycode != null && this.scrcpyService.key(keycode)) return;
    this.deviceService.androidKey(deviceId, code, key, mods);
  }
}
