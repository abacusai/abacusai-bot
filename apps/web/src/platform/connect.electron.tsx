import type { Root } from "react-dom/client";
/**
 * Electron's MessagePort needs no connect step: main.tsx boots below
 * (`bootstrap()` before the router).
 */
export const mountPlatformApp = async (_root: Root): Promise<boolean> => false;
/** The host connection banner is the browser's. */
export const HostStatus = (): null => null;
