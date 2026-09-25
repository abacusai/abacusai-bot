import { useEffect } from "react";

import { AgentStatus } from "#shared/agent-types";

import { workspaceConversationStore } from "../conversation/store";

// Waiting on a permission prompt counts: sleeping there strands the run too.
const BUSY_STATUSES = new Set<string>([
  AgentStatus.Submitted,
  AgentStatus.Streaming,
  AgentStatus.ExecutingTool,
  AgentStatus.WaitingForToolPermission,
]);

// Reports the busy edge to main, which holds a `powerSaveBlocker` meanwhile.
export function useKeepAwake(): void {
  useEffect(() => {
    let last: boolean | null = null;

    const push = (): void => {
      let busy = false;
      for (const [, state] of workspaceConversationStore.getAll()) {
        if (BUSY_STATUSES.has(state?.status ?? "")) {
          busy = true;
          break;
        }
      }
      if (busy === last) return;
      last = busy;
      void window.api.power?.setAgentBusy?.(busy)?.catch?.(() => {
        /* main not ready yet; the next edge will resync */
      });
    };

    push();
    const unsubscribe = workspaceConversationStore.transport?.subscribe?.(push);

    return () => {
      unsubscribe?.();
      if (last)
        void window.api.power?.setAgentBusy?.(false)?.catch?.(() => undefined);
    };
  }, []);
}
