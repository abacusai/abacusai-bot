import { useSelector } from "@tanstack/react-store";

import type { ChatRuntime } from "../../runtime/runtime";
export const useSubagents = (runtime: ChatRuntime, threadId: string) =>
  useSelector(runtime.session(threadId).hostStore, (s) => s.subagents);
