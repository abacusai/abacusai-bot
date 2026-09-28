import type { ConversationKey } from "#shared/conversation-scope";

import {
  browserResourceActions,
  browserResourceStore,
  selectBrowserResourceScope,
  type BrowserResourceId,
} from "../stores/browser-resource-store";
import {
  previewActions,
  previewTabId,
  type PreviewItem,
} from "../stores/preview-store";
import {
  rightPanelActions,
  rightPanelStore,
} from "../stores/right-panel-react";
import {
  createResourceRightPanelDescriptor,
  selectRightPanelScope,
  type RightPanelDescriptor,
  type RightPanelResourceType,
} from "../stores/right-panel-store";

const previewResourceType = (item: PreviewItem): RightPanelResourceType => {
  if (item.type === "image") return "image";
  if (item.type === "file" || item.type === "md") return "file";
  if (item.type === "pdf" || item.type === "pptx") return "document";
  return "artifact";
};

/**
 * The browser a URL tab shows: the one it names, the one its tab already
 * has, or a new one. The resource follows the item's URL and title either way.
 */
const browserFor = (
  scope: ConversationKey,
  tabId: string,
  item: PreviewItem
): BrowserResourceId => {
  const browsers = selectBrowserResourceScope(
    browserResourceStore.state,
    scope
  );
  const named = browsers.resourceIds.find((id) => `browser:${id}` === tabId);
  const tab = selectRightPanelScope(
    rightPanelStore.state,
    scope
  ).descriptors.find(({ id }) => id === tabId);
  const held =
    tab?.kind === "resource" &&
    tab.resourceType === "browser" &&
    browsers.resources[tab.resourceKey] != null
      ? (tab.resourceKey as BrowserResourceId)
      : undefined;
  const existing = named ?? held;
  if (existing != null) {
    browserResourceActions.update(scope, existing, {
      url: item.location,
      title: item.title,
    });
    return existing;
  }
  return browserResourceActions.create(scope, {
    url: item.location,
    title: item.title,
  });
};

/**
 * Open an item as a tab of a conversation's right pane and put it on screen.
 * One call does both halves (the preview store keeps the item, the
 * right-panel store gets the tab and makes it active), so the two never
 * disagree about what is showing.
 */
export const openPreviewTab = (
  scope: ConversationKey,
  item: PreviewItem
): void => {
  const { id, dropped } = previewActions.open(scope, item);
  for (const gone of dropped) rightPanelActions.close(scope, gone);

  const descriptor: RightPanelDescriptor =
    item.type === "url"
      ? createResourceRightPanelDescriptor({
          id,
          resourceType: "browser",
          resourceKey: browserFor(scope, id, item),
          title: item.title,
        })
      : createResourceRightPanelDescriptor({
          id,
          resourceType: previewResourceType(item),
          resourceKey: id,
          title: item.title,
        });
  rightPanelActions.focus(scope, descriptor);
};

export { previewTabId };
