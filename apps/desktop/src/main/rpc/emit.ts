/**
 * The one path every main-to-renderer push takes (spec 00 A.4.3): the legacy
 * renderer's channel and the oRPC event bus are fed from the same call, so
 * they cannot diverge. Any new sender uses these, never `sendToRenderer`
 * directly: emit.test.ts fails on `sendToRenderer(IpcChannels.Event` outside
 * this file (oxlint has no `no-restricted-syntax` to say it as a rule).
 */
import { IpcChannels } from "#shared/channels";
import type { IpcEvent } from "#shared/contracts";

import { sendToRenderer } from "../renderer-host";
import { mainEventBus, type BusChannel, type BusChannels } from "./event-bus";

export const emitIpcEvent = (event: IpcEvent): void => {
  // The legacy renderer, unchanged.
  sendToRenderer(IpcChannels.Event, event);
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
