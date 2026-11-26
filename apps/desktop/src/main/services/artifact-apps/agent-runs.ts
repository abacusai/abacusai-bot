/**
 * When the agent tests a page in its browser (`browser_task`), what it types
 * into a page that saves data is test data: the store puts those keys back
 * when the run ends (store.ts). A run the turn ends without completing counts
 * as ended too.
 */
import type { DesktopEvent } from "@abacus-ai/contract/agent-types";

import { agentBrowserRunEnded, agentBrowserRunStarted } from "./store";

const BROWSER_TASK = /(^|__)browser_task$/;

export const agentBrowserRunListener = () => {
  const open = new Map<string, number>();
  const end = (sessionId: string, all: boolean): void => {
    const runs = open.get(sessionId) ?? 0;
    if (runs === 0) return;
    const ending = all ? runs : 1;
    if (runs - ending > 0) open.set(sessionId, runs - ending);
    else open.delete(sessionId);
    for (let i = 0; i < ending; i++) agentBrowserRunEnded();
  };
  return (sessionId: string, payload: DesktopEvent): void => {
    if (payload.type !== "event") return;
    const event = payload.event;
    if (
      event.type === "tool_execution_start" &&
      BROWSER_TASK.test(event.tool.name)
    ) {
      open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
      agentBrowserRunStarted();
    } else if (
      event.type === "tool_execution_complete" &&
      BROWSER_TASK.test(event.tool.name)
    )
      end(sessionId, false);
    else if (event.type === "turn_complete") end(sessionId, true);
  };
};
