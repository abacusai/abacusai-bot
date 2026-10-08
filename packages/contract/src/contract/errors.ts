/**
 * The error model every procedure shares (spec 00 A.5). Each procedure starts
 * from `base` (base.ts), which carries this map, so `isDefinedError` from
 * `@orpc/client` narrows every code below on the client.
 *
 * oRPC treats a thrown `ORPCError` whose code, status and data match an entry
 * here as "defined", wherever it was thrown, so main can throw these with
 * `new ORPCError(code, { data })` and the client still gets the typed shape.
 */
import { type } from "@orpc/contract";

export type NotFoundEntity =
  | "session"
  | "workspace"
  | "bot"
  | "routine"
  | "terminal"
  | "thread"
  | "file";

export type PreconditionReason =
  | "workspace-missing"
  | "not-signed-in"
  | "no-credentials"
  | "git-unavailable"
  /** The 50-bot limit (spec 03 §24.4). */
  | "bot-limit"
  | "unsupported-platform"
  /** The free plan's hosted routine is taken; upgrading allows more. */
  | "plan-required"
  /** The free plan runs a hosted routine at most once a day. */
  | "plan-interval"
  /** The free plan's hosted routines are tasks only. */
  | "plan-kind"
  /** A paid plan's hosted routines of that kind are all in use. */
  | "routine-limit"
  /** No hosted bot to run it on yet. */
  | "no-host"
  /** The hosted routine is done or not active, so it cannot change that way. */
  | "routine-not-active"
  /** The hosted routine is mid-change on the server; try again shortly. */
  | "routine-busy"
  /** Too many runs of the hosted routine are already waiting. */
  | "queue-full"
  /** Another of the user's bots made the hosted routine. */
  | "wrong-bot"
  /** Hosted routines are switched off for the account for now. */
  | "routines-off";

/** Why the server would not take a hosted routine's values. */
export type RoutineRefusal =
  | "schedule"
  | "interval"
  | "timezone"
  | "sources"
  | "reads"
  | "text"
  | "other";

export interface RpcErrorData {
  /**
   * `issues`: the input failed its schema. `field`/`detail`: a value the
   * schema accepts but the service refused (a cron schedule that does not
   * parse, spec 05 §31.5 e); `detail` is the user-facing reason.
   */
  BAD_REQUEST: {
    issues?: readonly unknown[];
    field?: string;
    detail?: string;
    /** A hosted routine the server would not take: why, for the app to word. */
    refusal?: RoutineRefusal;
  };
  NOT_FOUND: { entity: NotFoundEntity; id: string };
  CONFLICT: { reason: string };
  PRECONDITION_FAILED: { reason: PreconditionReason; detail?: string };
  FORBIDDEN: { reason: string };
  UNSUPPORTED: { procedure: string };
  UNAVAILABLE: { retryAfterMs?: number };
  RESYNC_REQUIRED: { stream: string };
  PAYLOAD_TOO_LARGE: { limit: number; alternative: string };
  TIMEOUT: { ms: number };
  INTERNAL_SERVER_ERROR: undefined;
}

export type RpcErrorCode = keyof RpcErrorData;

// Data schemas are type-only: main is the only thrower, and a payload that
// failed validation would silently turn a defined error into an undefined one
// on the client.
export const COMMON_ERRORS = {
  BAD_REQUEST: { status: 400, data: type<RpcErrorData["BAD_REQUEST"]>() },
  NOT_FOUND: { status: 404, data: type<RpcErrorData["NOT_FOUND"]>() },
  CONFLICT: { status: 409, data: type<RpcErrorData["CONFLICT"]>() },
  PRECONDITION_FAILED: {
    status: 412,
    data: type<RpcErrorData["PRECONDITION_FAILED"]>(),
  },
  FORBIDDEN: { status: 403, data: type<RpcErrorData["FORBIDDEN"]>() },
  UNSUPPORTED: { status: 501, data: type<RpcErrorData["UNSUPPORTED"]>() },
  UNAVAILABLE: { status: 503, data: type<RpcErrorData["UNAVAILABLE"]>() },
  RESYNC_REQUIRED: {
    status: 409,
    data: type<RpcErrorData["RESYNC_REQUIRED"]>(),
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    data: type<RpcErrorData["PAYLOAD_TOO_LARGE"]>(),
  },
  TIMEOUT: { status: 504, data: type<RpcErrorData["TIMEOUT"]>() },
  INTERNAL_SERVER_ERROR: { status: 500 },
} as const;
