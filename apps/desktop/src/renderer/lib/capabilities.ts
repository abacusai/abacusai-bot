/**
 * What this app can do where it runs (`system.capabilities`): everything on
 * the desktop; on the web, what our servers can do for the user, plus coding
 * while their desktop is attached. Read once at boot (web only) and kept
 * current by the server's `capabilities-changed` push. Screens hide what is
 * off; the server refuses it regardless.
 */
import { Store, useStore } from "@tanstack/react-store";

import type { Transport } from "#renderer/data/transport";
import { isWebApp } from "#renderer/lib/web-app";
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  type Capabilities,
  type Capability,
} from "#shared/contract";

/** A web tab offers nothing until its server says what it can do. */
const NONE = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, false])
) as Capabilities;

export const capabilitiesStore = new Store<Capabilities>(
  isWebApp ? NONE : ALL_CAPABILITIES
);

/** At boot, before the router; the desktop can do everything and asks nothing. */
export const loadCapabilities = async (transport: Transport): Promise<void> => {
  if (!isWebApp) return;
  try {
    setCapabilities(await transport.client.system.capabilities({}));
  } catch (error) {
    console.error("[capabilities] unavailable; offering the minimum", error);
  }
};

export const setCapabilities = (capabilities: Capabilities): void => {
  capabilitiesStore.setState(() => capabilities);
};

export const useCapabilities = (): Capabilities => useStore(capabilitiesStore);

export const useCapability = (capability: Capability): boolean =>
  useStore(capabilitiesStore, (state) => state[capability]);
