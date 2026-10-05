import type { UIMessage } from "@tanstack/ai-client";
import { Store, useSelector } from "@tanstack/react-store";
import { useEffect } from "react";

export interface BotActivity {
  mood: "thinking" | "talking" | null;
  runningTool: string | null;
}
const idle: BotActivity = { mood: null, runningTool: null };
const activities = new Store<Record<string, BotActivity>>({});
export const useAllBotActivity = () => useSelector(activities);
export const useBotActivity = (botId: string) =>
  useSelector(activities, (state) => state[botId] ?? idle);
const clearBotActivity = (botId: string) =>
  activities.setState((state) => {
    const { [botId]: _old, ...rest } = state;
    return rest;
  });

export const useBotChatActivity = (
  botId: string,
  messages: readonly UIMessage[],
  active: boolean
): void => {
  useEffect(() => {
    const parts = active ? (messages.at(-1)?.parts ?? []) : [];
    const last = parts.at(-1);
    const activity: BotActivity = {
      mood:
        last?.type === "thinking"
          ? "thinking"
          : last?.type === "text" && last.content.trim()
            ? "talking"
            : null,
      runningTool: last?.type === "tool-call" ? last.name : null,
    };
    activities.setState((state) => ({ ...state, [botId]: activity }));
    return () => clearBotActivity(botId);
  }, [botId, messages, active]);
};
