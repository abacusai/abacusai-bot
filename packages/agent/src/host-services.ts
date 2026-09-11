/**
 * Asking the desktop process to do what only it can: render with Chromium.
 * Everything but the rendering lives in this process; rendering is a narrow
 * service the host performs over the stdio protocol both sides already share,
 * correlated the same way as `permission_needed`/`permission_response`.
 */
import type { HostService } from "./protocol.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Rendering a long document takes seconds, not minutes. The number matters less
 * than having one: a host that never answers (the terminal CLI, for one) would
 * otherwise leave the tool call waiting for the life of the process.
 */
const REQUEST_TIMEOUT_MS = 120_000;

export class HostServiceClient {
  private counter = 0;
  private readonly pending = new Map<string, Pending>();

  /** @param emit  Sends the request; this class never knows it is stdout. */
  constructor(
    private readonly emit: (
      requestId: string,
      service: HostService,
      payload: unknown
    ) => void
  ) {}

  /**
   * Runs `service` on the host. Rejects rather than throwing synchronously, so
   * a host that cannot render is a failed tool result, not a torn-down turn.
   */
  async request(service: HostService, payload: unknown): Promise<unknown> {
    const requestId = `host-${++this.counter}`;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `The host did not answer ${service} within ${REQUEST_TIMEOUT_MS / 1000}s.`
          )
        );
      }, REQUEST_TIMEOUT_MS);

      // A pending host request must never be the reason the process stays up.
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });

    this.emit(requestId, service, payload);

    return promise;
  }

  /** Called from the command loop when the host answers. Unknown ids are stale. */
  settle(
    requestId: string,
    ok: boolean,
    result: unknown,
    error: string | undefined
  ): void {
    const waiter = this.pending.get(requestId);

    if (waiter == null) return;

    this.pending.delete(requestId);
    if (waiter.timer) clearTimeout(waiter.timer);

    if (ok) waiter.resolve(result);
    else waiter.reject(new Error(error ?? "The host reported no reason."));
  }

  /**
   * Fails everything outstanding so a stopped turn doesn't wait out deadlines.
   */
  failAll(reason: string): void {
    for (const [requestId, waiter] of this.pending) {
      this.pending.delete(requestId);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }
}
