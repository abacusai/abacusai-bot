/**
 * The bots area (spec 03 §4): the only file routes and the shell import.
 * The chat itself is `features/chat`'s `ChatView`, composed by the route
 * with the slot builders exported here (features never import each other).
 */
export { BotsNeedsYou, BotsSidebar, BotsStrip } from "./sidebar/bots-sidebar";
export { BotsGlobals } from "./watcher";

export { BotStartPage } from "./start/bot-start-page";
export { BotSetupForm, BotEditorPage } from "./form/bot-form";
export { CheckInDialog } from "./check-in/check-in-dialog";
export {
  BotGone,
  BotPending,
  BotTranscriptIdentity,
  BotIdentity as BotChatIdentity,
} from "./chat/identity";
export { useBotChatSlots } from "./chat/slots";
export { DetailsTab, MemoryTab, FilesTab } from "./panel/bot-side-panel";
export { useBot, botsQueries } from "./data/queries";
export { loadBot, loadBotChat, loadSenderChat } from "./data/loaders";
export { forgetOpenChat } from "./data/open-chat";
export { NewBotSearch, NEW_BOT_DEFAULTS } from "./data/search";
export { selectTemplate } from "./form/draft-store";

export { getDraft } from "./form/draft-store";
export { botsGallerySections, isBotsGalleryFixture } from "./gallery/sections";

export { createBotFromTemplate } from "./data/bot-actions";

export { useBotChatActivity } from "./chat/activity";
