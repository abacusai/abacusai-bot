/**
 * Everything the router reaches (spec 00 A.4.1), passed in rather than
 * imported, so the router and its procedures load without Electron: the
 * WebSocket smoke test runs them with `electron` made to throw on import.
 *
 * The procedures are thin: validate, call the same ServiceHost method or
 * named operation the legacy IPC handler calls, map the result.
 */
import type { AccountState } from "@abacus-ai/contract/account";
import type {
  NotificationMetadata,
  SetDensityResult,
  WindowChromeState,
  WindowState,
} from "@abacus-ai/contract/contract";
import type { PickedFile } from "@abacus-ai/contract/contract/system";
import type {
  BrowserRuntimeLease,
  DeviceBuildPhase,
  DeviceStreamChunk,
  HideBrowserRuntimeRequest,
  MaterializeBrowserRuntimeRequest,
  NavigateBrowserRuntimeRequest,
  OpenFilePathResult,
  PresentBrowserRuntimeRequest,
  PromoteBrowserRuntimeScopeRequest,
  BrowserRuntimeState,
  BrowserRuntimeCapture,
} from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";
import type { PptxReadResult } from "@abacus-ai/contract/pptx";
import type {
  ImportLocalSkillsRequest,
  ImportLocalSkillsResult,
} from "@abacus-ai/contract/skills-types";
import type { UpdateStatus } from "@abacus-ai/contract/update";

import type { HostOperations } from "../handler";
import type { CueArbiter } from "../notch/cue-arbiter";
import type { ServiceHost } from "../service-host";
import type { LoginItem } from "../services/config/login-item";
import type { AguiSource, ThreadReader } from "./ai/source";
import type { MainEventBus } from "./event-bus";
import type { ReadinessReport } from "./readiness";
import type { Tables } from "./tables";

type HostFileArgs = { filePath?: string; hostRoot?: string };

/** The top-level `window.api` handlers' bodies (main/index.ts). */
export interface AppOperations {
  listDirectory?(
    path?: string
  ): Promise<import("@abacus-ai/contract/contract/files").DirectoryListing>;
  mkdir?(path: string, name: string): Promise<{ path: string }>;
  openFolderDialog(): Promise<string | null>;
  openFilesDialog(
    kind?: "all" | "image" | "theme"
  ): Promise<PickedFile[] | null>;
  openExternal(url: string): Promise<void>;
  openFilePath(filePath: string): Promise<OpenFilePathResult>;
  showItemInFolder(filePath: string): void;
  appVersion(): string;
  homeDir(): string;
  /** Where the app keeps its own files. */
  botHome(): string;
  restartApp(): void;
  deleteAllData(): void;
  /** `once`: the persisted first-time report (`reportFunnelStepOnce`). */
  reportFunnelStep(step: unknown, detail: unknown, once?: boolean): void;
  account: {
    get(): AccountState;
    skip(): AccountState;
    signOut(): AccountState;
    forget(): AccountState;
  };
  savePastedTempFiles(
    baseFolder: string,
    files: Array<{ name: string; data: Uint8Array }>
  ): Promise<{
    success: boolean;
    dir?: string;
    paths?: string[];
    error?: string;
  }>;
  saveLogs(
    rendererLogs: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }>;
  appendLogs(lines: unknown): void;
  showNotification(
    title: string,
    body: string,
    metadata?: NotificationMetadata,
    attention?: { kind?: "needs-you" | "done" | "failed"; dedupeKey?: string }
  ): void;
  readImageAsDataUrl(args: HostFileArgs): Promise<{
    success: boolean;
    dataUrl?: string;
    mimeType?: string;
    sizeBytes?: number;
    error?: string;
  }>;
  readFileAsText(args: HostFileArgs & { maxBytes?: number }): Promise<{
    success: boolean;
    content?: string;
    sizeBytes?: number;
    truncated?: boolean;
    error?: string;
  }>;
  readPptx(args: HostFileArgs): Promise<PptxReadResult>;
  importLocalSkills(
    request: ImportLocalSkillsRequest
  ): Promise<ImportLocalSkillsResult>;
  showAboutPanel(): void;
  /**
   * `settings:set-titlebar-density`'s body: persist, then (wco) refresh and
   * publish the chrome and recreate the window on macOS.
   */
  setTitlebarDensity(value: unknown): Promise<SetDensityResult>;
  /** Open at login (macOS, Windows). */
  loginItem: LoginItem;
  /** The user-input beacon the renderer swap defers on. */
  markRendererActivity(): void;
}

/** The browser runtime's legacy channels, restricted to the main renderer. */
export interface BrowserRuntimeOperations {
  materialize(
    request: MaterializeBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> | BrowserRuntimeState;
  /** A checked local file (real paths; spec 04 §12.8). */
  materializeFile(request: {
    conversationKey: ConversationKey;
    resourceId: string;
    file: string;
    root: string;
  }): Promise<BrowserRuntimeState> | BrowserRuntimeState;
  present(
    request: PresentBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> | BrowserRuntimeState;
  navigate(
    request: NavigateBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> | BrowserRuntimeState;
  capture(
    lease: BrowserRuntimeLease
  ): Promise<BrowserRuntimeCapture> | BrowserRuntimeCapture;
  hide(request: HideBrowserRuntimeRequest): Promise<void> | void;
  close(lease: BrowserRuntimeLease): Promise<void> | void;
  promoteScope(
    request: PromoteBrowserRuntimeScopeRequest
  ): Promise<BrowserRuntimeLease[]> | BrowserRuntimeLease[];
}

/** Window facts, scoped by the webContents a port belongs to. */
export interface RpcWindows {
  /** The live main renderer's webContents id; the browser runtime's owner. */
  mainRendererId(): number | null;
  /** The webContents behind an id, for pushes that go to one window. */
  contents(webContentsId: number): Electron.WebContents | null;
  state(webContentsId: number): WindowState | null;
  /** The native chrome state `window:chrome` serves the legacy renderer. */
  chrome(webContentsId: number): WindowChromeState | null;
  reportReady(webContentsId: number, report: ReadinessReport): void;
}

/** State the event iterators snapshot on (re)open that no service keeps. */
export interface EventTrackers {
  deviceBuild(): { phase: DeviceBuildPhase; error?: string } | null;
  /**
   * A device stream's current group of pictures: its last key frame and
   * every chunk since, oldest first; empty before the first key frame.
   */
  deviceStreamReplay(streamId: number): DeviceStreamChunk[];
}

export interface RpcDeps {
  serviceHost: ServiceHost;
  host: HostOperations;
  app: AppOperations;
  browserRuntime: BrowserRuntimeOperations;
  update: {
    checkForUpdates(): Promise<{ success: boolean; error?: string }>;
    installUpdate(): Promise<{ success: boolean; error?: string }>;
    getStatus(): UpdateStatus;
  };
  windows: RpcWindows;
  bus: MainEventBus;
  ai: AguiSource;
  /** The DB tables' feeds and the prefs store (spec 00 B). */
  tables: Tables;
  /** The thread store (`ServiceHost.threadStore`); optional for test deps. */
  threads?: ThreadReader;
  trackers: EventTrackers;
  /** `window.claimCue` / `window.visibleThread` (spec 06 §14.2). */
  cues: CueArbiter;
  notch?: import("../notch/controller").NotchController;
}
