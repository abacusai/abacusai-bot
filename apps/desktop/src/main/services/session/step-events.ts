/**
 * "Step done" events: the user finished, on a web page, a step a chat sent
 * them to (a connect link, a vault page, an upgrade). Each one reaches the
 * chat that asked as one hidden note, whichever way it arrives: this app's
 * own watchers while it runs, or the server, which holds the event for a
 * host that was asleep or restarted. An event is keyed by its type and the
 * step's id, so the second arrival of the same step is dropped.
 *
 * Where a step reports back is its origin, sent with the request that made
 * the link: "phone" for the WhatsApp lane, or an opaque chat ref this class
 * mints per session and maps back here. A session id never leaves the app.
 */
import { randomBytes } from "node:crypto";

import {
  connectorById,
  connectorForService,
} from "@abacus-ai/connectors/registry";

export type StepEventType =
  | "connector_connected"
  | "vault_saved"
  | "signin_decided"
  | "payment_decided"
  | "upgraded";

const STEP_EVENT_TYPES: readonly StepEventType[] = [
  "connector_connected",
  "vault_saved",
  "signin_decided",
  "payment_decided",
  "upgraded",
];

/** Short structured facts: never a password, code or card number. */
export type StepFacts = Record<string, unknown>;

export interface StepEvent {
  event: StepEventType;
  /** The step's stable id: the link's request id, the approval's id. */
  step: string;
  facts: StepFacts;
}

/** Where a session's steps report back to. */
export type OriginKind = "phone" | "chat" | null;

export interface StepEventsDeps {
  originKind: (sessionId: string) => OriginKind;
  /** The session hears the note as a hidden turn of its own. */
  deliver: (sessionId: string, note: string) => void;
  /** Runs once for each event that is not a duplicate, before its note goes. */
  landed?: (event: StepEvent) => void;
  /** The session still exists. */
  alive: (sessionId: string) => boolean;
  /** The chat refs this app minted, kept across restarts. */
  refs: {
    read: () => Record<string, string>;
    write: (refs: Record<string, string>) => void;
  };
  log?: (line: string) => void;
}

/** Steps delivered (from either path) remembered to drop the second. */
const SEEN_KEPT = 500;
/** Steps asked this run, to tell a step from before a restart. */
const ASKED_KEPT = 500;
/** Chat refs kept; the oldest goes first. */
const REFS_KEPT = 200;
const REF_RE = /^[A-Za-z0-9_-]{16,32}$/;

const TELL =
  "Confirm it to the user in one short line, in their language and your own words, then carry on with what was waiting on it.";
const RESTARTED =
  "This was asked before the app restarted, so nothing it held for this step is kept: a browser run paused for it is gone, " +
  "and an approval it needs must be asked for again. Start that part again if it is still needed.";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** A registry connector for a connector id or a platform service key. */
const connectorFor = (key: string) =>
  connectorById(key) ?? connectorForService(key);

const connectedNote = (facts: StepFacts): string => {
  const connectors = list(facts.connected).flatMap(
    (key) => connectorFor(key) ?? []
  );
  const accounts = [...new Set(list(facts.accounts))];
  const missing = list(facts.not_granted)
    .map((key) => connectorFor(key)?.name ?? key)
    .join(", ");
  const several = list(facts.not_granted).length > 1;
  const names = connectors.map((connector) => connector.name).join(", ");
  const via = (connector: (typeof connectors)[number]): string | null =>
    connector.kind === "platform" && connector.via != null
      ? connector.via
      : null;
  return (
    "[connected] " +
    (connectors.length > 0
      ? `${names} ${connectors.length > 1 ? "are" : "is"} connected now` +
        `${accounts.length > 0 ? ` (${accounts.join(", ")}): that account is who the user means by "me"` : ""}. ` +
        connectors
          .map((connector) =>
            via(connector) != null
              ? `Use ${via(connector)}: they are authenticated now. `
              : ""
          )
          .join("") +
        (connectors.some((connector) => via(connector) == null)
          ? "Its tools are in your tool list. "
          : "")
      : "") +
    (missing.length > 0
      ? `${missing} ${several ? "were" : "was"} not allowed on the provider's sign-in screen (left unticked), so ` +
        `${several ? "they are" : "it is"} not connected. Tell the user plainly, in one short line, what connected and ` +
        `what was not allowed. If what they asked for needs ${missing}, call connect_connector for it: the new link ` +
        "asks only for what is missing. Otherwise carry on with what they asked for. There is nothing to flag, report " +
        "or escalate, so never offer to."
      : TELL)
  );
};

