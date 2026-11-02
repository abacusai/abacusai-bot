/**
 * Getting a message to the agent when its CLI is gone: a failed dispatch
 * starts the session and delivers once it is up. Retrying is safe because
 * `send` returning false means the command never reached a process. Ports are
 * injected so ordering and give-up conditions test without a spawned CLI.
 */

/** The agent was not ready by its startup deadline, twice. */
export const AGENT_START_TIMEOUT = "agent_start_timeout";
/** No agent took the message: it could not be started, or refused it. */
export const UNDELIVERABLE = "undeliverable";

/** How a message failed to reach an agent; its turn's failure cause. */
export type DeliveryFailure = typeof AGENT_START_TIMEOUT | typeof UNDELIVERABLE;

export type DeliveryOutcome = "delivered" | "restarted" | DeliveryFailure;

/** How one start went: up, out of time before ready, or failed otherwise. */
export type StartOutcome = "started" | "timed_out" | "failed";

export interface DeliveryPorts {
  /** Hand the message to the running CLI. False means it was not dispatched. */
  send: () => boolean;
  /** Bring the session's CLI back up. */
  start: () => Promise<StartOutcome>;
  /** True once the CLI has announced itself ready for commands. */
  isRunning: () => boolean;
  /** Injected so tests do not wait in real time. */
  delay: (ms: number) => Promise<void>;
}

// Sending before the revived CLI's `ready` arrives drops the command: stdin
// is not wired yet.
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;

export const reachedAgent = (
  outcome: DeliveryOutcome
): outcome is Exclude<DeliveryOutcome, DeliveryFailure> =>
  outcome === "delivered" || outcome === "restarted";

export async function deliverMessage(
  ports: DeliveryPorts
): Promise<DeliveryOutcome> {
  if (ports.send()) return "delivered";

  let started = await ports.start();
  // Nothing has reached an agent yet, so a second start is safe; a slow
  // machine's first start (a cold launch, just after waking) often runs out.
  if (started !== "started") started = await ports.start();
  if (started === "timed_out") return AGENT_START_TIMEOUT;
  if (started === "failed") return UNDELIVERABLE;

  for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
    if (ports.isRunning()) {
      // One attempt, not a loop: if a ready CLI refuses the command, something
      // is wrong that resending cannot fix.
      return ports.send() ? "restarted" : UNDELIVERABLE;
    }
    await ports.delay(READY_POLL_MS);
  }

  return UNDELIVERABLE;
}
