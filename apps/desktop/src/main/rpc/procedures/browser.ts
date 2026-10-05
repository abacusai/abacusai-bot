import type { BrowserEvent } from "@abacus-ai/contract/contract";
import type { IpcEvent } from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

import { checkLocalPreviewFile } from "../../services/browser/local-preview-file";
import { forbidden } from "../errors";
import { hostFileError } from "./files";
import { impl, isType, onIpcEvents, requireMainRenderer, stream } from "./impl";

const BROWSER_EVENT_TYPES = [
  "mcp-open-preview",
  "browser-runtime-materialized",
  "mcp-cursor-move",
  "mcp-cursor-click",
  "mcp-cursor-hide",
  "browser-permission-request",
  "browser-permission-cleared",
  "browser-status-updated",
  "browser-runtime-state-updated",
] as const;

/**
 * Maps a legacy event, dropping those scoped to another conversation. An
 * event with no conversation (cursor, status, a cleared ask) goes to everyone.
 */
const toBrowserEvent =
  (key: ConversationKey | undefined) =>
  (event: IpcEvent): BrowserEvent | null => {
    const mine = (eventKey: ConversationKey | undefined): boolean =>
      key == null || eventKey == null || eventKey === key;

    switch (event.type) {
      case "mcp-open-preview":
        return mine(event.conversationKey)
          ? {
              type: "open-preview",
              ...(event.url == null ? {} : { url: event.url }),
              ...(event.conversationKey == null
                ? {}
                : { conversationKey: event.conversationKey }),
            }
          : null;
      case "browser-runtime-materialized":
        return mine(event.conversationKey)
          ? {
              type: "runtime-materialized",
              conversationKey: event.conversationKey,
              resourceId: event.resourceId,
              url: event.url,
            }
          : null;
      case "mcp-cursor-move":
        return { type: "cursor", action: "move", x: event.x, y: event.y };
      case "mcp-cursor-click":
        return { type: "cursor", action: "click" };
      case "mcp-cursor-hide":
        return { type: "cursor", action: "hide" };
      case "browser-permission-request":
        return mine(event.request.conversationKey)
          ? { type: "permission-request", request: event.request }
          : null;
      case "browser-permission-cleared":
        return { type: "permission-cleared", requestId: event.requestId };
      case "browser-status-updated":
        return { type: "status", status: event.status };
      case "browser-runtime-state-updated":
        return mine(event.state.lease.conversationKey)
          ? { type: "runtime-state", state: event.state }
          : null;
      default:
        return null;
    }
  };

/** Cursor, status and runtime state are full states: keep only the latest. */
export const browserCoalesceKey = (event: BrowserEvent): string | null => {
  switch (event.type) {
    case "cursor":
      return "cursor";
    case "status":
      return "status";
    case "runtime-state":
      return `runtime-state:${event.state.lease.conversationKey}:${event.state.lease.resourceId}`;
    default:
      return null;
  }
};

