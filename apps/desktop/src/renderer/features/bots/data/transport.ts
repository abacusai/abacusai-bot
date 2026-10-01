/**
 * The document's transport for bots components, from the router context
 * (the same one every loader gets). Tests give their router a context.
 */
import { useRouter } from "@tanstack/react-router";

import type { Transport } from "#renderer/data/transport";

export const useBotsTransport = (): Transport =>
  (useRouter().options.context as { transport: Transport }).transport;
