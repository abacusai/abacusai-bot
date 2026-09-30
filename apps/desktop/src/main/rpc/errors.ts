/**
 * Mapping main's failures onto the contract's error map (spec 00 A.5). An
 * `ORPCError` whose code, status and data match `COMMON_ERRORS` reaches the
 * client as a defined error, wherever it was thrown.
 */
import { ORPCError } from "@orpc/server";

import { ConflictError } from "#shared/conflict";
import type {
  NotFoundEntity,
  PreconditionReason,
} from "#shared/contract/errors";
import { WORKSPACE_MISSING_ERROR } from "#shared/contracts";
import { EntityNotFoundError, WORKSPACE_NOT_FOUND } from "#shared/not-found";

import { UnsupportedPlatformError } from "../services/system/login-item";

export type RpcError = ORPCError<string, unknown>;

export const unavailable = (message: string, retryAfterMs?: number): RpcError =>
  new ORPCError("UNAVAILABLE", {
    status: 503,
    message,
    data: retryAfterMs == null ? {} : { retryAfterMs },
  });

export const forbidden = (reason: string): RpcError =>
  new ORPCError("FORBIDDEN", {
    status: 403,
    message: reason,
    data: { reason },
  });

export const notFound = (entity: NotFoundEntity, id: string): RpcError =>
  new ORPCError("NOT_FOUND", {
    status: 404,
    message: `No ${entity} ${id}`,
    data: { entity, id },
  });

/** A combination the schema cannot express was invalid. */
export const badRequest = (message: string): RpcError =>
  new ORPCError("BAD_REQUEST", { status: 400, message, data: {} });

export const conflict = (reason: string): RpcError =>
  new ORPCError("CONFLICT", { status: 409, message: reason, data: { reason } });

export const preconditionFailed = (
  reason: PreconditionReason,
  detail?: string
): RpcError =>
  new ORPCError("PRECONDITION_FAILED", {
    status: 412,
    message: detail ?? reason,
    data: detail == null ? { reason } : { reason, detail },
  });

/**
 * A thrown value as the contract's error. An `ORPCError` passes through; a
 * workspace-missing failure is the precondition it is; anything else is
 * `INTERNAL_SERVER_ERROR`, keeping its message (service messages name what
 * failed, never a credential) and its stack for the log.
 */
export const toRpcError = (error: unknown): RpcError => {
  if (error instanceof ORPCError) return error as RpcError;
  if (error instanceof EntityNotFoundError)
    return notFound(error.entity, error.id);
  if (error instanceof ConflictError) return conflict(error.message);
  if (error instanceof UnsupportedPlatformError)
    return preconditionFailed("unsupported-platform", error.message);

  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(WORKSPACE_MISSING_ERROR)) {
    return preconditionFailed(
      "workspace-missing",
      message.slice(WORKSPACE_MISSING_ERROR.length + 1) || undefined
    );
  }
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    status: 500,
    message,
    cause: error,
  });
};

type LegacyResult = { success: boolean; error?: string };

/** A workspace result's failure: NOT_FOUND for an id main does not know. */
export const workspaceFailure =
  (workspaceId: string) =>
  (reason: string): RpcError =>
    reason === WORKSPACE_NOT_FOUND
      ? notFound("workspace", workspaceId)
      : conflict(reason);

/**
 * A legacy `{ success, error }` result as its success payload, or the mapped
 * error. The legacy IPC handlers keep returning the old shape.
 */
export const unwrapResult = <T extends LegacyResult>(
  result: T,
  mapReason: (reason: string) => RpcError = conflict
): Omit<T, "success" | "error"> => {
  if (result.success) {
    const { success: _success, error: _error, ...payload } = result;
    return payload;
  }
  throw mapReason(result.error ?? "the operation failed");
};

/** Inputs are logged with these fields blanked. */
const SECRET_FIELDS = new Set([
  "apikey",
  "token",
  "authorization",
  "key",
  "password",
  "secret",
  "clientsecret",
  "values",
]);

export const redactInput = (input: unknown, depth = 0): unknown => {
  if (depth > 4 || input == null || typeof input !== "object") return input;
  if (input instanceof Uint8Array) return `<${input.byteLength} bytes>`;
  if (Array.isArray(input))
    return input.map((item) => redactInput(item, depth + 1));

  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [
      name,
      SECRET_FIELDS.has(name.toLowerCase())
        ? "<redacted>"
        : redactInput(value, depth + 1),
    ])
  );
};

/** `[rpc] <path> <code> <message>`; the stack only for an internal error. */
export const logRpcError = (
  path: readonly string[],
  error: RpcError,
  input: unknown
): void => {
  const line = `[rpc] ${path.join(".")} ${error.code} ${error.message}`;
  if (error.code === "INTERNAL_SERVER_ERROR") {
    console.error(line, { input: redactInput(input) }, error.cause ?? error);
  } else if (error.code !== "RESYNC_REQUIRED") {
    console.warn(line);
  }
};
