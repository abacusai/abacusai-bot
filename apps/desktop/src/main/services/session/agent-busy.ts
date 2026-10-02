/**
 * "Is an agent turn in flight?" for keep-awake, the background-task notice,
 * the update restart and the renderer swap (spec 07 review r1 #10). An agui
 * runtime's answer is the relay's run state: its `RUN_STARTED` and terminal
 * arrive on stdout, while the compat events that drive main's turn state
 * arrive on fd 3, ordered independently, so turn state could say idle while
 * the run is open or busy after it ended. An ndjson runtime has only turn
 * state.
 */
import type { AgentWire } from "./cli-manager-service";

export const agentTurnBusy = (sources: {
  relay: { readonly busy: boolean };
  turnState: { hasBusyTurn(exclude?: (sessionId: string) => boolean): boolean };
  wireOf(sessionId: string): AgentWire | null;
}): boolean =>
  sources.relay.busy ||
  sources.turnState.hasBusyTurn(
    (sessionId) => sources.wireOf(sessionId) === "agui"
  );
