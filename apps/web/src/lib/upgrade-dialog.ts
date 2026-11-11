import type { UpgradeSrc } from "@abacus-ai/contract/billing-plan";
import type { UIMessage } from "@tanstack/ai-client";
import { Store, useStore } from "@tanstack/react-store";

import type { AppClient } from "#renderer/data/transport/types";
import type { OwnKeyFailure } from "#renderer/lib/own-key-unavailable";
import { openUpgrade } from "#renderer/lib/upgrade";
import { hiddenUserMessage, userMessageText } from "#renderer/lib/user-message";

/**
 * The upgrade dialog over the whole window: `credits` when a free account's
 * turn stopped because its Abacus credits are used up, `connectors` when it
 * still chats on its own model key but a connector call needs Abacus credits,
 * `own-key` when a free account's turn on its own provider key failed for
 * want of credit, a rate limit, or a provider that stopped answering.
 * `plan` when a free account asked to see the plan (a See Basic, an Upgrade
 * on a card or the model picker). A paid plan out of credits gets `credits`
 * too, which offers its top-up and next plan. `balance` when the person
 * clicked what a turn cost: the plan for a free account, the top-up and next
 * plan for a paid one, neither saying the credits ran out. Triggers ask; the
 * shell's host confirms on a fresh account read and opens.
 */
export type UpgradeDialogKind =
  | "credits"
  | "connectors"
  | "own-key"
  | "plan"
  | "balance";

export interface UpgradeDialogRequest {
  kind: UpgradeDialogKind;
  /** One dialog per refusal: a run id or a tool call id. */
  key: string;
  /** The chat it came from: a dismissed connectors dialog stays dismissed there. */
  threadId: string;
  /** The user's message that waits for the upgrade, shown in the dialog. */
  pendingText?: string;
  /** `own-key`: whose key failed, and how. */
  ownKey?: OwnKeyFailure;
  /** `credits`: the free tier ended, rather than its credits running out. */
  expired?: boolean;
  /** Checkout already opened (a card's Upgrade or Top up); the dialog waits for the plan or the credits. */
  checkout?: boolean;
  /**
   * `credits`: what stopped, in the user's own words (the wall card's task).
   * Set only in a chat whose paused message can move onto a top model alone:
   * the dialog names the task and that model, and `resume` gets the model.
   */
  task?: string;
  /** Sends that message again once the plan is active, on `model` if given. */
  resume?: (model?: string) => Promise<unknown>;
  /** `plan`: the screen that asked for it (a card, the model picker). */
  src?: UpgradeSrc;
  /** `credits`: asked again after the user came back to a wall (wall-reopen.tsx). */
  reopen?: boolean;
}

/** The screens the other kinds stand for: a free account's refusal in a chat. */
const KIND_SRC: Record<
  Exclude<UpgradeDialogKind, "plan" | "balance">,
  UpgradeSrc
> = {
  credits: "credit_wall",
  connectors: "connectors",
  "own-key": "own_key",
};

/** The screen the dialog's Upgrade is opened from. */
export const dialogUpgradeSrc = (request: UpgradeDialogRequest): UpgradeSrc =>
  request.src ??
  (request.kind === "plan" || request.kind === "balance"
    ? "app"
    : KIND_SRC[request.kind]);

interface UpgradeDialogState {
  request: UpgradeDialogRequest | null;
}

export const upgradeDialogStore = new Store<UpgradeDialogState>({
  request: null,
});

const asked = new Set<string>();
/** Chats where the person chose to keep chatting without connectors. */
const connectorsDeclined = new Set<string>();
/** Chats already offered a plan for their own key: asked once per chat. */
const ownKeyAsked = new Set<string>();
/** An ask of the other kind that came while a dialog was open. */
let queued: UpgradeDialogRequest | null = null;

const show = (request: UpgradeDialogRequest | null): void => {
  if (request?.kind === "own-key") ownKeyAsked.add(request.threadId);
  upgradeDialogStore.setState(() => ({ request }));
};

const wanted = (request: UpgradeDialogRequest): boolean =>
  !(
    request.kind === "connectors" && connectorsDeclined.has(request.threadId)
  ) && !(request.kind === "own-key" && ownKeyAsked.has(request.threadId));

/**
 * Ask for the dialog. A key already asked for is ignored, and so are
 * connector asks from a chat where the person kept chatting without them and
 * own-key asks from a chat already offered one. An ask of the same kind as
 * the open dialog is dropped (a turn refusing several connectors shows one
 * dialog); one of the other kind waits its turn. `explicit` is the person
 * asking (a button in the chat), which no earlier answer holds back.
 */
export const requestUpgradeDialog = (
  request: UpgradeDialogRequest,
  explicit = false
): void => {
  if (!explicit && (asked.has(request.key) || !wanted(request))) return;
  asked.add(request.key);
  const open = upgradeDialogStore.state.request;
  if (open == null) show(request);
  else if (open.kind !== request.kind) queued = request;
};

