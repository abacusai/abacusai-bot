import type { Transport } from "#renderer/data/transport";
/** Cross-window sound-cue arbitration: main decides on Electron. */
export const cueClaim =
  (transport: Transport) => (cueId: string, threadId: string | null) =>
    transport.client.window
      .claimCue({ cueId, threadId })
      .then((result) => result.play);
