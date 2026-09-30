/**
 * Reading a thread (spec 02 §4.4, §6): React hooks over the session's host
 * store and the on-screen generation's thread store, plus pure selectors.
 */
import { useSelector } from "@tanstack/react-store";

import type { HostState, ThreadSession } from "../runtime/session";
import {
  toolKey,
  type PermissionDescriptor,
  type ThreadStoreState,
} from "./thread-store";

/** §4.4: any one source says busy. */
export const isBusy = (input: {
  /** `db.sessions` turn column (`pending | streaming | waiting_permission`). */
  turnBusy: boolean;
  activeRun: boolean;
  outbox: number;
}): boolean => input.turnBusy || input.activeRun || input.outbox > 0;

export const useHost = <T>(
  session: ThreadSession,
  selector: (state: HostState) => T
): T => useSelector(session.hostStore, selector);

/** The on-screen generation's thread store, re-bound after every swap. */
export const useThreadStore = <T>(
  session: ThreadSession,
  selector: (state: ThreadStoreState) => T,
  compare?: (a: T, b: T) => boolean
): T => {
  const store = useSelector(session.hostStore, (state) => state.store);
  return useSelector(store, selector, compare != null ? { compare } : undefined);
};

export const useBusy = (session: ThreadSession, turnBusy = false): boolean => {
  const outbox = useHost(session, (state) => state.outbox.length);
  const active = useThreadStore(session, (state) => state.runs.active != null);
  return isBusy({ turnBusy, activeRun: active, outbox });
};

/** The pending descriptor joined to a tool call, if any (§6.2). */
export const descriptorFor = (
  state: ThreadStoreState,
  subagentRunId: string | undefined,
  toolCallId: string
): PermissionDescriptor | undefined => {
  const key = toolKey(subagentRunId, toolCallId);
  return state.permissions.items.find(
    (item) =>
      item.toolCallId != null && toolKey(item.subagentRunId, item.toolCallId) === key
  );
};

export const questionPending = (state: ThreadStoreState): boolean =>
  state.permissions.items.some(
    (item) => item.metadata.abacus.request.type === "ask_user_question"
  );
