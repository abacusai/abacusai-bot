import type { BrowserPermissionRequest } from "@abacus-ai/contract/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { followNotice } from "#renderer/data/queries/notices";
import { Button } from "#renderer/ui/button";

import { useSessionsTransport } from "../data/queries";
export const BrowserAskHost = () => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const [asks, setAsks] = useState<BrowserPermissionRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    followNotice(
      "browser",
      transport,
      (event) => {
        if (event.type === "snapshot") setAsks(event.permissionRequests);
        if (event.type === "permission-request")
          setAsks((s) =>
            s.some((r) => r.requestId === event.request.requestId)
              ? s
              : [...s, event.request]
          );
        if (event.type === "permission-cleared")
          setAsks((s) => s.filter((r) => r.requestId !== event.requestId));
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  const ask = asks[0];
  if (!ask) return null;
  const respond = async (decision: "allow" | "deny" | "session" | "always") => {
    try {
      await transport.client.browser.permissions.respond({
        requestId: ask.requestId,
        conversationKey: ask.conversationKey,
        decision,
      });
      setAsks((s) => s.filter((r) => r.requestId !== ask.requestId));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section
      role="dialog"
      aria-label={
        ask.site != null
          ? t("sessions.browser.site.title", { site: ask.site })
          : t("sessions.browser.permission")
      }
      className="bg-popover text-popover-foreground fixed right-6 bottom-6 z-50 flex max-w-md flex-col gap-3 rounded-xl border p-4 shadow-lg"
    >
      <h2 className="font-semibold">
        {ask.site != null
          ? t("sessions.browser.site.title", { site: ask.site })
          : t("sessions.browser.permission")}
      </h2>
      <p>{ask.summary}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {(ask.site != null
          ? // A site's sign-in: this chat, for good, or no.
            (["allow", "always", "deny"] as const)
          : (["allow", "deny", "session", "always"] as const)
        ).map((decision) => (
          <Button
            key={decision}
            variant={decision === "allow" ? "default" : "outline"}
            onClick={() => void respond(decision)}
          >
            {t(
              ask.site != null
                ? `sessions.browser.site.${decision}`
                : `sessions.browser.${decision}`
            )}
          </Button>
        ))}
      </div>
    </section>
  );
};
