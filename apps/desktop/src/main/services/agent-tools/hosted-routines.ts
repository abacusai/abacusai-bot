/**
 * Hosted routines: routines the server keeps and times, run on the user's
 * hosted bot (or, for a reminder, sent by the server with no run at all).
 * This is the client for `/v1/abacusaibot_routines` and a cache of the
 * account's hosted routines for the Routines panel and the `cronjob` tool.
 *
 * An old server has no such endpoint: `capability()` answers false, and
 * everything stays local exactly as before.
 */
import type {
  RoutineRead,
  HostedRoutineDelivery,
  HostedRoutineKind,
  HostedRoutineNotify,
  HostedRoutineRun,
  RoutineListItem,
} from "@abacus-ai/contract/routines";

import { cleanSources, readsFromConnectorReads } from "./routine-reach";

/** Prefix that marks a hosted routine's id in the Routines table. */
export const HOSTED_ROUTINE_PREFIX = "hosted-";

export const isHostedRoutineId = (id: string): boolean =>
  id.startsWith(HOSTED_ROUTINE_PREFIX);

export const hostedServerId = (id: string): string =>
  id.slice(HOSTED_ROUTINE_PREFIX.length);

/** A hosted routine as the server lists it. Unknown fields are ignored. */
export interface HostedRoutineWire {
  id: string;
  kind?: HostedRoutineKind;
  name?: string;
  prompt?: string | null;
  reminder_text?: string | null;
  schedule?: {
    cron?: string | null;
    at?: string | number | null;
    timezone?: string | null;
  } | null;
  status?: string;
  enabled?: boolean;
  paused_reason?: string | null;
  notify?: HostedRoutineNotify;
  delivery?: HostedRoutineDelivery;
  /** URL prefixes its runs may read under. */
  source_urls?: string[];
  /** Older servers: bare hosts. */
  source_hosts?: string[];
  /** The account data its runs may read (`gmail`, `calendar`); none by default. */
  connector_reads?: unknown;
  /** The bot that made it, if a bot did. */
  owner_bot_id?: string | null;
  watch_url?: string | null;
  next_run_at?: string | number | null;
  created_at?: string | number | null;
  last_run?: HostedRoutineRunWire | null;
  webhook_url?: string | null;
}

export interface HostedRoutineRunWire {
  id?: string;
  routine_id?: string;
  name?: string;
  /** queued | running | done | failed */
  status?: string;
  at?: string | number | null;
  finished_at?: string | number | null;
  delivered_via?: string | null;
  delivered?: boolean;
  run_summary?: string | null;
  /** missed, timeout, payment_required, plan_limit, no_host, ... */
  failure_reason?: string | null;
}

/** What creating a hosted routine sends. */
export interface HostedRoutineCreate {
  kind: HostedRoutineKind;
  name: string;
  prompt?: string;
  reminderText?: string;
  cron?: string | null;
  /**
   * A one-time routine's moment: epoch ms, or the text the user's words gave
   * (ISO 8601; without an offset it is wall time in `timezone`), sent as is.
   */
  at?: number | string | null;
  timezone?: string | null;
  notify?: HostedRoutineNotify;
  delivery?: HostedRoutineDelivery;
  /** URL prefixes its runs may read under. */
  sources?: readonly string[];
  /** The account data its runs may read; none unless given. */
  reads?: readonly RoutineRead[];
  /** The bot that made it: only that bot sees and changes it. */
  ownerBotId?: string | null;
  watchUrl?: string | null;
  /** A job moved from this computer: a one-time moment that passed is kept. */
  migrated?: boolean;
  /**
   * The model asked (the cronjob tool). Only "agent" is ever sent; the server
   * refuses "user" from a bot key.
   */
  createdBy?: "agent";
  /** An event routine's source; a migrated webhook keeps its local token. */
  event?: {
    source: "webhook" | "gmail";
    localToken?: string;
    /** gmail: {from_contains?, subject_contains?, replies_only?}. */
    filter?: Record<string, unknown>;
  };
  idempotencyKey: string;
}

