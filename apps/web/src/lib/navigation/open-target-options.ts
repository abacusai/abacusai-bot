import type { OpenTarget } from "@abacus-ai/contract/contract";

/** Let TanStack serialize params/search and add the platform's basepath. */
export const openTargetOptions = (target: OpenTarget) => {
  if (target.kind === "bot") {
    if (target.sessionId)
      return {
        to: "/bots/$botId/chats/$sessionId",
        params: { botId: target.botId, sessionId: target.sessionId },
      } as const;
    return { to: "/bots/$botId", params: { botId: target.botId } } as const;
  }
  if (target.kind === "routine-run")
    return {
      to: "/routines/$routineId",
      params: { routineId: target.routineId },
      search: { run: target.sessionId },
    } as const;
  return {
    to: "/sessions/$sessionId",
    params: { sessionId: target.sessionId },
  } as const;
};
