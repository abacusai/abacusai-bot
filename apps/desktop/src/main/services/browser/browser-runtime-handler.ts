import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { IpcChannels } from "#shared/channels";
import type {
  BrowserRuntimeLease,
  HideBrowserRuntimeRequest,
  MaterializeBrowserRuntimeRequest,
  NavigateBrowserRuntimeRequest,
  PresentBrowserRuntimeRequest,
  PromoteBrowserRuntimeScopeRequest,
} from "#shared/contracts";
import type { ConversationKey } from "#shared/conversation-scope";

import type { ElectronBrowserRuntime } from "./electron-browser-runtime";

type BrowserRuntimeHandlers = Pick<
  ElectronBrowserRuntime,
  | "materialize"
  | "present"
  | "navigate"
  | "capture"
  | "hide"
  | "close"
  | "promoteScope"
  | "disposeScope"
  | "disposeWorkspace"
>;

const assertOwner = (
  event: IpcMainInvokeEvent,
  ownerWebContentsId: () => number | null
): void => {
  const ownerId = ownerWebContentsId();
  if (ownerId == null || event.sender.id !== ownerId) {
    throw new Error("Browser runtime IPC is restricted to the main renderer");
  }
};

export const registerBrowserRuntimeIpcHandlers = (
  runtime: BrowserRuntimeHandlers,
  ownerWebContentsId: () => number | null
): void => {
  const handle = <Args extends unknown[], Result>(
    channel: IpcChannels,
    callback: (...args: Args) => Result
  ): void => {
    ipcMain.handle(channel, (event, ...args: Args) => {
      assertOwner(event, ownerWebContentsId);
      return callback(...args);
    });
  };

  handle(
    IpcChannels.MaterializeBrowserRuntime,
    (request: MaterializeBrowserRuntimeRequest) => runtime.materialize(request)
  );
  handle(
    IpcChannels.PresentBrowserRuntime,
    (request: PresentBrowserRuntimeRequest) => runtime.present(request)
  );
  handle(
    IpcChannels.NavigateBrowserRuntime,
    (request: NavigateBrowserRuntimeRequest) => runtime.navigate(request)
  );
  handle(IpcChannels.CaptureBrowserRuntime, (lease: BrowserRuntimeLease) =>
    runtime.capture(lease)
  );
  handle(IpcChannels.HideBrowserRuntime, (request: HideBrowserRuntimeRequest) =>
    runtime.hide(request)
  );
  handle(IpcChannels.CloseBrowserRuntime, (lease: BrowserRuntimeLease) =>
    runtime.close(lease)
  );
  handle(
    IpcChannels.PromoteBrowserRuntimeScope,
    (request: PromoteBrowserRuntimeScopeRequest) =>
      runtime.promoteScope(request)
  );
  handle(
    IpcChannels.DisposeBrowserRuntimeScope,
    (conversationKey: ConversationKey) => runtime.disposeScope(conversationKey)
  );
  handle(IpcChannels.DisposeBrowserRuntimeWorkspace, (workspaceId: string) =>
    runtime.disposeWorkspace(workspaceId)
  );
};
