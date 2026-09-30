/**
 * The chat kit (spec 02): the only file routes import. Other features never
 * import it; cross-area pieces arrive through `ChatView`'s props and slots.
 */
import { lazy } from "react";

export {
  chatRuntimeFor,
  createChatRuntime,
  type ChatRuntime,
} from "./runtime/runtime";
export { ChatView, type ChatViewProps } from "./kit/view";
export { useThreadHost } from "./runtime/host";
export { deriveSessionTitle } from "./runtime/send";
export { PermissionList } from "./kit/permissions/permission-list";
export { Composer, useComposerExpanded } from "./composer/composer";
/**
 * The fixture player, for the dev fixture build only: a dynamic import, so
 * the recorded goldens never reach the shipped bundle (a call behind
 * `import.meta.env.VITE_NEXT_DB_FIXTURES === "1"` is dropped with its chunk).
 */
export const loadFixtureRuntime = async () =>
  (await import("./fixtures/player")).fixtureRuntime;
export type {
  ComposerConfig,
  ModelChipBinding,
  ModelGroup,
  ChatViewSlots,
} from "./kit/context";
export type {
  AgentState,
  PermissionDescriptor,
  QueueEntry,
  ThreadSkin,
  ThreadStoreState,
} from "./store/thread-store";

/**
 * The `/__ui` gallery entries (spec 02 §11.2), loaded on first render: the
 * gallery replays recorded scenarios, and a static import would put every
 * golden into the chunk the router loads at start-up.
 */
export const chatGallerySections = {
  Nav: lazy(async () => ({
    default: (await import("./gallery/sections")).chatGallerySections.Nav,
  })),
  View: lazy(async () => ({
    default: (await import("./gallery/sections")).chatGallerySections.View,
  })),
};