const vaultSavedNote = (facts: StepFacts): string => {
  if (facts.outcome === "failed")
    return `[vault] Saving on the vault page failed. If it is still needed, send a new link with vault_request. ${TELL}`;
  const itemId = text(facts.item_id);
  const site = text(facts.site);
  const item = itemId != null ? ` (vault item ${itemId})` : "";
  if (facts.item_kind === "login")
    return (
      `[vault] The user saved their login${site != null ? ` for ${site}` : ""}${item}. ` +
      `To sign in, pass login_item_id ${itemId ?? "(its id from vault_items)"} to browser_task, with continue_from_last when a ` +
      "browser run is paused for this sign-in; its browser fills the username and password itself, and the values never pass through you. " +
      (facts.signin_allowed === true
        ? "Saving it allowed this first sign-in for the next 10 minutes; a later one needs signin_approval. "
        : "Each sign-in with it needs signin_approval first. ") +
      TELL
    );
  if (facts.outcome === "code_received" || facts.item_kind === "code")
    return facts.for_payment === true
      ? `[vault] The bank's code for the approved payment arrived. Have the browser fill it with browser_vault_fill, field "code" and the card's item_id${itemId != null ? ` (${itemId})` : ""}, within a few minutes. ${TELL}`
      : `[vault] The user's sign-in code${site != null ? ` for ${site}` : ""} arrived. Have the browser fill it with browser_vault_fill, field "code"${itemId != null ? ` and item_id ${itemId}` : ""}, within a few minutes. ${TELL}`;
  if (facts.item_kind === "card")
    return (
      `[vault] The user saved a card${item}. ` +
      `It is filled only under a payment they approve: payment_approval at the checkout's review step, with the exact amount. ${TELL}`
    );
  return `[vault] The vault page was completed. ${TELL}`;
};

const signinNote = (facts: StepFacts): string => {
  const site = text(facts.site) ?? "the site";
  if (facts.decision !== "allowed")
    return `[vault] The user denied signing in to ${site}. Do not sign in there; ask them how to go on. ${TELL}`;
  return (
    `[vault] The user allowed one sign-in to ${site}. For the next 5 minutes the browser can fill that ` +
    "login's username and password there, once each: call browser_task with login_item_id " +
    `${text(facts.item_id) ?? "(its id from vault_items)"} (and continue_from_last when a run is paused for this sign-in). ${TELL}`
  );
};

const paymentNote = (facts: StepFacts): string =>
  `[vault] The user approved paying ${text(facts.amount) ?? "the amount"} ${text(facts.currency) ?? ""} to ` +
  `${text(facts.merchant) ?? "the merchant"} on ${text(facts.site) ?? "the checkout"} with card ${text(facts.item_id) ?? "(the approved card)"}. ` +
  `For the next 10 minutes browser_vault_fill can fill card_number${facts.cvv_required === true ? " and cvv" : ""} on that checkout, once each. ${TELL}`;

const upgradedNote = (facts: StepFacts): string =>
  `[upgraded] The user's account just moved to ${text(facts.plan) ?? "a paid plan"}. Confirm it in one short line, in their ` +
  "language and your own words. If a task stopped on the old plan's limit, carry on with it now. Mention once that the " +
  `full AbacusAI Agent is at ${text(facts.link) ?? "their Abacus.AI account"}.`;

/**
 * The one text a step-done event is told by. `known`: this run asked for
 * the step; one from before a restart says what was lost with it.
 */
