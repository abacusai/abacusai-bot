/**
 * The bot loop: the forever-chat engine running a bot's profile. See
 * forever/engine.ts for the loop and bot-profile.ts for what makes it a bot.
 */
import { ForeverEngine, type ForeverEngineOptions } from "../forever/engine.js";
import { createBotProfile } from "./bot-profile.js";

export { botBashTool } from "./bot-profile.js";

export type BotSessionOptions = ForeverEngineOptions;

export class BotSession extends ForeverEngine {
  constructor(options: BotSessionOptions) {
    super(options, createBotProfile());
  }
}
