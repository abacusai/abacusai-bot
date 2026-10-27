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
 * too, which offers its top-up and next plan. Triggers ask; the shell's host
 * confirms on a fresh account read and opens.
 */
export type UpgradeDialogKind = "credits" | "connectors" | "own-key" | "plan";

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
  /** Sends that message again once the plan is active, on `model` if given. */
  resume?: (model?: string) => Promise<unknown>;
}

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
 * The person asked to see the plan from `source` (a card, the model picker):
 * the dialog with its whole pitch, never a bare page.
 */
export const requestPlanDialog = (source: string): void =>
  requestUpgradeDialog(
    { kind: "plan", key: `plan:${source}:${Date.now()}`, threadId: source },
    true
  );

/**
 * The upgrade dialog's Upgrade, from a card that already shows the whole
 * pitch: checkout opens (call it inside the click: the web build opens its
 * tab there) and the dialog waits for the plan, as after its own Upgrade.
 */
export const startPlanCheckout = (client: AppClient, source: string): void => {
  void openUpgrade(client);
  requestUpgradeDialog(
    {
      kind: "plan",
      key: `plan:${source}:${Date.now()}`,
      threadId: source,
      checkout: true,
    },
    true
  );
};

/**
 * A paid account's Top up or next plan, from a card: its link opens (call it
 * inside the click: the web build opens its tab there) and the dialog waits
 * for the credits or the plan, then sends the waiting message.
 */
export const startPaidCheckout = (
  open: () => Promise<void>,
  request: Omit<UpgradeDialogRequest, "kind" | "checkout">
): void => {
  void open().catch(() => {});
  requestUpgradeDialog({ ...request, kind: "credits", checkout: true }, true);
};

/** The Abacus connectors gateway's tools are named `abacus-connectors_<Tool>`. */
const CONNECTOR_TOOL_PREFIX = "abacus-connectors";
/** The gateway's refusal when the account has no Abacus credits left. */
const CONNECTOR_CREDIT_REFUSAL = /needs abacus ai credits/i;

const text = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

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
