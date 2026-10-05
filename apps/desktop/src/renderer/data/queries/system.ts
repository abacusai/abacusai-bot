import type { AppQueryUtils } from "#renderer/data/transport";

/** Facts that never change while this document lives. */
export const systemInfoQuery = (orpc: AppQueryUtils) =>
  orpc.system.info.queryOptions({ input: {}, staleTime: Infinity });
