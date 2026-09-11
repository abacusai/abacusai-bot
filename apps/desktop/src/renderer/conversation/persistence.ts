import { segmentsToConversationSegments } from ".";
/**
 * Local transcript persistence: each session's segments go to disk as they
 * change and replay through the store's `hydrate` path on reopen. Saving is
 * driven off the transport, not the active session, so a background session
 * still persists its work.
 */
import type { ConversationSegment } from "./agent-types";
import { workspaceConversationTransport } from "./transport";
import type { Segment } from "./types";

/** Injected by `store.tsx`, which imports this module; importing back is a cycle. */
type ReadSegments = (sessionId: string) => Segment[];

let readSegments: ReadSegments = () => [];

/** Segments change on nearly every delta; coalesce into one write per quiet period. */
const SAVE_DEBOUNCE_MS = 750;

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Hydrating twice would double the transcript. */
const hydrated = new Set<string>();

/**
 * Sessions whose file has been read this run, empty or not. The save path
 * waits on this: before the read the store holds only what arrived since
 * launch, and writing that would shrink the file to it.
 */
const diskChecked = new Set<string>();

/** A prefetch and the open after it share one read, not two `hydrate` emits. */
const restoring = new Map<string, Promise<void>>();

/**
 * When each segment was first seen, per session. Segments carry no time of
 * their own and the reducer is vendored, so this rides along in the transcript
 * file instead. Accurate to the save debounce, far finer than separator gaps.
 */
const firstSeen = new Map<string, Map<string, number>>();

const timesFor = (sessionId: string): Map<string, number> => {
  const existing = firstSeen.get(sessionId);
  if (existing != null) return existing;
  const created = new Map<string, number>();
  firstSeen.set(sessionId, created);
  return created;
};

/** Empty for a transcript without stamps; a missing time draws no separator. */
export const segmentTimes = (sessionId: string): Map<string, number> =>
  new Map(timesFor(sessionId));

const stamped = (
  sessionId: string,
  segments: Segment[]
): ConversationSegment[] => {
  const times = timesFor(sessionId);
  const now = Date.now();
  return segmentsToConversationSegments(segments).map((segment) => {
    const id = (segment as { id?: string }).id;
    if (id == null) return segment;
    // First write wins: a segment's time is when it arrived, not when it was
    // last saved. `at` is file-format only; the reducer drops it.
    if (!times.has(id)) times.set(id, now);
    return { ...segment, at: times.get(id) } as unknown as ConversationSegment;
  });
};

const flush = async (sessionId: string): Promise<void> => {
  saveTimers.delete(sessionId);
  // Never write before the disk has been read, or the file shrinks to what
  // arrived this run. A failed read leaves the file alone for the next change.
  if (!diskChecked.has(sessionId)) {
    await restoreTranscript(sessionId);
    if (!diskChecked.has(sessionId)) return;
  }
  const segments = readSegments(sessionId) ?? [];
  if (segments.length === 0) return;
  void window.api?.agent
    ?.writeTranscript?.(sessionId, stamped(sessionId, segments) as never)
    ?.catch((error: unknown) => {
      console.error("[transcripts] failed to persist transcript", error);
    });
};

const scheduleSave = (sessionId: string): void => {
  const existing = saveTimers.get(sessionId);
  if (existing != null) clearTimeout(existing);
  saveTimers.set(
    sessionId,
    setTimeout(() => {
      void flush(sessionId);
    }, SAVE_DEBOUNCE_MS)
  );
};

/**
 * Restore a session's transcript once per run. Live segments do not skip it:
 * the file is what came before them, and both end up in the store, file first.
 */
export const restoreTranscript = async (sessionId: string): Promise<void> => {
  if (sessionId == null || hydrated.has(sessionId)) return;
  // One read per session at a time: a hover prefetch and a click must not
  // both emit a hydrate.
  const running = restoring.get(sessionId);
  if (running != null) return running;

  const run = readAndHydrate(sessionId);
  restoring.set(sessionId, run);
  try {
    await run;
  } finally {
    restoring.delete(sessionId);
  }
};

/**
 * A session counts as restored only when there was something to restore: a
 * bot's chat is minted before its first fire, and marking it on an empty read
 * would write it off for the rest of the run.
 */
const readAndHydrate = async (sessionId: string): Promise<void> => {
  try {
    const segments =
      (await window.api?.agent?.readTranscript?.(sessionId)) ?? [];
    diskChecked.add(sessionId);
    if (!Array.isArray(segments) || segments.length === 0) return;
    // Take the stamps back first; the reducer knows nothing about `at`.
    const times = timesFor(sessionId);
    for (const segment of segments as { id?: string; at?: unknown }[]) {
      if (segment.id != null && typeof segment.at === "number")
        times.set(segment.id, segment.at);
    }
    // Live segments are read at emit time, not before the await, since a turn
    // may have streamed meanwhile. They are merged by id, not appended: the
    // file may already hold them, and appending showed every message twice.
    const live = readSegments(sessionId) ?? [];
    workspaceConversationTransport.emit(sessionId, {
      kind: "hydrate",
      segments: mergeTranscript(
        segments as unknown as ConversationSegment[],
        live.length > 0 ? stamped(sessionId, live) : []
      ),
    });
    hydrated.add(sessionId);
  } catch (error) {
    // A missing or corrupt transcript must not block the open, nor be
    // remembered as an answer.
    console.error("[transcripts] failed to restore transcript", error);
  }
};

/** The file's segments with the live ones folded in by id. Exported for tests. */
export const mergeTranscript = (
  file: ConversationSegment[],
  live: ConversationSegment[]
): ConversationSegment[] => {
  if (live.length === 0) return file;
  const liveById = new Map<string, ConversationSegment>();
  for (const segment of live) liveById.set(segment.id, segment);
  const fileIds = new Set(file.map((segment) => segment.id));
  return [
    ...file.map((segment) => liveById.get(segment.id) ?? segment),
    ...live.filter((segment) => !fileIds.has(segment.id)),
  ];
};

/**
 * Warm a session's transcript on hover so the open is a single paint instead
 * of an empty frame followed by the async IPC read. Repeat calls are a Set
 * lookup.
 */
export const prefetchTranscript = (sessionId: string): void => {
  void restoreTranscript(sessionId);
};

/** The file itself is removed by the main process. */
export const forgetTranscript = (sessionId: string): void => {
  const timer = saveTimers.get(sessionId);
  if (timer != null) clearTimeout(timer);
  saveTimers.delete(sessionId);
  hydrated.delete(sessionId);
  diskChecked.delete(sessionId);
  restoring.delete(sessionId);
  firstSeen.delete(sessionId);
};

/** Mounted once for the app lifetime; returns an unsubscribe for symmetry. */
export const startTranscriptPersistence = (
  getSegments: ReadSegments
): (() => void) => {
  readSegments = getSegments;

  return workspaceConversationTransport.subscribe((sessionId) => {
    if (sessionId == null) return;
    // The first live event for a session nobody opened this run (a routine
    // firing) restores the file underneath it. The restore reads the store
    // only after its IPC round trip, when the reducer is settled.
    if (!hydrated.has(sessionId) && !diskChecked.has(sessionId))
      void restoreTranscript(sessionId);
    // Deferred for the same reason: this subscriber and the store's dispatch
    // share one listener set.
    scheduleSave(sessionId);
  });
};
