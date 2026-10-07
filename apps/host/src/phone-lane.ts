import { randomUUID } from "node:crypto";

import {
  PHONE_PROGRESS_TOOL_NAME,
  splitPhoneBubbles,
} from "@abacus-ai/agent/phone-bubbles";
import {
  AgentStatus,
  type DesktopEvent,
} from "@abacus-ai/contract/agent-types";
import { isMessageReaction } from "@abacus-ai/contract/message-reactions";

import { backoffDelayMs } from "#main/services/messaging/connector";

/**
 * The hosted bot's WhatsApp number: a long-poll of the account's phone inbox
 * (`/v1/abacusaibot_channels`, lane "phone") feeding one lifelong phone-loop
 * session. Messages close together become one turn; one that arrives while
 * a turn runs steers it. The reply goes back as WhatsApp bubbles against the
 * newest message. Host-only: the desktop app never builds one.
 */

type ChannelsCall = <T>(
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<T>;

interface PhoneInboxEntry {
  id: string;
  ts?: number;
  channel?: string;
  sender?: string | null;
  text?: string;
  /**
   * "linked": the user just linked WhatsApp; `sender` is their name there.
   * "note": the host's own news for the loop (a connector connected), never
   * from the server, so never acknowledged.
   */
  kind?: string;
}

interface PhoneLaneDeps {
  call: ChannelsCall;
  /** Whether the user's Abacus key is configured; the lane idles without it. */
  hasKey: () => boolean;
  /** The phone loop's session, minted on first use. */
  openSession: () => Promise<{ workspaceId: string; sessionId: string }>;
  /** False when the message could not be delivered. */
  send: (
    workspaceId: string,
    sessionId: string,
    text: string
  ) => Promise<boolean>;
  onAgentEvent: (
    listener: (sessionId: string, payload: DesktopEvent) => void
  ) => () => void;
  /** Keeps the host's idle lease fresh. */
  activity: () => void;
  log?: (line: string) => void;
}

const PHONE_LANE_TIMINGS = {
  /** Messages this close together become one turn. */
  batchMs: 3_000,
  /** WhatsApp's "typing…" lasts about 25 s. */
  typingRefreshMs: 20_000,
  bubblePauseMinMs: 800,
  bubblePauseMaxMs: 1_200,
  /** A turn with no end in sight is given up, as the host forces idle. */
  turnTimeoutMs: 10 * 60_000,
  /** How often to look for a key while signed out. */
  keyWaitMs: 5_000,
  /** Waits between delivery attempts: three tries over about a minute. */
  deliveryRetryMs: [15_000, 45_000],
  /** After an idle with a steer still unheard: how long to wait for it to run. */
  steerGraceMs: 30_000,
};

/** The server holds an inbox poll open for at most this long. */
const INBOX_WAIT_SECS = 25;
const CALL_TIMEOUT_MS = 20_000;
const SEEN_IDS_KEPT = 500;
const REACT_TOOL = "react_to_message";
/** What the user hears when a turn fails: never silence, never the raw error. */
const FAILURE_REPLY =
  "Sorry, something went wrong on my side. Could you send that again?";

/** What the loop is told for one inbox entry. */
function phoneTurnText(entry: PhoneInboxEntry): string {
  if (entry.kind !== "linked") return entry.text ?? "";
  const name = entry.sender?.trim();
  return name
    ? `[linked] The user just connected WhatsApp. Their WhatsApp name: ${name}.`
    : "[linked] The user just connected WhatsApp.";
}

/** A message steered into the running turn; `landed` once the session took it in. */
type Steer = { entry: PhoneInboxEntry; text: string; landed: boolean };

type Turn = {
  /** Null until the session opens. */
  workspaceId: string | null;
  sessionId: string | null;
  /** The newest message: replies, typing and reactions go against it. */
  replyTo: string;
  /** The batch's own newest message, for when a steer falls back. */
  batchReplyTo: string;
  steers: Steer[];
  /** The batch's inbox entries, acknowledged once the turn has answered them. */
  ids: string[];
  startedAt: number;
  messages: number;
  /** The session started this turn; idles before it belong to housekeeping. */
  submitted: boolean;
  /** The assistant message being written, and the last one with words. */
  text: string;
  textMessageId: string | null;
  lastText: string;
  /** Sub-agent runs open now; their words are working notes, never sent early. */
  subtasks: number;
  textInSubtask: boolean;
  lastTextInSubtask: boolean;
  /** Messages the user received this turn: bubbles and progress lines. */
  sent: number;
  typing: NodeJS.Timeout | null;
  timeout: NodeJS.Timeout | null;
  /** Armed by an idle with a steer unheard: the steer's own run should start. */
  steerGrace: NodeJS.Timeout | null;
  ended: boolean;
};

export class PhoneLane {
  private readonly timings: typeof PHONE_LANE_TIMINGS;
  private readonly log: (line: string) => void;
  private running = false;
  private pollAbort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending: PhoneInboxEntry[] = [];
  private lastArrivalAt = 0;
  private batchTimer: NodeJS.Timeout | null = null;
  private turn: Turn | null = null;
  private readonly seen = new Set<string>();
  /** This start's first poll asks the server for everything still unanswered. */
  private redeliver = true;
  /** Names this start to the server, so a replaced host's open poll stops taking messages. */
  private poller = randomUUID();
  /** The newest message from the user: a turn of notes alone replies against it. */
  private lastInboundId: string | null = null;
  /** Steers go to the session one at a time, in arrival order. */
  private steering: Promise<void> = Promise.resolve();
  /** Everything said to the user goes out in order: progress, early replies, the answer. */
  private outbox: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: PhoneLaneDeps,
    timings: Partial<typeof PHONE_LANE_TIMINGS> = {}
  ) {
    this.timings = { ...PHONE_LANE_TIMINGS, ...timings };
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** A phone turn is running or being delivered. */
  get busy(): boolean {
    return this.turn != null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.redeliver = true;
    this.poller = randomUUID();
    this.unsubscribe = this.deps.onAgentEvent((sessionId, payload) =>
      this.onAgentEvent(sessionId, payload)
    );
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.pollAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.batchTimer != null) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (this.turn != null) this.clearTurnTimers(this.turn);
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      if (!this.deps.hasKey()) {
        await sleep(this.timings.keyWaitMs);
        continue;
      }
      const abort = new AbortController();
      this.pollAbort = abort;
      try {
        const result = await this.deps.call<{ messages?: PhoneInboxEntry[] }>(
          {
            action: "inbox",
            wait: INBOX_WAIT_SECS,
            lane: "phone",
            poller: this.poller,
            ...(this.redeliver ? { redeliver: true } : {}),
          },
          (INBOX_WAIT_SECS + 15) * 1000,
          abort.signal
        );
        failures = 0;
        this.redeliver = false;
        for (const entry of result.messages ?? []) this.arrive(entry);
      } catch (error) {
        if (!this.running) return;
        failures += 1;
        this.log(
          `[phone] inbox poll failed (attempt ${failures}): ${describe(error)}`
        );
        await sleep(backoffDelayMs(failures));
      } finally {
        if (this.pollAbort === abort) this.pollAbort = null;
      }
    }
  }

  /**
   * One inbox entry, with "typing…" shown now: steered into the running turn
   * when it can take it, else queued for the next.
   */
  arrive(entry: PhoneInboxEntry): void {
    if (typeof entry.id !== "string") return;
    if (this.seen.has(entry.id)) {
      // Back from the server: answered, but the ack was lost (or is on its way).
      if (!this.inFlight(entry.id)) void this.ack([entry.id]);
      return;
    }
    if (entry.kind !== "linked" && !entry.text?.trim()) {
      void this.ack([entry.id]);
      return;
    }
    this.seen.add(entry.id);
    if (this.seen.size > SEEN_IDS_KEPT)
      this.seen.delete(this.seen.values().next().value!);
    this.lastInboundId = entry.id;
    this.lastArrivalAt = Date.now();
    void this.channel("typing", { message_id: entry.id });
    const turn = this.turn;
    if (turn != null && this.canSteer(turn)) {
      this.steer(turn, entry);
      return;
    }
    this.pending.push(entry);
    if (!this.busy) this.armBatch();
  }

  /** A submitted turn with nothing queued ahead of the message, so order holds. */
  private canSteer(turn: Turn): boolean {
    return (
      !turn.ended &&
      turn.submitted &&
      turn.steerGrace == null &&
      turn.workspaceId != null &&
      turn.sessionId != null &&
      this.pending.every((entry) => entry.kind === "note")
    );
  }

  /** Into the running turn via the session's own steer; queued as before if it cannot go. */
  private steer(turn: Turn, entry: PhoneInboxEntry): void {
    const steer: Steer = { entry, text: phoneTurnText(entry), landed: false };
    turn.steers.push(steer);
    turn.replyTo = entry.id;
    this.steering = this.steering.then(async () => {
      if (
        !turn.ended &&
        this.pending.every((item) => item.kind === "note") &&
        (await this.sendSteer(turn, steer.text))
      ) {
        this.deps.activity();
        this.log(`[phone] steered turn steers=${turn.steers.length}`);
        return;
      }
      // Ended before it went: the turn's end already queued it.
      if (!turn.steers.includes(steer)) return;
      this.log("[phone] steer not taken; queued for the next turn");
      turn.steers = turn.steers.filter((item) => item !== steer);
      turn.replyTo = turn.steers.at(-1)?.entry.id ?? turn.batchReplyTo;
      this.pending.push(entry);
      if (!this.busy) this.armBatch();
    });
  }

  private async sendSteer(turn: Turn, text: string): Promise<boolean> {
    if (turn.workspaceId == null || turn.sessionId == null) return false;
    try {
      return await this.deps.send(turn.workspaceId, turn.sessionId, text);
    } catch (error) {
      this.log(`[phone] steer failed: ${describe(error)}`);
      return false;
    }
  }

  /**
   * The host's news for the loop (a connector the user just connected): a
   * turn of its own, so the user hears it without asking. It answers against
   * the user's newest message, so with none this start, it waits for one.
   */
  note(text: string): void {
    this.pending.push({ id: `note-${randomUUID()}`, kind: "note", text });
    this.lastArrivalAt = Date.now();
    if (!this.busy && this.lastInboundId != null) this.armBatch();
  }

  /** Start the next turn once no message has arrived for the batch window. */
  private armBatch(): void {
    if (this.batchTimer != null) clearTimeout(this.batchTimer);
    const wait = Math.max(
      0,
      this.lastArrivalAt + this.timings.batchMs - Date.now()
    );
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.startTurn();
    }, wait);
    this.batchTimer.unref?.();
  }

  private async startTurn(): Promise<void> {
    if (!this.running || this.busy || this.pending.length === 0) return;
    const replyTo =
      this.pending.findLast((entry) => entry.kind !== "note")?.id ??
      this.lastInboundId;
    if (replyTo == null) return;
    const batch = this.pending.splice(0);
    const turn: Turn = {
      workspaceId: null,
      sessionId: null,
      replyTo,
      batchReplyTo: replyTo,
      steers: [],
      ids: batch.flatMap((entry) => (entry.kind === "note" ? [] : [entry.id])),
      startedAt: Date.now(),
      messages: batch.length,
      submitted: false,
      text: "",
      textMessageId: null,
      lastText: "",
      subtasks: 0,
      textInSubtask: false,
      lastTextInSubtask: false,
      sent: 0,
      typing: setInterval(
        () => void this.channel("typing", { message_id: turn.replyTo }),
        this.timings.typingRefreshMs
      ),
      timeout: null,
      steerGrace: null,
      ended: false,
    };
    turn.typing?.unref?.();
    this.armTimeout(turn);
    this.turn = turn;
    this.deps.activity();
    this.log(
      `[phone] turn start messages=${batch.length} linked=${batch.filter((entry) => entry.kind === "linked").length}`
    );
    const text = batch.map(phoneTurnText).join("\n\n");
    const retries = this.timings.deliveryRetryMs;
    for (let attempt = 0; ; attempt += 1) {
      const failure = await this.deliver(turn, text);
      if (failure == null || turn.ended) return;
      this.log(`[phone] delivery failed (attempt ${attempt + 1}): ${failure}`);
      if (attempt >= retries.length || !this.running) break;
      await sleep(retries[attempt]!);
      if (turn.ended) return;
    }
    await this.endTurn(turn, "undeliverable");
  }

  /** One attempt to hand the batch to the session; the reason it failed, or null. */
  private async deliver(turn: Turn, text: string): Promise<string | null> {
    try {
      const { workspaceId, sessionId } = await this.deps.openSession();
      // Before the send: the session's first events can beat its answer.
      turn.workspaceId = workspaceId;
      turn.sessionId = sessionId;
      return (await this.deps.send(workspaceId, sessionId, text))
        ? null
        : "the session did not take the message";
    } catch (error) {
      return describe(error);
    }
  }

  private onAgentEvent(sessionId: string, payload: DesktopEvent): void {
    const turn = this.turn;
    if (
      turn == null ||
      turn.ended ||
      turn.sessionId !== sessionId ||
      payload.type !== "event"
    )
      return;
    const event = payload.event;

    if (event.type === "status_changed") {
      if (event.status === AgentStatus.Submitted) {
        turn.submitted = true;
        // The run an unheard steer started after the idle: it is that steer's.
        if (turn.steerGrace != null) {
          clearTimeout(turn.steerGrace);
          turn.steerGrace = null;
          for (const steer of turn.steers) steer.landed = true;
        }
      } else if (event.status === AgentStatus.Idle && turn.submitted) {
        if (turn.steers.some((steer) => !steer.landed)) this.awaitSteer(turn);
        else void this.endTurn(turn, "ok");
      }
      return;
    }
    if (event.type === "error") {
      // Before the turn starts only a missing model is ours; anything else is
      // a trailing error from the turn before.
      if (!turn.submitted && event.error?.code !== "model_unavailable") return;
      // The reason stays in the log; the phone gets what was written so far.
      this.log(`[phone] turn error code=${event.error?.code ?? "unknown"}`);
      void this.endTurn(turn, "error");
      return;
    }
    if (!turn.submitted) return;
    if (event.type === "subtask_start") {
      turn.subtasks += 1;
      return;
    }
    if (event.type === "subtask_end") {
      turn.subtasks = Math.max(0, turn.subtasks - 1);
      return;
    }
    if (
      event.type === "user_message_steered" ||
      event.type === "user_message_dequeued"
    ) {
      const steer = turn.steers.find(
        (item) => !item.landed && event.content.includes(item.text.trim())
      );
      if (steer != null) steer.landed = true;
      // An answer already written goes now, before the new message gets its own.
      this.sendEarly(turn, event.type === "user_message_dequeued");
      return;
    }
    if (event.type === "text_delta") {
      if (
        event.messageId != null &&
        turn.textMessageId != null &&
        event.messageId !== turn.textMessageId
      )
        this.closeMessage(turn);
      if (event.messageId != null) turn.textMessageId = event.messageId;
      if (turn.text.length === 0) turn.textInSubtask = turn.subtasks > 0;
      turn.text += event.content;
      return;
    }
    // Words before a tool call are narration unless nothing follows them.
    if (event.type === "tool_call_start") {
      this.closeMessage(turn);
      return;
    }
    if (
      event.type !== "tool_execution_complete" ||
      event.result.rejected === true
    )
      return;
    if (isTool(event.tool.name, REACT_TOOL)) {
      const emoji = event.tool.input.emoji;
      if (isMessageReaction(emoji))
        void this.channel("react", { message_id: turn.replyTo, emoji });
      return;
    }
    // A progress line goes out now; the turn still answers at its end.
    if (isTool(event.tool.name, PHONE_PROGRESS_TOOL_NAME)) {
      const text = event.tool.input.text;
      if (typeof text !== "string" || text.trim().length === 0) return;
      this.deps.activity();
      this.armTimeout(turn);
      void this.sendInOrder(turn, [text.trim()]).then((sent) => {
        // A sent message clears WhatsApp's "typing…"; the turn is still working.
        if (sent > 0 && !turn.ended)
          void this.channel("typing", { message_id: turn.replyTo });
      });
    }
  }

  private closeMessage(turn: Turn): void {
    if (turn.text.trim().length > 0) {
      turn.lastText = turn.text;
      turn.lastTextInSubtask = turn.textInSubtask;
    }
    turn.text = "";
    turn.textInSubtask = false;
    turn.textMessageId = null;
  }

  /**
   * A steered message is about to be answered: what the turn already wrote
   * goes now, or the next answer replaces it. Mid-run that is only the
   * message being written; once a queued one runs, the last turn's reply.
   */
  private sendEarly(turn: Turn, runEnded: boolean): void {
    const current = turn.text.trim().length > 0 && !turn.textInSubtask;
    const last =
      runEnded &&
      !current &&
      turn.text.trim().length === 0 &&
      turn.lastText.trim().length > 0 &&
      !turn.lastTextInSubtask;
    const reply = current ? turn.text : last ? turn.lastText : "";
    turn.text = "";
    turn.textInSubtask = false;
    turn.textMessageId = null;
    if (runEnded) {
      turn.lastText = "";
      turn.lastTextInSubtask = false;
    }
    const bubbles = splitPhoneBubbles(reply);
    if (bubbles.length > 0) void this.sendInOrder(turn, bubbles);
  }

  /**
   * Idle with a steer the session never reported taking: it reached an idle
   * session and starts a run of its own. What was written goes now; the turn
   * waits briefly for that run.
   */
  private awaitSteer(turn: Turn): void {
    this.sendEarly(turn, true);
    turn.submitted = false;
    turn.steerGrace = setTimeout(
      () => void this.endTurn(turn, "ok"),
      this.timings.steerGraceMs
    );
    turn.steerGrace.unref?.();
  }

  /** A turn that keeps reporting progress is working, not stuck: its clock restarts. */
  private armTimeout(turn: Turn): void {
    if (turn.timeout != null) clearTimeout(turn.timeout);
    turn.timeout = setTimeout(
      () => void this.endTurn(turn, "timeout"),
      this.timings.turnTimeoutMs
    );
    turn.timeout.unref?.();
  }

  /** Bubbles to the user after whatever is already on its way; resolves with how many went. */
  private sendInOrder(turn: Turn, bubbles: string[]): Promise<number> {
    const run = this.outbox.then(() => this.sendBubbles(turn, bubbles));
    this.outbox = run.catch(() => 0);
    return run;
  }

  private async sendBubbles(turn: Turn, bubbles: string[]): Promise<number> {
    let sent = 0;
    for (const bubble of bubbles) {
      if (!this.running) break;
      if (sent > 0) {
        void this.channel("typing", { message_id: turn.replyTo });
        await sleep(
          this.timings.bubblePauseMinMs +
            Math.random() *
              (this.timings.bubblePauseMaxMs - this.timings.bubblePauseMinMs)
        );
      }
      if (
        !(await this.channel("reply", {
          message_id: turn.replyTo,
          text: bubble,
        }))
      )
        break;
      sent += 1;
    }
    turn.sent += sent;
    return sent;
  }

  private async endTurn(turn: Turn, outcome: string): Promise<void> {
    if (turn.ended) return;
    turn.ended = true;
    this.clearTurnTimers(turn);
    const reply = turn.text.trim().length > 0 ? turn.text : turn.lastText;
    const bubbles = splitPhoneBubbles(reply);
    const sent = await this.sendInOrder(turn, bubbles);
    // At most once per batch, after whatever the turn did manage to say.
    const apologized =
      outcome !== "ok" &&
      this.running &&
      (await this.channel("reply", {
        message_id: turn.replyTo,
        text: FAILURE_REPLY,
      }));
    this.log(
      `[phone] turn end outcome=${outcome} ms=${Date.now() - turn.startedAt} messages=${turn.messages} bubbles=${sent}/${bubbles.length} apology=${apologized ? 1 : 0}`
    );
    // Answered (or apologized for): never hand it over again. Otherwise the
    // server redelivers it, to this host later or to the next one.
    // An "ok" whose every bubble failed to send was never seen: keep it.
    const answered =
      turn.sent > 0 || apologized || (outcome === "ok" && bubbles.length === 0);
    // A steer the session never took runs as the next turn, ahead of what came after.
    const heard = turn.steers.filter((steer) => steer.landed);
    this.pending.unshift(
      ...turn.steers
        .filter((steer) => !steer.landed)
        .map((steer) => steer.entry)
    );
    turn.steers = heard;
    if (this.running && answered)
      await this.ack([...turn.ids, ...heard.map((steer) => steer.entry.id)]);
    this.deps.activity();
    if (this.turn === turn) this.turn = null;
    if (this.pending.length > 0) this.armBatch();
  }

  private inFlight(id: string): boolean {
    return (
      this.pending.some((entry) => entry.id === id) ||
      (this.turn?.ids.includes(id) ?? false) ||
      (this.turn?.steers.some((steer) => steer.entry.id === id) ?? false)
    );
  }

  private async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.deps.call(
        { action: "ack", message_ids: ids },
        CALL_TIMEOUT_MS
      );
    } catch (error) {
      this.log(`[phone] ack failed: ${describe(error)}`);
    }
  }

  private clearTurnTimers(turn: Turn): void {
    if (turn.typing != null) clearInterval(turn.typing);
    if (turn.timeout != null) clearTimeout(turn.timeout);
    if (turn.steerGrace != null) clearTimeout(turn.steerGrace);
    turn.typing = null;
    turn.timeout = null;
    turn.steerGrace = null;
  }

  /** One fire-and-report channel call; true when the server took it. */
  private async channel(
    action: "typing" | "reply" | "react",
    body: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const result = await this.deps.call<{ ok?: boolean; error?: string }>(
        { action, ...body },
        CALL_TIMEOUT_MS
      );
      if (action === "typing" || result.ok === true) return true;
      this.log(`[phone] ${action} refused: ${result.error ?? "no reason"}`);
    } catch (error) {
      this.log(`[phone] ${action} failed: ${describe(error)}`);
    }
    return false;
  }
}

/** `/v1/abacusaibot_channels` with the user's Abacus key. */
export function channelsTransport(options: {
  baseUrl: () => string;
  key: () => string | null;
  userAgent: () => string;
}): ChannelsCall {
  return async <T>(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> => {
    const key = options.key();
    if (key == null) throw new Error("Abacus.AI is not connected.");
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${options.baseUrl()}/abacusaibot_channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "user-agent": options.userAgent(),
      },
      body: JSON.stringify(body),
      signal: signal != null ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload = (await response.json().catch(() => ({}))) as T & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Abacus API returned ${response.status}`
      );
    return payload;
  };
}

/** The tool by its own name or as an MCP server prefixes it. */
const isTool = (name: string, tool: string): boolean =>
  name === tool || name.endsWith(`_${tool}`);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
