/**
 * The `cronjob` tool's hosted half: the input a hosted create reads, how a
 * hosted routine reads back in `list`, and what the model is told when the
 * server refuses one. Every refusal is an instruction to the model, never
 * text pinned onto its reply: it says it in the user's language.
 */
import type {
  HostedRoutineDelivery,
  HostedRoutineKind,
  HostedRoutineNotify,
  RoutineCreateInput,
  RoutineListItem,
  RoutineRead,
  RoutineRunner,
} from "@abacus-ai/contract/routines";

import type { HostedRoutineRefusal } from "../../agent-tools/hosted-routines";
import { isRoutineRead } from "../../agent-tools/routine-reach";

const KINDS: readonly HostedRoutineKind[] = [
  "reminder",
  "task",
  "watch",
  "event",
];

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** `runner` as the model passed it, or null for the app's default. */
export const requestedRunner = (
  args: Record<string, unknown>
): RoutineRunner | null =>
  args.runner === "hosted" || args.runner === "local" ? args.runner : null;

/** The sources the model named: `sources`, or the older `source_hosts`. */
export const requestedSources = (args: Record<string, unknown>): string[] =>
  [args.sources, args.source_hosts].flatMap((value) =>
    Array.isArray(value)
      ? value.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0
        )
      : []
  );

/** The account data the model asked the routine to read. */
export const requestedReads = (args: Record<string, unknown>): RoutineRead[] =>
  Array.isArray(args.reads)
    ? [...new Set(args.reads.filter(isRoutineRead))]
    : [];

/**
 * A hosted create's input from the tool's arguments, and a one-time moment
 * as the user's words gave it (sent as is: without an offset it is wall time
 * in the routine's zone). The kind is the one named, else read off what was
 * given: reminder text, a watch page, a webhook alone.
 */
export const hostedCreateInput = (
  args: Record<string, unknown>,
  botId: string | null
): { input: RoutineCreateInput; runAtText: string | null } => {
  const reminderText = text(args.reminder_text);
  const watchUrl = text(args.watch_url);
  const schedule = text(args.schedule);
  const runAtText = text(args.run_at);
  const kind: HostedRoutineKind = KINDS.includes(args.kind as HostedRoutineKind)
    ? (args.kind as HostedRoutineKind)
    : reminderText != null
      ? "reminder"
      : watchUrl != null
        ? "watch"
        : args.webhook === true && schedule == null && runAtText == null
          ? "event"
          : "task";
  return {
    runAtText,
    input: {
      runner: "hosted",
      kind,
      name: text(args.name) ?? undefined,
      prompt: text(args.prompt) ?? reminderText ?? "",
      schedule,
      runAt: null,
      webhook: args.webhook === true,
      timezone: text(args.timezone),
      // Only what the user chose: otherwise the server's default for the kind.
      ...(args.notify === "relevant" || args.notify === "always"
        ? { notify: args.notify as HostedRoutineNotify }
        : {}),
      delivery: (["whatsapp", "email", "panel"].includes(String(args.delivery))
        ? args.delivery
        : "default") as HostedRoutineDelivery,
      sources: requestedSources(args),
      reads: requestedReads(args),
      watchUrl,
      reminderText,
      botId,
    },
  };
};

/** A hosted routine as `list` shows it. */
export const describeHostedRoutine = (routine: RoutineListItem): string => {
  const info = routine.hosted;
  const when =
    routine.schedule ??
    (routine.runAt != null
      ? new Date(routine.runAt).toISOString()
      : "on event");
  const next =
    routine.nextRunAt != null ? new Date(routine.nextRunAt).toISOString() : "—";
  const last = info?.lastRun;
  return [
    `${routine.id}  [${routine.enabled ? "enabled" : `paused${info?.pausedReason != null ? `: ${info.pausedReason}` : ""}`}]  hosted ${info?.kind ?? "task"}  ${when} (${info?.timezone ?? "UTC"})  ${routine.name}`,
    `  ${routine.prompt}`,
    `  reads: ${[...(info?.reads ?? []), ...(info?.sources ?? [])].join(", ") || "search only"}${info?.pendingConfirmation === true ? "   [waiting for the user's approval]" : ""}`,
    `  next: ${next}   last: ${last?.at != null ? `${new Date(last.at).toISOString()} ${last.status}${last.deliveredVia != null ? ` via ${last.deliveredVia}` : ""}` : "never"}`,
  ].join("\n");
};

/**
 * What the model says of a routine waiting for approval: the server sends
 * the owner the link itself, so the model never holds or writes one.
 */
export const approvalNote = (routine: RoutineListItem): string =>
  routine.hosted?.pendingConfirmation !== true
    ? ""
    : `Waiting for the user's approval: a link to allow "${routine.name}" was sent to them (on WhatsApp, else by email). Tell them so in one line, in their language, and that it starts once they allow it. If they did not get it, "approval_link" with its id sends it again. Never write a link for it yourself. `;

/**
 * The model's note after a hosted create: confirm it, offer a test run, never
 * run it. In the WhatsApp chat (no pane) results arrive in that chat. A
 * routine waiting for the user's approval starts only once they give it, at
 * a link the server sends them.
 */
export const hostedCreatedNote = (
  routine: RoutineListItem,
  inPhoneChat: boolean
): string => {
  const approval = routine.hosted?.pendingConfirmation === true;
  return (
    "Created on the server: it runs on its own, even while nothing is open. " +
    (inPhoneChat
      ? "Its results arrive in this chat, or by email when this chat cannot take them. "
      : "Its results reach the user on WhatsApp when it is linked, else by email. ") +
    (approval
      ? "It does NOT start until the user allows it themselves. " +
        approvalNote(routine)
      : "") +
    "Confirm it to the user in one line, in their language: what it does, when, in " +
    "which time zone, what it may read, and where results arrive. It has NOT run yet: " +
    'offer one test run ("run" with its id) only if they want it' +
    (approval ? ", once it is approved" : "") +
    ", and do not do the routine's work here.\n\n" +
    describeHostedRoutine(routine)
  );
};

