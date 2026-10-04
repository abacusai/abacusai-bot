/**
 * The web app's half of two server pushes on `system.events`:
 *
 * - `open-url`: the server wants a page opened (a connector's sign-in). It
 *   opens in a new tab; a browser that blocks tabs not opened by a click gets
 *   a toast whose button is that click.
 * - `capabilities-changed`: the user's desktop attached or left.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { followNotices } from "#renderer/data/queries/live";
import type { Transport } from "#renderer/data/transport";
import { setCapabilities } from "#renderer/lib/capabilities";
import { toast } from "#renderer/ui/toast";

/** Only our own pages: the server never sends anything else. */
const isOwnPage = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "abacus.ai" ||
        parsed.hostname.endsWith(".abacus.ai"))
    );
  } catch {
    return false;
  }
};

export const WebServerEvents = ({
  transport,
}: {
  transport: Transport;
}): null => {
  const { t } = useTranslation();
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.system.events({}, { signal }),
      (event) => {
        if (event.type === "capabilities-changed") {
          setCapabilities(event.capabilities);
          return;
        }
        if (event.type !== "open-url" || !isOwnPage(event.url)) return;
        const opened = window.open(event.url, "_blank", "noopener");
        if (opened != null) return;
        toast.add({
          title: t("web.openUrl.title"),
          timeout: 0,
          actionProps: {
            children: t("web.openUrl.action"),
            onClick: () => window.open(event.url, "_blank", "noopener"),
          },
        });
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, t]);
  return null;
};
