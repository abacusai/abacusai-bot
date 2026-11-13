import type { MemoryEvent } from "@abacus-ai/contract/contract";

import {
  clearMemory,
  memoryHistory,
  memoryProjects,
  memoryWithheld,
  saveNote,
  undoChange,
} from "../../services/memory/memory-service";
import { impl, onChannel, stream } from "./impl";

export const memoryRouter = impl.memory.router({
  customInstructions: {
    get: impl.memory.customInstructions.get.handler(({ context }) =>
      context.deps.host.getCustomInstructions()
    ),
    set: impl.memory.customInstructions.set.handler(({ input, context }) =>
      context.deps.host.setCustomInstructions(input.text)
    ),
  },
  projects: impl.memory.projects.handler(() => memoryProjects()),
  chatProject: impl.memory.chatProject.handler(({ input, context }) =>
    context.deps.serviceHost.memoryProjectForChat(input.sessionId)
  ),
  save: impl.memory.save.handler(({ input }) => saveNote(input)),
  clear: impl.memory.clear.handler(async ({ input }) => {
    await clearMemory(input);
    return null;
  }),
  history: impl.memory.history.handler(() => memoryHistory()),
  undo: impl.memory.undo.handler(async ({ input }) => {
    await undoChange(input.id);
    return null;
  }),
  withheld: impl.memory.withheld.handler(() => memoryWithheld()),
  // Published by the memory watcher on every change to the history.
  events: impl.memory.events.handler(({ context, signal }) =>
    stream<MemoryEvent>({
      path: "memory.events",
      context,
      signal,
      attach: onChannel(context, "memory", (payload) => payload),
      coalesceKey: (event) => event.type,
    })
  ),
});
