import type { HomeChannel } from "@abacus-ai/contract/bots";
import type { BotRow } from "@abacus-ai/contract/contract";
import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { Store } from "@tanstack/react-store";

import { isRpcError } from "#renderer/data/query-client";
import type { Transport } from "#renderer/data/transport";
import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import {
  BOT_TEMPLATES,
  TEMPLATE_FOR_CONNECTOR,
} from "#renderer/lib/bots/templates";
import { subscribeRunFinished } from "#renderer/lib/run-finished";

import { onboardingStore } from "./store";
/** A first-run pick. Each makes what it needs and leaves onboarding, except `images`. */
export type FirstChoice =
  | { kind: "build"; prompt: string | null }
  | { kind: "chat-app"; app: HomeChannel }
  | { kind: "research" }
  | { kind: "goal"; goal: string }
  | { kind: "images" }
  | { kind: "bot"; botId: string };

export type FirstBotResult = {
  bot: BotRow;
  checkInRoutineId: string | null;
  preview?: boolean;
};
/** A chat app's own agent template (WhatsApp Agent and the like). */
export const chatAppTemplateId = (app: HomeChannel): string => {
  const agent = TEMPLATE_FOR_CONNECTOR[`messaging-${app}`];
  if (agent == null || !BOT_TEMPLATES.some((row) => row.id === agent))
    throw new Error(`No agent template for ${app}.`);
  return agent;
};
/**
 * The "Research or write" pick's goal, as GOAL_MISSION words. No topic is
 * named yet, and a first reply that asks for one is the one left
 * unanswered: the bot starts on a sample and the user names their own next.
 */
export const RESEARCH_GOAL =
  "Research or write something for me: a report, a deck or a document, " +
  "using the web or files on this computer. I have not named a topic yet, " +
  "and do not ask me for one first: start with a short sample (a one-page " +
  "brief) on a topic you pick from what you know about me or the files " +
  "here, else something timely and broadly useful, and I will name my own next";
/** A chat app just connected in onboarding: its card leads the first-run choices. */
export const noteConnectedChatApp = (chatApp: HomeChannel): void => {
  onboardingStore.setState((state) => ({ ...state, chatApp }));
};
/**
 * `choose`: no inbox to show, so the person picks what to do first.
 * `ready`: the Chief of Staff made after a Gmail sign-in, working on the inbox.
 */
export type FirstBotState =
  | { state: "idle" }
  | { state: "pending"; promise: Promise<FirstBotResult | null> }
  | { state: "choose" }
  | { state: "ready"; result: FirstBotResult }
  | { state: "skipped"; reason: "has_bots" | "no_template" | "create_failed" }
  | { state: "removed" };
export const firstBotStore = new Store<FirstBotState>({ state: "idle" });
export const ensureFirstBot = (
  ownsBot: boolean,
  create: (id: string) => Promise<FirstBotResult | null>
): void => {
  if (firstBotStore.state.state !== "idle") return;
  if (ownsBot) {
    firstBotStore.setState(() => ({ state: "skipped", reason: "has_bots" }));
    return;
  }
  const id = `bot-${crypto.randomUUID()}`;
  onboardingStore.setState((state) => ({ ...state, createdBotId: id }));
  // Store the pending state before invoking a mutation, including synchronous callbacks.
  let begin!: () => void;
  const promise = new Promise<FirstBotResult | null>((resolve) => {
    begin = () => {
      void create(id)
        .then((result) => {
          firstBotStore.setState(() =>
            result == null ? { state: "choose" } : { state: "ready", result }
          );
          resolve(result);
        })
        .catch((error) => {
          firstBotStore.setState(() => ({
            state: "skipped",
            reason:
              isRpcError(error) && error.code === "NOT_FOUND"
                ? "no_template"
                : "create_failed",
          }));
          resolve(null);
        });
    };
  });
  firstBotStore.setState(() => ({ state: "pending", promise }));
  begin();
};

/** The Chief of Staff's first inbox pass, as the first-run screen shows it. */
export type InboxPass =
  | { state: "reading" }
  | { state: "done"; drafts: number }
  /** The pass ended on an error; its chat says why. */
  | { state: "stopped" };
export const inboxPassStore = new Store<InboxPass>({ state: "reading" });

const DRAFT_ACTIONS = new Set(["create_draft_reply", "create_draft_email"]);

/** Reply drafts the pass saved: one per email that needs the user. */
export const countDraftReplies = (messages: readonly UIMessage[]): number =>
  messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => messageTools(message))
    .filter(
      (tool) =>
        tool.settled &&
        typeof tool.input.action === "string" &&
        DRAFT_ACTIONS.has(tool.input.action)
    ).length;

/**
 * Follows the bot chat's first run to its end. Subscribed before the chat
 * opens, so a run that finishes before `chat` resolves is still seen.
 */
export const watchInboxPass = (
  transport: Transport,
  chat: Promise<{ sessionId: string }>
): (() => void) => {
  inboxPassStore.setState(() => ({ state: "reading" }));
  const early: RunFinishedNotice[] = [];
  let sessionId: string | null = null;
  let settled = false;
  const settle = async (notice: RunFinishedNotice) => {
    if (settled) return;
    settled = true;
    stop();
    if (notice.outcome !== "success") {
      inboxPassStore.setState(() => ({ state: "stopped" }));
      return;
    }
    try {
      const page = await transport.client.ai.hydrate({
        threadId: notice.threadId,
      });
      inboxPassStore.setState(() => ({
        state: "done",
        drafts: countDraftReplies(page.messages),
      }));
    } catch {
      inboxPassStore.setState(() => ({ state: "stopped" }));
    }
  };
  const stop = subscribeRunFinished(transport, (notice) => {
    if (sessionId == null) early.push(notice);
    else if (notice.threadId === sessionId) void settle(notice);
  });
  void chat.then(
    (handle) => {
      sessionId = handle.sessionId;
      const seen = early.find((notice) => notice.threadId === sessionId);
      if (seen) void settle(seen);
    },
    () => {
      settled = true;
      stop();
      inboxPassStore.setState(() => ({ state: "stopped" }));
    }
  );
  return () => {
    settled = true;
    stop();
  };
};
