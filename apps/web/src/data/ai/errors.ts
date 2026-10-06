/**
 * Classifying `ai.*` failures (spec 02 §3.7, §4.6). Main raises
 * `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT` and `UNAVAILABLE` only before it
 * writes `run` to the agent, so those are definitive; everything else
 * (`TIMEOUT`, `INTERNAL_SERVER_ERROR`, a transport or port error) is
 * uncertain: the agent may have accepted the prompt.
 */
import { isRpcError } from "#renderer/data/query-client";

const DEFINITIVE: ReadonlySet<string> = new Set([
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
]);

export const isDefinitive = (error: unknown): boolean =>
  isRpcError(error) && DEFINITIVE.has(error.code);

export const isNotFound = (error: unknown): boolean =>
  isRpcError(error) && error.code === "NOT_FOUND";
