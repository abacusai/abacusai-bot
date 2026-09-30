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
