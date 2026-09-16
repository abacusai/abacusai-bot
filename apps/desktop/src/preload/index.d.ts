import type { AccountState } from "#shared/account";
import type { AgentApi, OpenFilePathResult } from "#shared/contracts";
import type { PptxReadResult } from "#shared/pptx";
import type {
  ImportLocalSkillsRequest,
  ImportLocalSkillsResult,
  InstallSkillRequest,
  ListInstalledSkillsRequest,
  ListInstalledSkillsResult,
  OpenSkillFileRequest,
  RemoveSkillRequest,
  SearchMarketplaceSkillsRequest,
  SearchMarketplaceSkillsResult,
  SkillMutationResult,
} from "#shared/skills-types";
import type { UpdateStatus } from "#shared/update";

// Lets a clicked OS notification focus the originating session.
export type NotificationMetadata = {
  workspaceId?: string;
  sessionId?: string;
};

interface PowerAPI {
  getKeepAwake: () => Promise<boolean>;
  setKeepAwake: (enabled: boolean) => Promise<boolean>;
  setAgentBusy: (busy: boolean) => Promise<void>;
}

interface UpdateAPI {
  check: () => Promise<{ success: boolean; error?: string }>;
  install: () => Promise<{ success: boolean; error?: string }>;
  getStatus: () => Promise<UpdateStatus>;
  onStatusChange: (callback: (status: UpdateStatus) => void) => () => void;
}

interface CustomAPI {
  platform: NodeJS.Platform;
  isFullScreen: () => Promise<boolean>;
  onFullScreenChange: (callback: (fullScreen: boolean) => void) => () => void;
  showAboutPanel: () => Promise<void>;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<boolean>;
  openFolderDialog: () => Promise<string | null>;
  openFilesDialog: (kind?: "all" | "image") => Promise<Array<{
    path: string;
    name: string;
    data: Buffer;
    mimeType: string;
  }> | null>;
  readClipboardImage: () => Promise<{
    name: string;
    data: Buffer;
    mimeType: string;
  } | null>;
  fetchUrlAttachment: (url: string) => Promise<{
    success: boolean;
    file?: { name: string; data: Buffer; mimeType: string };
    error?: string;
  }>;

  openExternal: (url: string) => Promise<void>;

  openFilePath: (filePath: string) => Promise<OpenFilePathResult>;

  showItemInFolder: (filePath: string) => Promise<void>;

  getAppVersion: () => Promise<string>;
  restartApp: () => Promise<void>;

  getHomeDir: () => Promise<string>;
  /** Whether Chrome is installed where Playwright's default channel looks. */
  hasGoogleChrome: () => Promise<boolean>;

  // Local account (optional sign-in; see apps/desktop/src/shared/account.ts)
  getAccountState: () => Promise<AccountState>;
  skipAccountOnboarding: () => Promise<AccountState>;
  signOutAccount: () => Promise<AccountState>;
  /** Sign-out plus forgetting onboarding: the flow runs again from the top. */
  forgetAccount: () => Promise<AccountState>;
  savePastedTempFiles: (
    baseFolder: string,
    files: Array<{ name: string; data: Uint8Array }>
  ) => Promise<{
    success: boolean;
    dir?: string;
    paths?: string[];
    error?: string;
  }>;

  saveLogs: (
    rendererLogs: string
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;

  appendLogs: (lines: string[]) => void;

  showNotification: (
    title: string,
    body: string,
    metadata?: NotificationMetadata
  ) => Promise<void>;
  onNotificationClicked: (
    callback: (metadata: NotificationMetadata) => void
  ) => () => void;

  power: PowerAPI;

  update: UpdateAPI;

  agent: AgentApi;

  skills: {
    listInstalled: (
      request: ListInstalledSkillsRequest
    ) => Promise<ListInstalledSkillsResult>;
    searchMarketplace: (
      request: SearchMarketplaceSkillsRequest
    ) => Promise<SearchMarketplaceSkillsResult>;
    install: (request: InstallSkillRequest) => Promise<SkillMutationResult>;
    remove: (request: RemoveSkillRequest) => Promise<SkillMutationResult>;
    openFile: (request: OpenSkillFileRequest) => Promise<SkillMutationResult>;
    importLocal: (
      request: ImportLocalSkillsRequest
    ) => Promise<ImportLocalSkillsResult>;
  };

  files: {
    readImageAsDataUrl: (args: {
      filePath: string;
      hostRoot: string;
    }) => Promise<{
      success: boolean;
      dataUrl?: string;
      mimeType?: string;
      sizeBytes?: number;
      error?: string;
    }>;

    readFileAsText: (args: {
      filePath: string;
      hostRoot: string;
      maxBytes?: number;
    }) => Promise<{
      success: boolean;
      content?: string;
      sizeBytes?: number;
      truncated?: boolean;
      error?: string;
    }>;

    readPptx: (args: {
      filePath: string;
      hostRoot: string;
    }) => Promise<PptxReadResult>;
  };

  // File.path was removed in Electron 32+.
  getPathForFile: (file: File) => string;

  versions: NodeJS.ProcessVersions;

  // Owned by main; a null snapshot means no store and the renderer falls back
  // to localStorage. Optional: an older shell's preload predates these.
  durableState?: {
    snapshot: Record<string, string> | null;
    set: (key: string, value: string) => void;
    remove: (key: string) => void;
    clear: () => void;
  };

  // User-input beacon; the renderer swap defers while input is recent.
  reportUiActivity?: () => void;

  // First React commit done; a renderer swap flips only after this.
  signalRendererReady?: () => void;
}

declare global {
  interface Window {
    api: CustomAPI;
  }
}
export {};
