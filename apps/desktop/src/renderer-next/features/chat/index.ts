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
export { adoptDraftModel } from "./composer/draft-store";
export { Composer, useComposerExpanded } from "./composer/composer";
/**
 * The fixture player, for the dev fixture build only: a dynamic import, so
 * the recorded goldens never reach the shipped bundle (a call behind
 * `import.meta.env.VITE_NEXT_DB_FIXTURES === "1"` is dropped with its chunk).
 */
export const loadFixtureRuntime = async () => {
  if (import.meta.env.VITE_NEXT_DB_FIXTURES === "1")
    return (await import("./fixtures/player")).fixtureRuntime;
  throw new Error("Chat fixtures require VITE_NEXT_DB_FIXTURES=1");
};
export type {
  ComposerConfig,
  ModelChipBinding,
  ModelGroup,
  ChatViewSlots,
  MessageDecoration,
  MessageDecorationContext,
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
export const chatGallerySections =
  import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1"
    ? {
        Nav: lazy(async () => ({
          default: (await import("./gallery/sections")).chatGallerySections.Nav,
        })),
        // Scenarios, plus the Electron gates' `bench-*` fixtures (R2-T16, R2-T31).
        View: lazy(async () => ({
          default: (await import("./fixtures/perf/extension"))
            .chatGalleryWithBench.View,
        })),
      }
    : {
        Nav: (_props: { fixture: string | undefined }) => null,
        View: (_props: {
          fixture: string;
          step: number | undefined;
          play: boolean;
        }) => null,
      };

export { useThreadStore } from "./store/selectors";

export { notchAcceptable } from "./kit/permissions/notch-acceptable";
export { encodeAnswers as encodeQuestionAnswers } from "./kit/permissions/decisions";

export { runErrorCopy } from "#next/lib/attention/error-copy";