export const browserRouter = impl.browser.router({
  profiles: {
    list: impl.browser.profiles.list.handler(({ context }) =>
      context.deps.serviceHost.listBrowserProfiles()
    ),
    import: impl.browser.profiles.import.handler(({ input, context }) =>
      context.deps.serviceHost.importBrowserProfile(input.profileId)
    ),
  },
  runtime: {
    materialize: impl.browser.runtime.materialize.handler(
      ({ input, context }) => {
        requireMainRenderer(context);
        return context.deps.browserRuntime.materialize(input);
      }
    ),
    materializeFile: impl.browser.runtime.materializeFile.handler(
      async ({ input, context }) => {
        requireMainRenderer(context);
        const checked = await checkLocalPreviewFile(
          input.filePath,
          input.hostRoot,
          context.deps.serviceHost.localPreviewRoots(input.conversationKey)
        );
        // A root that is not the conversation's checkout or an artifact
        // folder: FORBIDDEN {root-not-allowed}; outside the root: FORBIDDEN
        // {outside-root}, as `files.readText`; a type the view does not
        // show: FORBIDDEN {unsupported-type}.
        if (checked.ok === false)
          throw checked.error === "unsupported-type" ||
            checked.error === "root-not-allowed"
            ? forbidden(checked.error)
            : hostFileError(input.filePath)(checked.error);
        return context.deps.browserRuntime.materializeFile({
          conversationKey: input.conversationKey,
          resourceId: input.resourceId,
          file: checked.file,
          root: checked.root,
        });
      }
    ),
    present: impl.browser.runtime.present.handler(({ input, context }) => {
      requireMainRenderer(context);
      return context.deps.browserRuntime.present(input);
    }),
    navigate: impl.browser.runtime.navigate.handler(({ input, context }) => {
      requireMainRenderer(context);
      return context.deps.browserRuntime.navigate(input);
    }),
    capture: impl.browser.runtime.capture.handler(({ input, context }) => {
      requireMainRenderer(context);
      return context.deps.browserRuntime.capture(input);
    }),
    hide: impl.browser.runtime.hide.handler(async ({ input, context }) => {
      requireMainRenderer(context);
      await context.deps.browserRuntime.hide(input);
    }),
    close: impl.browser.runtime.close.handler(async ({ input, context }) => {
      requireMainRenderer(context);
      await context.deps.browserRuntime.close(input);
    }),
    promoteScope: impl.browser.runtime.promoteScope.handler(
      ({ input, context }) => {
        requireMainRenderer(context);
        return context.deps.browserRuntime.promoteScope(input);
      }
    ),
  },
  setEngine: impl.browser.setEngine.handler(({ input, context }) =>
    context.deps.serviceHost.setBrowserEngine(input.engine)
  ),
  chrome: {
    connect: impl.browser.chrome.connect.handler(({ context }) =>
      context.deps.serviceHost.connectChromeBrowser()
    ),
    disconnect: impl.browser.chrome.disconnect.handler(({ context }) =>
      context.deps.serviceHost.disconnectChromeBrowser()
    ),
    setExtensionToken: impl.browser.chrome.setExtensionToken.handler(
      ({ input, context }) =>
        context.deps.serviceHost.setChromeExtensionToken(input.token)
    ),
  },
  status: impl.browser.status.handler(({ context }) =>
    context.deps.serviceHost.getMcpBrowserStatus()
  ),
  setEnabled: impl.browser.setEnabled.handler(({ input, context }) =>
    context.deps.serviceHost.setMcpBrowserEnabled(input.enabled)
  ),
  permissions: {
    list: impl.browser.permissions.list.handler(({ input, context }) =>
      context.deps.serviceHost.listBrowserPermissionRequests(
        input.conversationKey
      )
    ),
    setApproval: impl.browser.permissions.setApproval.handler(
      ({ input, context }) =>
        context.deps.serviceHost.setBrowserApproval(input.approval)
    ),
    respond: impl.browser.permissions.respond.handler(
      async ({ input, context }) => {
        await context.deps.serviceHost.respondBrowserPermission(input);
      }
    ),
  },
  clearData: impl.browser.clearData.handler(({ input, context }) =>
    context.deps.serviceHost.clearBrowserData(input)
  ),
  hasGoogleChrome: impl.browser.hasGoogleChrome.handler(({ context }) =>
    context.deps.app.hasGoogleChrome()
  ),
  events: impl.browser.events.handler(({ input, context, signal }) => {
    const key = input?.conversationKey;
    return stream<BrowserEvent>({
      path: "browser.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        isType(...BROWSER_EVENT_TYPES),
        toBrowserEvent(key)
      ),
      initial: () => [
        {
          type: "snapshot",
          // Keyless: every pending ask, as the live filter passes them all.
          permissionRequests:
            context.deps.serviceHost.listBrowserPermissionRequests(key),
        },
      ],
      coalesceKey: browserCoalesceKey,
    });
  }),
});
