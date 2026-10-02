/**
 * The native chrome's state on `<html>` (spec 01 §7.4, §7.7): `data-titlebar`
 * (overlay, overlay-pending, native-frame, overlay-unavailable),
 * `data-density` and `--toolbar-h`, from `window.chrome` (a query main keeps
 * current through `window.events` `chrome` notices).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { windowChromeQuery } from "#renderer/data/queries/window";
import type { Transport } from "#renderer/data/transport";
import type { WindowChromeState } from "#shared/contract";

const DEFAULT_CHROME: WindowChromeState = {
  mode: "overlay-pending",
  fullScreen: false,
  density: "comfortable",
  toolbarHeight: 40,
};

export const useChromeState = (transport: Transport): WindowChromeState => {
  const { data } = useQuery({
    ...windowChromeQuery(transport.orpc),
    // A transport with no window (tests, WebSocket) answers FORBIDDEN.
    retry: false,
  });
  return data ?? DEFAULT_CHROME;
};

const applyChromeState = (doc: Document, chrome: WindowChromeState): void => {
  const root = doc.documentElement;
  root.dataset.titlebar = chrome.mode;
  root.dataset.density = chrome.density;
  root.style.setProperty("--toolbar-h", `${chrome.toolbarHeight}px`);
};

export const ChromeEffect = ({ transport }: { transport: Transport }): null => {
  const chrome = useChromeState(transport);
  useEffect(() => {
    applyChromeState(document, chrome);
  }, [chrome]);
  return null;
};
