/**
 * Everything the router reaches (spec 00 A.4.1), passed in rather than
 * imported, so the router and its procedures load without Electron: the
 * WebSocket smoke test runs them with `electron` made to throw on import.
 *
 * The procedures are thin: validate, call the same ServiceHost method or
 * named operation the legacy IPC handler calls, map the result.
 */
import type { AccountState } from "#shared/account";
import type { WindowState } from "#shared/contract";
import type {
  BrowserRuntimeLease,
  DeviceBuildPhase,
  HideBrowserRuntimeRequest,
  MaterializeBrowserRuntimeRequest,
  NavigateBrowserRuntimeRequest,
  OpenFilePathResult,
  PresentBrowserRuntimeRequest,
  PromoteBrowserRuntimeScopeRequest,
  BrowserRuntimeState,
  BrowserRuntimeCapture,
} from "#shared/contracts";
import type { PptxReadResult } from "#shared/pptx";
import type {
  ImportLocalSkillsRequest,
  ImportLocalSkillsResult,
} from "#shared/skills-types";
import type { UpdateStatus } from "#shared/update";

import type { HostOperations } from "../handler";
import type { ServiceHost } from "../service-host";
import type { AguiSource, ThreadReader } from "./ai/source";
import type { MainEventBus } from "./event-bus";
import type { ReadinessReport } from "./readiness";

type HostFileArgs = { filePath?: string; hostRoot?: string };

/** The top-level `window.api` handlers' bodies (main/index.ts). */
export interface AppOperations {
  openFolderDialog(): Promise<string | null>;
  openFilesDialog(kind?: "all" | "image"): Promise<Array<{
    path: string;
    name: string;
    data: Uint8Array;
    mimeType: string;
  }> | null>;
  openExternal(url: string): Promise<void>;
  openFilePath(filePath: string): Promise<OpenFilePathResult>;
  showItemInFolder(filePath: string): void;
  appVersion(): string;
  homeDir(): string;
  /** Where the app keeps its own files. */
  botHome(): string;
  restartApp(): void;
  hasGoogleChrome(): boolean;
  reportFunnelStep(step: unknown, detail: unknown): void;
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
    metadata?: { workspaceId?: string; sessionId?: string }
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
  /** The user-input beacon the renderer swap defers on. */
  markRendererActivity(): void;
}

/** The browser runtime's legacy channels, restricted to the main renderer. */
export interface BrowserRuntimeOperations {
  materialize(
    request: MaterializeBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> | BrowserRuntimeState;
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
  reportReady(webContentsId: number, report: ReadinessReport): void;
}

/** State the event iterators snapshot on (re)open that no service keeps. */
export interface EventTrackers {
  deviceBuild(): { phase: DeviceBuildPhase; error?: string } | null;
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
  rendererState: {
    snapshot(): Record<string, string>;
    set(key: string, value: string | null): void;
    clear(): void;
  };
  windows: RpcWindows;
  bus: MainEventBus;
  ai: AguiSource;
  /** Absent until the thread store (sub-slice C) lands. */
  threads?: ThreadReader;
  trackers: EventTrackers;
}
