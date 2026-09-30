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
  | "bot-limit";

export interface RpcErrorData {
  BAD_REQUEST: { issues?: readonly unknown[] };
  NOT_FOUND: { entity: NotFoundEntity; id: string };
  CONFLICT: { reason: string };
  PRECONDITION_FAILED: { reason: PreconditionReason; detail?: string };
  FORBIDDEN: { reason: string };
  UNAVAILABLE: { retryAfterMs?: number };
  RESYNC_REQUIRED: { stream: string };
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
  UNAVAILABLE: { status: 503, data: type<RpcErrorData["UNAVAILABLE"]>() },
  RESYNC_REQUIRED: {
    status: 409,
    data: type<RpcErrorData["RESYNC_REQUIRED"]>(),
  },
  TIMEOUT: { status: 504, data: type<RpcErrorData["TIMEOUT"]>() },
  INTERNAL_SERVER_ERROR: { status: 500 },
} as const;

export const RPC_ERROR_CODES = Object.keys(COMMON_ERRORS) as RpcErrorCode[];
