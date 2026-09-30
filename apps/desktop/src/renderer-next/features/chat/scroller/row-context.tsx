import type { UIMessage } from "@tanstack/ai-client";
import { createContext, use } from "react";

import type { Range } from "./window";

export interface ToolWindow {
  ids: readonly string[];
  range: Range;
  more(): void;
  earlier(): void;
}
const Context = createContext<ToolWindow | null>(null);
export const ToolWindowProvider = Context.Provider;
export const useToolWindow = () => use(Context);

/** Scoped child tools participate in their enclosing message's row budget. */
export const toolRows = (message: UIMessage, scope = ""): string[] =>
  message.parts.flatMap((part) => {
    if (part.type === "tool-call") return [`${scope}\0${part.id}`];
    if (part.type !== "subagent") return [];
    return [
      ...(scope === "" ? [] : [`card\0${part.subagent.id}`]),
      ...part.subagent.messages.flatMap((child) =>
        toolRows(child, part.subagent.id)
      ),
    ];
  });
