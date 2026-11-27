/**
 * An app installed or uninstalled anywhere (its own window, an agent's tool)
 * reaches every install button and the artifacts list as one window event.
 */
import { useEffect } from "react";

import { INSTALLED_APPS_CHANGED } from "#renderer/components/file-preview/install-app-button";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";

export const InstalledAppsHost = ({ transport }: { transport: Transport }) => {
  useEffect(() => {
    const abort = new AbortController();
    followNotice(
      "system",
      transport,
      (event) => {
        if (event.type === "installed-apps-changed")
          window.dispatchEvent(new Event(INSTALLED_APPS_CHANGED));
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  return null;
};
