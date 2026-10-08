/**
 * The hosted bot's side of server-kept routines, switched on only when the
 * server says it keeps them: the routine lane's runner starts, this
 * computer's routines move to the server once, and from then on its own
 * scheduler and webhook relay stay off. An old server never says so, and
 * nothing changes: local routines keep running here as before.
 */
import {
  migrateRoutines,
  readMigrationMarker,
  writeMigrationMarker,
  migrationNote,
  type MigrationDeps,
  type MigrationMarker,
} from "#main/services/agent-tools/routine-migration";

export interface HostedRoutinesSetupDeps {
  hasKey: () => boolean;
  capability: () => Promise<boolean>;
  /** Re-read the server's list for the Routines panel. */
  refresh: () => Promise<unknown>;
  migration: MigrationDeps;
  startRunner: () => void;
  /** This computer's own scheduler and relay, for good. */
  stopLocalScheduler: () => void;
  /** The bot's chat hears a note as a turn (the zone offer). */
  note: (text: string) => void;
  /** After a move: the server sends the owner one link to review them all. */
  sendReviewLink: () => Promise<{ sent: boolean; pending: number }>;
  readMarker?: () => MigrationMarker | null;
  writeMarker?: (marker: MigrationMarker) => void;
  now?: () => number;
  log?: (line: string) => void;
  /** Waits between checks: for a key, and for a server that says no. */
  wait?: (ms: number) => Promise<void>;
}

const KEY_WAIT_MS = 5_000;
/** The first wait after the server did not say yes; it doubles from here. */
const CAPABILITY_RETRY_FIRST_MS = 30_000;
/** An old server is asked again this rarely, so an upgrade is picked up. */
const CAPABILITY_RECHECK_MS = 30 * 60_000;

/**
 * On a host that already moved, the local scheduler goes off at once, before
 * any network: a migrated job is switched off anyway, and nothing new is
 * local there.
 */
export function stopIfMigrated(deps: HostedRoutinesSetupDeps): boolean {
  if ((deps.readMarker ?? readMigrationMarker)() == null) return false;
  deps.stopLocalScheduler();
  return true;
}

/**
 * Wait for a key and a yes from the server, then start the runner and move
 * this computer's routines once. A host that already moved starts its runner
 * as soon as it has a key: its scheduler is off, so the lane is the only way
 * its routines run. Otherwise the server is asked again soon after a failure,
 * then less often. Resolves when that is done, or when `stopped` says to
 * give up.
 */
export async function setUpHostedRoutines(
  deps: HostedRoutinesSetupDeps,
  stopped: () => boolean = () => false
): Promise<"on" | "stopped"> {
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }));
  const log = deps.log ?? ((line: string) => console.log(line));
  const readMarker = deps.readMarker ?? readMigrationMarker;
  const writeMarker = deps.writeMarker ?? writeMigrationMarker;

  let marker = readMarker();
  let backoff = CAPABILITY_RETRY_FIRST_MS;
  for (;;) {
    if (stopped()) return "stopped";
    if (!deps.hasKey()) {
      await wait(KEY_WAIT_MS);
      continue;
    }
    if (marker != null) break;
    if (await deps.capability()) break;
    await wait(backoff);
    backoff = Math.min(backoff * 2, CAPABILITY_RECHECK_MS);
  }

  deps.startRunner();
  void deps.refresh();

  if (marker == null) {
    const result = await migrateRoutines(deps.migration);
    log(
      `[routines] moved ${result.moved}, ${result.notMoved.length} paused here, ${result.failed} to try again`
    );
    // Jobs the server will not take are paused here with their reason, so
    // only a failure worth retrying keeps this computer's scheduler on.
    if (result.failed === 0) {
      // Moved routines wait for the owner's review; the server sends one link.
      const review =
        result.moved > 0
          ? await deps
              .sendReviewLink()
              .catch(() => ({ sent: false, pending: 0 }))
          : { sent: false, pending: 0 };
      marker = {
        migratedAt: (deps.now ?? Date.now)(),
        note:
          result.moved + result.notMoved.length > 0
            ? migrationNote(result.crons, result.notMoved, review)
            : null,
      };
      writeMarker(marker);
      deps.stopLocalScheduler();
    }
    void deps.refresh();
  }
  if (marker?.note != null) {
    // Said once: the chat hears it on the user's next message.
    deps.note(marker.note);
    writeMarker({ ...marker, note: null });
  }
  return "on";
}
