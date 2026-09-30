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
export const toolRows = (message: UIMessage, scope = ""): string[] => {
  const segments = message.metadata?.abacus?.segments as
    | Array<{ partIndex?: number; groupId?: string }>
    | undefined;
  let previous: string | undefined;
  return message.parts.flatMap((part, index) => {
    const group = segments?.find((s) => s.partIndex === index)?.groupId;
    const header =
      group != null && group !== previous
        ? [`group\0${scope}\0${message.id}\0${group}`]
        : [];
    if (part.type === "tool-result") return [];
    previous = group;
    if (part.type === "tool-call") return [...header, `${scope}\0${part.id}`];
    if (part.type !== "subagent") return header;
    return [
      ...header,
      ...(scope === "" ? [] : [`card\0${part.subagent.id}`]),
      ...part.subagent.messages.flatMap((child) =>
        toolRows(child, part.subagent.id)
      ),
    ];
  });
};
