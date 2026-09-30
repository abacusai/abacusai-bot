/**
 * Vendored from pi-acp (MIT, Copyright (c) 2025 Victor Software House; see
 * ./LICENSE), src/acp/session.ts:151-170 (`mapPiStopReason`) at commit
 * 0ef24b24c97ac81a5e87a17d8fd74ef97fb34d8b.
 *
 * Changes: kept as `toAcpStopReason`; `toFinishReason` added for TanStack's
 * RUN_FINISHED. A settled run is final, so `toolUse` maps to "stop": the
 * client treats "tool_calls" as an intermediate hand-off and would never
 * finish processing (spec finding r2-16).
 */

export type AcpStopReason = "end_turn" | "cancelled" | "max_tokens" | "error";

export function toAcpStopReason(piReason: string | null | undefined): AcpStopReason {
  switch (piReason) {
    case "stop":
    case "toolUse":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "aborted":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "end_turn";
  }
}

/** A final run terminal's finish reason: never "tool_calls". */
export function toFinishReason(
  piReason: string | null | undefined
): "stop" | "length" | null {
  switch (piReason) {
    case "stop":
    case "toolUse":
    case "deferred":
      return "stop";
    case "length":
      return "length";
    default:
      return null;
  }
}
