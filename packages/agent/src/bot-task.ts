/**
 * How a task another bot passed on for the user opens in the doing bot's
 * chat. Written only by the app (BotAskService); the agent reads it so that
 * the user's own messages wait while such a turn runs instead of being
 * steered into it, which would mix them into the task's report.
 */
export const BOT_TASK_PREFIX = "[task from the user, passed on by ";

/** Whether a prompt is a task another bot passed on. */
export const isBotTask = (message: string): boolean =>
  message.startsWith(BOT_TASK_PREFIX);
