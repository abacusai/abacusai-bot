/**
 * "Nothing answered within `ms`", said by a service in a form the RPC layer
 * maps to `TIMEOUT { ms }` (spec 00 A.5, spec 05 §31.5 e) without reading
 * prose. Legacy IPC sees exactly what it saw before: the plain `Error` name
 * and the same message.
 */
export class TimeoutError extends Error {
  readonly ms: number;

  constructor(message: string, ms: number) {
    super(message);
    this.ms = ms;
  }
}
