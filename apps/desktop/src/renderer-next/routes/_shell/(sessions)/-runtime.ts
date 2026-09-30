import type { Transport } from "#next/data/transport";
import {
  chatRuntimeFor,
  fixtureRuntime,
  type ChatRuntime,
} from "#next/features/chat";
const fixtures = new Map<string, ChatRuntime>();
export const sessionRuntime = (transport: Transport, id: string) => {
  if (import.meta.env.VITE_NEXT_DB_FIXTURES !== "1")
    return chatRuntimeFor(transport);
  let runtime = fixtures.get(id);
  if (!runtime) {
    runtime = fixtureRuntime("session-split", {}, id)!.runtime;
    fixtures.set(id, runtime);
  }
  return runtime;
};
