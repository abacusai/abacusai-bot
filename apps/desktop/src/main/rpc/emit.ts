/** Dispatch host events to the oRPC event bus. */
import type { IpcEvent } from "@abacus-ai/contract/contracts";

import { mainEventBus, type BusChannel, type BusChannels } from "./event-bus";

export const emitHostEvent = (event: IpcEvent): void => {
  // The legacy renderer, unchanged.
  mainEventBus.dispatch(event);
};

/**
 * The bus half alone, for a sender that delivers the legacy event to a
 * specific window itself (the browser runtime's own window).
 */
export const publishIpcEvent = (event: IpcEvent): void => {
  mainEventBus.dispatch(event);
};

/**
 * For the pushes that never used the catch-all: the caller keeps its own
 * legacy send (a different channel, or a different window), and this feeds
 * the bus alongside it.
 */
export const emitBusChannel = <C extends BusChannel>(
  channel: C,
  payload: BusChannels[C]
): void => {
  mainEventBus.dispatchChannel(channel, payload);
};
