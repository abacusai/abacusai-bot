import type { Root } from "react-dom/client";
/** Electron's MessagePort needs no connect step. */
export const connectHost = async (
  _root: Root,
  _restart: () => void,
  _forceRestart: boolean
): Promise<void> => {};
