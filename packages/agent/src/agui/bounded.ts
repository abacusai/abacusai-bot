/**
 * Insertion-ordered bookkeeping that forgets its oldest entries past a limit
 * (agent spec §5.2 "Bounded bookkeeping"). A runtime can serve one thread
 * for days, so nothing it remembers per run or per message may grow with
 * the conversation. Each limit is chosen so that what the bookkeeping
 * guards (retry dedupe, echo dedupe, message-id uniqueness) still holds for
 * every repeat that can reach this process (see the constants).
 */

/**
 * Run ids (`run.ack` answered, runs opened) and echoed user message ids kept
 * per process. Main records every run id's first ack for 10,000 run ids over
 * all threads (`ACKS_KEPT`) and answers a repeat from that record without
 * writing `run` again; a repeat reaches the agent only once main has
 * forgotten it, i.e. after 10,000 newer acks, of which at most 10,000 are
 * this thread's. So a per-process window of the same size still holds it.
 */
export const RUN_IDS_KEPT = 10_000;

/**
 * Run outcomes kept per process. Only the last prompted run's outcome is
 * read (the regenerate check, §3.1.4); the rest is slack.
 */
export const RUN_OUTCOMES_KEPT = 1_000;

/**
 * AG-UI message ids handed out, and legacy `msg-N` keys mapped to them, per
 * process. Ids are pi's own, `<runId>:error`, or the incarnation-scoped
 * fallback, so a collision is between messages of the same few turns (a
 * child reusing its parent's pi id); a key is referenced only while its
 * message is open. 4,096 covers far more than one turn's messages.
 */
export const MESSAGE_IDS_KEPT = 4_096;

export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(readonly limit: number) {}

  get size(): number {
    return this.items.size;
  }

  has(item: T): boolean {
    return this.items.has(item);
  }

  /** Adds `item` as the newest entry (moving it if present). */
  add(item: T): this {
    this.items.delete(item);
    this.items.add(item);
    while (this.items.size > this.limit)
      this.items.delete(this.items.values().next().value as T);
    return this;
  }
}

export class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Sets `key` as the newest entry (moving it if present). */
  set(key: K, value: V): this {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit)
      this.entries.delete(this.entries.keys().next().value as K);
    return this;
  }
}
