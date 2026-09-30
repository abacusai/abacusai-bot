/**
 * The bots area (spec 03 §4): the only file routes and the shell import.
 * The chat itself is `features/chat`'s `ChatView`, composed by the route
 * with the slot builders exported here (features never import each other).
 */
export { BotsNeedsYou, BotsSidebar, BotsStrip } from "./sidebar/bots-sidebar";
export { BotsGlobals } from "./watcher";
export {
  BotDetailsSheet,
  BotEditPage,
  BotIdentity,
  BotPage,
  BotsNewPage,
} from "./bots-pages";
