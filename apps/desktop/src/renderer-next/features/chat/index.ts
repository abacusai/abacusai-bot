/**
 * The chat kit (spec 02): the only file routes import. Other features never
 * import it; cross-area pieces arrive through `ChatView`'s props and slots.
 */
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
export { chatGallerySections } from "./gallery/sections";
export { fixtureRuntime } from "./fixtures/player";
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

export type { SubmissionEnvelope } from "./runtime/admission";
export { updateDraft, clearDraft, draftStore } from "./composer/draft-store";
