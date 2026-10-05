/**
 * Classifying `ai.*` failures (spec 02 §3.7, §4.6). Main raises
 * `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT` and `UNAVAILABLE` only before it
 * writes `run` to the agent, so those are definitive; everything else
 * (`TIMEOUT`, `INTERNAL_SERVER_ERROR`, a transport or port error) is
 * uncertain: the agent may have accepted the prompt.
 */
import { ORPCError } from "@orpc/client";

import type { RpcErrorCode } from "#shared/contract/errors";

export const rpcCode = (error: unknown): RpcErrorCode | null =>
  error instanceof ORPCError ? (error.code as RpcErrorCode) : null;

const DEFINITIVE: ReadonlySet<string> = new Set([
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
]);

export const isDefinitive = (error: unknown): boolean => {
  const code = rpcCode(error);
  return code != null && DEFINITIVE.has(code);
};

export const isNotFound = (error: unknown): boolean =>
  rpcCode(error) === "NOT_FOUND";
