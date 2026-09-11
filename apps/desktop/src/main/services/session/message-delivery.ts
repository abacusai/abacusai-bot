/**
 * Getting a message to the agent when its CLI is gone: a failed dispatch
 * starts the session and delivers once it is up. Retrying is safe because
 * `send` returning false means the command never reached a process. Ports are
 * injected so ordering and give-up conditions test without a spawned CLI.
 */

export type DeliveryOutcome = "delivered" | "restarted" | "undeliverable";

export interface DeliveryPorts {
  /** Hand the message to the running CLI. False means it was not dispatched. */
  send: () => boolean;
  /** Bring the session's CLI back up. False means it could not be started. */
  start: () => Promise<boolean>;
  /** True once the CLI has announced itself ready for commands. */
  isRunning: () => boolean;
  /** Injected so tests do not wait in real time. */
  delay: (ms: number) => Promise<void>;
}

// Sending before the revived CLI's `ready` arrives drops the command: stdin
// is not wired yet.
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;

export async function deliverMessage(
  ports: DeliveryPorts
): Promise<DeliveryOutcome> {
  if (ports.send()) return "delivered";

  if (!(await ports.start())) return "undeliverable";

  for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
    if (ports.isRunning()) {
      // One attempt, not a loop: if a ready CLI refuses the command, something
      // is wrong that resending cannot fix.
      return ports.send() ? "restarted" : "undeliverable";
    }
    await ports.delay(READY_POLL_MS);
  }

  return "undeliverable";
}