/** Why the server would not do it, as a stable code; `plan_limit` among them. */
export class HostedRoutineRefusal extends Error {
  constructor(
    readonly code: string,
    /** What came with the refusal (an upgrade offer, say); data, never shown raw. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(`The server refused the routine (${code}).`);
    this.name = "HostedRoutineRefusal";
  }
}

export type RoutinesCall = (
  body: Record<string, unknown>,
  timeoutMs?: number
) => Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> }
>;

/** `/v1/abacusaibot_routines`, posted with the user's Abacus key. */
export const routinesTransport =
  (options: {
    baseUrl: () => string;
    key: () => string | null;
    userAgent: () => string;
    fetch?: typeof fetch;
  }): RoutinesCall =>
  async (body, timeoutMs = 20_000) => {
    const key = options.key();
    if (key == null) return { ok: false, status: 401, body: {} };
    const response = await (options.fetch ?? fetch)(
      `${options.baseUrl()}/abacusaibot_routines`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "user-agent": options.userAgent(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return response.ok
      ? { ok: true, body: payload }
      : { ok: false, status: response.status, body: payload };
  };

/**
 * A routine's reach on the wire: prefixes, the bare hosts an older server
 * reads, and the connector actions its reads grant.
 */
const reachBody = (
  sources: readonly string[],
  reads: readonly RoutineRead[]
): Record<string, unknown> => {
  return {
    source_urls: cleanSources(sources).sources,
    connector_reads: [...new Set(reads)],
  };
};

/** How long a `busy` answer waits before its one retry. */
const BUSY_RETRY_MS = 1_000;

/** The calling bot, on a write: the server refuses another bot's routine. */
const botField = (botId: string | null): Record<string, string> =>
  botId != null ? { bot_id: botId } : {};

/** A moment as the server takes it: text the user's words gave goes as is. */
const wireTime = (at: number | string): string =>
  typeof at === "string" ? at : new Date(at).toISOString();

/** How long a capability answer stands before it is asked again. */
const CAPABILITY_TTL_MS = 10 * 60_000;

const epochMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** The server's refusal code; every refusal carries one, so a bare status is "unavailable". */
const refusalCode = (_status: number, body: Record<string, unknown>): string =>
  typeof body.code === "string" && body.code.length > 0
    ? body.code
    : "unavailable";

/** A run as the panel shows it. */
export const toHostedRun = (wire: HostedRoutineRunWire): HostedRoutineRun => ({
  id: String(wire.id ?? ""),
  routineId:
    wire.routine_id != null
      ? `${HOSTED_ROUTINE_PREFIX}${wire.routine_id}`
      : null,
  name: wire.name ?? null,
  // A failed run says why; that reason is the status the panel words.
  status:
    wire.status === "failed"
      ? (wire.failure_reason ?? "failed")
      : (wire.status ?? "unknown"),
  at: epochMs(wire.finished_at) ?? epochMs(wire.at),
  deliveredVia: wire.delivered_via ?? null,
  delivered: typeof wire.delivered === "boolean" ? wire.delivered : null,
  summary: wire.run_summary ?? null,
});

/** A hosted routine as a Routines table row. */
export const toRoutineListItem = (wire: HostedRoutineWire): RoutineListItem => {
  const lastRun = wire.last_run != null ? toHostedRun(wire.last_run) : null;
  const at = epochMs(wire.schedule?.at);
  return {
    id: `${HOSTED_ROUTINE_PREFIX}${wire.id}`,
    name: wire.name ?? "",
    schedule: wire.schedule?.cron ?? null,
    runAt: wire.schedule?.cron == null ? at : null,
    webhookToken: null,
    prompt: wire.prompt ?? wire.reminder_text ?? "",
    workspaceId: null,
    botId: wire.owner_bot_id ?? null,
    // Only an active routine runs: paused or done is off.
    enabled:
      wire.status != null ? wire.status === "active" : (wire.enabled ?? true),
    createdAt: epochMs(wire.created_at) ?? 0,
    lastRunAt: lastRun?.at ?? null,
    lastResult: lastRun?.summary ?? lastRun?.status ?? null,
    runs: [],
    nextRunAt: epochMs(wire.next_run_at),
    webhookUrl: wire.webhook_url ?? null,
    webhookPublicPending: false,
    botName: null,
    runner: "hosted",
    hosted: {
      kind: wire.kind ?? "task",
      timezone: wire.schedule?.timezone ?? null,
      notify: wire.notify ?? "always",
      delivery: wire.delivery ?? "default",
      sources:
        wire.source_urls ??
        (wire.source_hosts ?? []).map((host) => `https://${host}/`),
      reads: readsFromConnectorReads(wire.connector_reads),
      watchUrl: wire.watch_url ?? null,
      pausedReason: wire.paused_reason ?? null,
      lastRun,
    },
  };
};

/** How many created rows keep the id their creator gave them. */
const CREATED_AS_MAX = 50;

export class HostedRoutines {
  /** `answered`: the server knows the endpoint, even with routines switched off. */
  private capable: { value: boolean; answered: boolean; at: number } | null =
    null;
  private asking: Promise<boolean> | null = null;
  private cached: RoutineListItem[] = [];

  constructor(
    private readonly options: {
      call: RoutinesCall;
      /** Whether the user's Abacus key is set; nothing is asked without one. */
      hasKey: () => boolean;
      /** The cached list changed. */
      onChanged?: () => void;
      now?: () => number;
      log?: (line: string) => void;
    }
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.options.log ?? console.warn)(line);
  }

  /**
   * Whether the server keeps routines for this account: false on any
   * failure, an old server, or no key, so callers fall back to local.
   */
  async capability(): Promise<boolean> {
    if (!this.options.hasKey()) return false;
    if (
      this.capable != null &&
      this.now() - this.capable.at < CAPABILITY_TTL_MS
    )
      return this.capable.value;
    this.asking ??= (async () => {
      let value = false;
      let answered = false;
      try {
        const result = await this.options.call({ action: "capabilities" });
        answered = result.ok;
        value = result.ok && result.body.hosted_routines === true;
      } catch (error) {
        this.log(`[routines] capabilities failed: ${describe(error)}`);
      }
      this.capable = { value, answered, at: this.now() };
      return value;
    })().finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  /**
   * Whether the server answers for routines at all: with them switched off
   * it still lists, pauses and deletes the ones it keeps. False on an old server.
   */
  async reachable(): Promise<boolean> {
    await this.capability();
    return this.capable?.answered === true;
  }

  /** The last answer, without asking: false until one came back true. */
  capableNow(): boolean {
    return this.capable?.value === true;
  }

  /** Each row created here, by the id its creator gave it; the newest few. */
  private readonly createdAs = new Map<string, string>();

  private rememberCreatedAs(id: string, key: string): void {
    this.createdAs.delete(id);
    this.createdAs.set(id, key);
    // Only an optimistic row's echo needs it: the oldest go first.
    for (const old of this.createdAs.keys()) {
      if (this.createdAs.size <= CREATED_AS_MAX) break;
      this.createdAs.delete(old);
    }
  }

  /** The cached rows, for the Routines table. */
  list(): RoutineListItem[] {
    return this.cached.map((routine) => {
      const createdAs = this.createdAs.get(routine.id);
      return createdAs == null || routine.hosted == null
        ? routine
        : { ...routine, hosted: { ...routine.hosted, createdAs } };
    });
  }

  find(id: string): RoutineListItem | null {
    return this.list().find((routine) => routine.id === id) ?? null;
  }

  /** Re-read the account's hosted routines; the cache stays on failure. */
  async refresh(): Promise<RoutineListItem[]> {
    if (!(await this.reachable())) return this.cached;
    try {
      const result = await this.options.call({ action: "list" });
      if (result.ok === false) return this.cached;
      const wire = Array.isArray(result.body.routines)
        ? (result.body.routines as HostedRoutineWire[])
        : [];
      this.cached = wire
        .filter((routine) => typeof routine?.id === "string")
        .map(toRoutineListItem);
      this.options.onChanged?.();
    } catch (error) {
      this.log(`[routines] list failed: ${describe(error)}`);
    }
    return this.cached;
  }

  /** Create on the server; a refusal throws HostedRoutineRefusal. */
  async create(input: HostedRoutineCreate): Promise<RoutineListItem> {
    const body: Record<string, unknown> = {
      action: "create",
      kind: input.kind,
      name: input.name,
      ...(input.prompt != null ? { prompt: input.prompt } : {}),
      ...(input.reminderText != null
        ? { reminder_text: input.reminderText }
        : {}),
      // An event routine has no schedule at all, not an empty one.
      ...(input.cron != null || input.at != null
        ? {
            schedule: {
              ...(input.cron != null ? { cron: input.cron } : {}),
              ...(input.at != null ? { at: wireTime(input.at) } : {}),
              ...(input.timezone != null ? { timezone: input.timezone } : {}),
            },
          }
        : {}),
      ...(input.notify != null ? { notify: input.notify } : {}),
      ...(input.delivery != null ? { delivery: input.delivery } : {}),
      ...reachBody(input.sources ?? [], input.reads ?? []),
      ...(input.ownerBotId != null ? { owner_bot_id: input.ownerBotId } : {}),
      ...(input.migrated === true ? { migrated: true } : {}),
      ...(input.createdBy != null ? { created_by: input.createdBy } : {}),
      ...(input.watchUrl != null ? { watch_url: input.watchUrl } : {}),
      ...(input.event != null
        ? {
            event: {
              source: input.event.source,
              ...(input.event.localToken != null
                ? { local_token: input.event.localToken }
                : {}),
              ...(input.event.filter != null
                ? { filter: input.event.filter }
                : {}),
            },
          }
        : {}),
      idempotency_key: input.idempotencyKey,
    };
    const routine = await this.write(body, input.idempotencyKey);
    if (routine == null) throw new HostedRoutineRefusal("unavailable");
    return this.find(routine.id) ?? routine;
  }

  async update(
    id: string,
    changes: {
      name?: string;
      prompt?: string;
      cron?: string | null;
      at?: number | string | null;
      timezone?: string;
      sources?: readonly string[];
      reads?: readonly RoutineRead[];
      watchUrl?: string;
    },
    /** The calling bot, when a bot's chat is asking: refused for another bot's routine. */
    botId: string | null = null
  ): Promise<RoutineListItem | null> {
    // A schedule goes whole: a zone alone keeps the routine's own cron or
    // moment, read from the cached row.
    const current = this.find(id);
    if (
      changes.timezone != null &&
      changes.cron == null &&
      changes.at == null &&
      current?.schedule == null &&
      current?.runAt == null
    )
      throw new HostedRoutineRefusal("invalid_schedule", {
        reason: "zone_without_schedule",
      });
    // A reminder's words are its reminder text; it runs no prompt.
    const reminder = current?.hosted?.kind === "reminder";
    const cron =
      changes.cron ?? (changes.at == null ? current?.schedule : null);
    const at =
      changes.at ??
      (changes.cron == null && current?.schedule == null
        ? (current?.runAt ?? null)
        : null);
    const schedule =
      changes.cron != null || changes.at != null || changes.timezone != null
        ? {
            ...(cron != null ? { cron } : {}),
            ...(cron == null && at != null ? { at: wireTime(at) } : {}),
            ...(changes.timezone != null ? { timezone: changes.timezone } : {}),
          }
        : null;
    return this.write({
      action: "update",
      id: hostedServerId(id),
      ...botField(botId),
      ...(changes.name != null ? { name: changes.name } : {}),
      ...(changes.prompt != null
        ? reminder
          ? { reminder_text: changes.prompt }
          : { prompt: changes.prompt }
        : {}),
      ...(schedule != null ? { schedule } : {}),
      ...(changes.sources != null || changes.reads != null
        ? reachBody(changes.sources ?? [], changes.reads ?? [])
        : {}),
      ...(changes.watchUrl != null ? { watch_url: changes.watchUrl } : {}),
    });
  }

  setEnabled(
    id: string,
    enabled: boolean,
    botId: string | null = null
  ): Promise<RoutineListItem | null> {
    return this.write({
      action: enabled ? "resume" : "pause",
      id: hostedServerId(id),
      ...botField(botId),
    });
  }

  async remove(id: string, botId: string | null = null): Promise<void> {
    await this.write({
      action: "delete",
      id: hostedServerId(id),
      ...botField(botId),
    });
    this.cached = this.cached.filter((routine) => routine.id !== id);
    this.options.onChanged?.();
  }

  async runNow(id: string, botId: string | null = null): Promise<void> {
    await this.write({
      action: "run_now",
      id: hostedServerId(id),
      ...botField(botId),
    });
  }

  async runs(id: string, limit = 20): Promise<HostedRoutineRun[]> {
    const result = await this.options.call({
      action: "runs",
      id: hostedServerId(id),
      limit,
    });
    if (result.ok === false)
      throw new HostedRoutineRefusal(refusalCode(result.status, result.body));
    return Array.isArray(result.body.runs)
      ? (result.body.runs as HostedRoutineRunWire[]).map(toHostedRun)
      : [];
  }

  /**
   * Runs that finished at or after `since` (ISO 8601), oldest first, and the
   * server's own `now`, which is the next read's `since`. The same run can
   * come back; callers dedupe by id.
   */
  async feed(
    since: string
  ): Promise<{ runs: HostedRoutineRun[]; now: string | null }> {
    const result = await this.options.call({ action: "feed", since });
    if (result.ok === false) return { runs: [], now: null };
    const runs = Array.isArray(result.body.runs)
      ? (result.body.runs as HostedRoutineRunWire[]).map(toHostedRun)
      : [];
    return {
      runs,
      now: typeof result.body.now === "string" ? result.body.now : null,
    };
  }

  /**
   * One write: a refusal throws, a routine in the answer replaces its cached
   * row, and the list is re-read either way so the panel catches up.
   */
  private async write(
    body: Record<string, unknown>,
    /** A create's own idempotency key, remembered for its row; see createdAs. */
    createdAs: string | null = null
  ): Promise<RoutineListItem | null> {
    let result = await this.options.call(body);
    // The routine was mid-change on the server: once more, after a beat.
    if (
      result.ok === false &&
      refusalCode(result.status, result.body) === "busy"
    ) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      result = await this.options.call(body);
    }
    if (result.ok === false)
      throw new HostedRoutineRefusal(
        refusalCode(result.status, result.body),
        result.body
      );
    const wire = result.body.routine as HostedRoutineWire | undefined;
    const routine =
      wire != null && typeof wire.id === "string"
        ? toRoutineListItem(wire)
        : null;
    if (routine != null) {
      // Remembered before the panel hears of the row, so its echo carries it.
      if (createdAs != null) this.rememberCreatedAs(routine.id, createdAs);
      this.cached = [
        ...this.cached.filter((entry) => entry.id !== routine.id),
        routine,
      ];
      this.options.onChanged?.();
    }
    void this.refresh();
    return routine;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