/**
 * Close the dialog; `dismissed` when the person said no to it (Not now, Keep
 * chatting, Esc). The waiting ask, if any, opens next.
 */
export const closeUpgradeDialog = (dismissed = false): void => {
  const open = upgradeDialogStore.state.request;
  if (dismissed && open?.kind === "connectors")
    connectorsDeclined.add(open.threadId);
  const next = queued != null && wanted(queued) ? queued : null;
  queued = null;
  show(next);
};

export const useUpgradeDialogRequest = () =>
  useStore(upgradeDialogStore, (state) => state.request);

/**
 * The person asked to see the plan from `src` (a card, the model picker):
 * the dialog with its whole pitch, never a bare page.
 */
export const requestPlanDialog = (src: UpgradeSrc): void =>
  requestUpgradeDialog(
    { kind: "plan", key: `plan:${src}:${Date.now()}`, threadId: src, src },
    true
  );

/**
 * The upgrade dialog's Upgrade, from a card that already shows the whole
 * pitch: checkout opens (call it inside the click: the web build opens its
 * tab there) and the dialog waits for the plan, as after its own Upgrade.
 */
export const startPlanCheckout = (client: AppClient, src: UpgradeSrc): void => {
  void openUpgrade(client, src);
  requestUpgradeDialog(
    {
      kind: "plan",
      key: `plan:${src}:${Date.now()}`,
      threadId: src,
      checkout: true,
      src,
    },
    true
  );
};

/**
 * A card's Upgrade, Top up or next plan at the credit wall: its checkout link
 * opens (call it inside the click: the web build opens its tab there) and the
 * dialog waits for the plan or the credits, then sends the waiting message.
 */
export const startCreditsCheckout = (
  open: () => Promise<void>,
  request: Omit<UpgradeDialogRequest, "kind" | "checkout">
): void => {
  void open().catch(() => {});
  requestUpgradeDialog({ ...request, kind: "credits", checkout: true }, true);
};

/**
 * A waiting message whose chat was not on screen when the plan landed (the
 * wall asked again on return): that chat's view sends it, on `model` if
 * given, once it opens (UpgradeTriggers).
 */
export interface ResumeHandoff {
  threadId: string;
  model?: string;
}

export const resumeHandoffStore = new Store<ResumeHandoff | null>(null);

export const handOffResume = (threadId: string, model?: string): void =>
  resumeHandoffStore.setState(() => ({
    threadId,
    ...(model != null && { model }),
  }));

/** The hand-off for `threadId`, taken once. */
export const takeResumeHandoff = (threadId: string): ResumeHandoff | null => {
  const handoff = resumeHandoffStore.state;
  if (handoff?.threadId !== threadId) return null;
  resumeHandoffStore.setState(() => null);
  return handoff;
};

/** The Abacus connectors gateway's tools are named `abacus-connectors_<Tool>`. */
const CONNECTOR_TOOL_PREFIX = "abacus-connectors";
/** The gateway's refusal when the account has no Abacus credits left. */
const CONNECTOR_CREDIT_REFUSAL = /needs abacus ai credits/i;

const text = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

/** Longest task name a card title carries. */
const TASK_MAX = 60;

/**
 * What the chat is working on, in the user's own words: the newest visible
 * message longer than a few words, so a "continue" names the task it goes on
 * with. Cut to a title's length.
 */
export const taskText = (
  messages: readonly UIMessage[]
): string | undefined => {
  const texts = messages
    .filter((message) => message.role === "user" && !hiddenUserMessage(message))
    .map((message) => userMessageText(message).replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
  const text =
    texts.findLast((value) => value.split(" ").length > 3) ?? texts.at(-1);
  if (text == null) return undefined;
  return text.length <= TASK_MAX
    ? text
    : `${text.slice(0, TASK_MAX).replace(/\s+\S*$/, "")}…`;
};

/** The newest visible user message: what waits for the upgrade. */
export const lastUserText = (
  messages: readonly UIMessage[]
): string | undefined => {
  const last = messages.findLast(
    (message) => message.role === "user" && !hiddenUserMessage(message)
  );
  const value = last == null ? "" : userMessageText(last).trim();
  return value.length > 0 ? value : undefined;
};

/**
 * Connector calls the gateway refused for want of Abacus credits, in messages
 * that arrived live (`fresh`), so a reopened chat never asks again.
 */
export const connectorCreditRefusals = (
  messages: readonly UIMessage[],
  fresh: Readonly<Record<string, true>>
): string[] => {
  const refused: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || fresh[message.id] !== true) continue;
    const connectorCalls = new Set(
      message.parts
        .filter(
          (part) =>
            part.type === "tool-call" &&
            part.name.startsWith(CONNECTOR_TOOL_PREFIX)
        )
        .map((part) => (part as { id: string }).id)
    );
    for (const part of message.parts)
      if (
        part.type === "tool-result" &&
        connectorCalls.has(part.toolCallId) &&
        CONNECTOR_CREDIT_REFUSAL.test(text(part.content))
      )
        refused.push(part.toolCallId);
  }
  return refused;
};