export function stepNote(event: StepEvent, known = true): string {
  switch (event.event) {
    case "upgraded":
      return upgradedNote(event.facts);
    case "connector_connected":
      return connectedNote(event.facts);
    case "vault_saved":
      return withRestart(vaultSavedNote(event.facts), known);
    case "signin_decided":
      return withRestart(signinNote(event.facts), known);
    case "payment_decided":
      return withRestart(paymentNote(event.facts), known);
  }
}

const withRestart = (note: string, known: boolean): string =>
  known ? note : `${note} ${RESTARTED}`;

/** An event as the server sends it; null when it is not one. */
export function parseStepEvent(value: unknown): StepEvent | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const event = record.event;
  const step = text(record.step);
  if (
    typeof event !== "string" ||
    !(STEP_EVENT_TYPES as readonly string[]).includes(event) ||
    step == null
  )
    return null;
  const facts =
    record.facts != null && typeof record.facts === "object"
      ? (record.facts as StepFacts)
      : {};
  return { event: event as StepEventType, step, facts };
}

export class StepEvents {
  private readonly seen = new Set<string>();
  private readonly asked = new Set<string>();
  private refs: Record<string, string> | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: StepEventsDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Where the session's step reports back: "phone", its chat ref, or
   * undefined for a session the server never reaches (the desktop app).
   */
  origin(sessionId: string | null | undefined): string | undefined {
    if (sessionId == null) return undefined;
    const kind = this.deps.originKind(sessionId);
    if (kind === "phone") return "phone";
    if (kind !== "chat") return undefined;
    const refs = this.loadRefs();
    const existing = Object.keys(refs).find((ref) => refs[ref] === sessionId);
    if (existing != null) return existing;
    const ref = randomBytes(12).toString("base64url");
    refs[ref] = sessionId;
    const keys = Object.keys(refs);
    for (const old of keys.slice(0, Math.max(0, keys.length - REFS_KEPT)))
      delete refs[old];
    try {
      this.deps.refs.write(refs);
    } catch (error) {
      this.log(`[steps] chat refs not saved: ${describe(error)}`);
    }
    return ref;
  }

  /** A step this run asked for (its link or approval was just made). */
  noteAsked(step: string): void {
    remember(this.asked, step, ASKED_KEPT);
  }

  /** The session hears the event once, from whichever path brings it first. */
  deliver(sessionId: string | null, event: StepEvent): void {
    const note = this.claim(event);
    if (note == null || sessionId == null) return;
    this.deps.deliver(sessionId, note);
  }

  /**
   * The event's note, once: null for a duplicate. The caller delivers it (a
   * message's own notes, the phone lane's entry).
   */
  claim(event: StepEvent): string | null {
    const key = `${event.event}:${event.step}`;
    if (this.seen.has(key)) return null;
    remember(this.seen, key, SEEN_KEPT);
    this.deps.landed?.(event);
    return stepNote(event, this.asked.has(event.step));
  }

  /** The server's events for chat refs: each to its session, or dropped. */
  fromServer(events: unknown): void {
    if (!Array.isArray(events)) return;
    const refs = this.loadRefs();
    for (const raw of events) {
      const event = parseStepEvent(raw);
      const ref = (raw as { chat?: unknown } | null)?.chat;
      const sessionId =
        typeof ref === "string" && REF_RE.test(ref) ? refs[ref] : undefined;
      if (event == null || sessionId == null || !this.deps.alive(sessionId)) {
        this.log(
          `[steps] dropped a ${event?.event ?? "malformed"} event: no live chat for it`
        );
        continue;
      }
      this.deliver(sessionId, event);
    }
  }

  private loadRefs(): Record<string, string> {
    if (this.refs != null) return this.refs;
    let stored: Record<string, string> = {};
    try {
      stored = this.deps.refs.read();
    } catch (error) {
      this.log(`[steps] chat refs not read: ${describe(error)}`);
    }
    this.refs = Object.fromEntries(
      Object.entries(stored).filter(
        ([ref, sessionId]) => REF_RE.test(ref) && typeof sessionId === "string"
      )
    );
    return this.refs;
  }
}

const remember = (set: Set<string>, key: string, kept: number): void => {
  set.add(key);
  if (set.size > kept) set.delete(set.values().next().value!);
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
