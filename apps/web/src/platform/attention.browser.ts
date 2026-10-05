import type { Transport } from "#renderer/data/transport";
import { claimBrowserAttention } from "#renderer/lib/browser/notifications";
/** Cross-tab sound-cue arbitration: one tab wins each cue. */
export const cueClaim =
  (_transport: Transport) => (cueId: string, threadId: string | null) =>
    claimBrowserAttention(`sound:${cueId}:${threadId ?? ""}`);
