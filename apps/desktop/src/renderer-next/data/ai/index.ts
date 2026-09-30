/**
 * The AG-UI conversation over the transport (spec 02 §3): the typed
 * `ai.*` client slice, event ids and error classes. The chat kit's
 * runtime is built on this; nothing here holds state.
 */
import type { Transport } from "#next/data/transport";

export type AiClient = Transport["client"]["ai"];

export { controlOf, eventSeq, resumePoint, type ControlEvent } from "./events";
export { isDefinitive, isNotFound, rpcCode } from "./errors";