/** The upgrade the server offered with a refusal, or a plain mention of one. */
const upgradeLine = (details: Record<string, unknown>): string => {
  const upgrade = (details.upgrade ?? {}) as Record<string, unknown>;
  const link = text(upgrade.url);
  const plan = text(upgrade.plan_name);
  const price = text(upgrade.price_text);
  return link == null
    ? "Upgrading to a paid plan allows more (do not quote a price)."
    : `${[plan, price].filter((part) => part != null).join(", ")}: ${link}`;
};

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** An interval in words the model can pass on: minutes or hours. */
const interval = (secs: number): string =>
  secs % 3600 === 0
    ? `${secs / 3600} hour(s)`
    : `${Math.round(secs / 60)} minute(s)`;

/**
 * What the model is told when the server refused a routine (the server
 * sends codes and facts, never sentences). Each is said once, in the user's
 * language; nothing here is user-facing text.
 */
export const hostedRefusalNote = (
  refusal: HostedRoutineRefusal,
  /** What was being done: a create, or an action on an existing routine. */
  action: string = "create"
): string => {
  const details = refusal.details;
  const nothing =
    action === "create" ? "Nothing was created" : "Nothing was changed";
  switch (refusal.code) {
    case "plan_limit": {
      // The free plan's limits. Only "one routine, already used" is the
      // upgrade's moment; a kind or an interval is how the free plan works.
      const kind = text(details.kind);
      const minInterval = count(details.min_interval_secs);
      if (minInterval != null)
        return `[${nothing.toLowerCase()}: free plan] On the free plan a routine runs at most once every ${interval(minInterval)}. Tell the user, in their language, and offer that interval instead.`;
      if (kind != null && count(details.limit) == null)
        return `[${nothing.toLowerCase()}: free plan] The free plan includes reminders and one scheduled routine; a routine started by an email or a webhook, or one that watches a page (this one is "${kind}"), needs a paid plan. Tell the user once, in their language, and offer a scheduled routine or a reminder instead.`;
      return [
        `[${nothing.toLowerCase()}: free plan limit] The free plan includes one routine that runs on its own, and the user already has it.`,
        "Tell the user once, in their language, that the free plan includes one routine",
        "and that upgrading allows more, with the offer and its link:",
        upgradeLine(details),
        "Do not repeat it later in this conversation.",
      ].join("\n");
    }
    case "limit": {
      const limit = count(details.limit);
      return (
        `[${nothing.toLowerCase()}] The user's plan allows ` +
        (limit != null
          ? `${limit} routines of this kind`
          : "no more routines of this kind") +
        " and they are all in use. Tell them briefly, in their language, and offer to pause or remove one."
      );
    }
    case "no_host":
      return "[not done] The user's hosted bot is not set up yet. Tell them, in their language, to open AbacusAI Bot on the web once, then ask again.";
    case "timezone_required":
    case "invalid_timezone":
      return `[${nothing.toLowerCase()}] The routine needs the user's time zone as an IANA name (e.g. Asia/Kolkata). Ask them where they are, then try again with timezone.`;
    case "invalid_schedule":
      return `[${nothing.toLowerCase()}] The schedule is not valid: a five-field cron, or run_at in the future. Fix it and try again.`;
    case "interval_too_short": {
      const secs = count(details.min_interval_secs);
      return `[${nothing.toLowerCase()}] It may run at most once every ${secs != null ? interval(secs) : "hour"}. Pick a longer interval (ask the user if it matters) and try again. Do not call this a plan limit unless a refusal says so.`;
    }
    case "invalid_source_url":
    case "invalid_url":
      return `[${nothing.toLowerCase()}] A page given for it cannot be used (an http(s) address on a public name, no port, not a site anyone can publish on). Ask the user for another, or go without it.`;
    case "invalid_connector_reads":
      return `[${nothing.toLowerCase()}] Account reads are "gmail.search", "gmail.read" or "calendar.read". Ask only for what the routine needs and try again.`;
    case "wrong_bot":
      return "[not done] That routine belongs to another of the user's bots; this one may not change it.";
    case "not_pending":
      return "[not done] That routine is not waiting for approval.";
    case "busy":
      return "[not done] The routine was being changed at that moment. Try once more.";
    case "queue_full":
      return "[not started] This routine has too many runs waiting. Do not start another; tell the user briefly, in their language.";
    case "invalid_bot_id":
    case "invalid_event":
    case "invalid_notify":
    case "invalid_delivery":
    case "unsupported_kind":
    case "name_required":
    case "prompt_required":
    case "reminder_text_required":
      return `[${nothing.toLowerCase()}] The request was refused (${refusal.code}). Fix that argument and try again; do not mention the code to the user.`;
    case "not_found":
      return "[not done] That routine no longer exists. Use list to see the user's routines.";
    case "already_queued":
      return "[not started] A run of this routine is already on its way; its result reaches the user as usual. Do not start another.";
    case "routine_completed":
      return "[not done] This one-time routine has already run. To run it again, update it with a new run_at.";
    case "routine_not_active":
      return '[not done] This routine is paused, or waits for the user to allow it. If it waits, have the link sent again ("approval_link" with its id); otherwise resume it first if the user wants it to run.';
    case "not_available":
      return `[${nothing.toLowerCase()}] Routines that run on their own are not available for this account right now. Tell the user briefly, in their language.`;
    default:
      return "[not done] The server could not do that right now. Tell the user briefly, in their language, and offer to try again later.";
  }
};
