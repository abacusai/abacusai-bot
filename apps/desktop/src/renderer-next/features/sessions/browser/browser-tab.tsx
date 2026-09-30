import { ArrowLeft, ArrowRight, RotateCw, ExternalLink } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { BrowserSurface } from "#next/components/browser-surface";
import { followNotices } from "#next/data/queries/live";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
import type { SessionRow } from "#shared/contract/rows";
import type { BrowserRuntimeState } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";

import { useSessionsTransport } from "../data/queries";
export const normalizeAddress = (raw: string): string => {
  const text = raw.trim();
  if (!text) return "about:blank";
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^localhost:\d/.test(text))
    return text;
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(text)
    ? `http://${text}`
    : `https://${text}`;
};
export const BrowserTab = ({
  row,
  id,
  url,
  file,
  root,
  visible,
  presenter,
  blocked,
}: {
  row: SessionRow;
  id: string;
  url?: string;
  file?: string;
  root: string;
  visible: boolean;
  presenter: ComponentProps<typeof BrowserSurface>["presenter"];
  blocked: ComponentProps<typeof BrowserSurface>["blocked"];
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const [state, setState] = useState<BrowserRuntimeState | null>(null);
  const [address, setAddress] = useState(url ?? "about:blank");
  const [error, setError] = useState<string | null>(null);
  const key = sessionConversationKey(row.workspaceId, row.id);
  useEffect(() => {
    let live = true;
    const promise = file
      ? transport.client.browser.runtime.materializeFile({
          conversationKey: key,
          resourceId: id,
          filePath: file,
          hostRoot: root,
        })
      : transport.client.browser.runtime.materialize({
          conversationKey: key,
          resourceId: id,
          ...(url ? { url } : {}),
        });
    void promise
      .then((s) => {
        if (live) {
          setState(s);
          setAddress(s.url);
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [transport, key, id, url, file, root]);
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.browser.events({ conversationKey: key }, { signal }),
      (event) => {
        if (
          event.type === "runtime-state" &&
          event.state.lease.resourceId === id
        ) {
          setState(event.state);
          setAddress(event.state.url);
        }
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, key, id]);
  const action = async (
    navigation: Parameters<
      typeof transport.client.browser.runtime.navigate
    >[0]["navigation"]
  ) => {
    if (!state) return;
    try {
      const s = await transport.client.browser.runtime.navigate({
        lease: state.lease,
        navigation,
      });
      setState(s);
      setAddress(s.url);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="flex size-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("sessions.browser.back")}
          disabled={!state?.canGoBack || !!file}
          onClick={() => void action({ action: "back" })}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("sessions.browser.forward")}
          disabled={!state?.canGoForward || !!file}
          onClick={() => void action({ action: "forward" })}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("sessions.browser.reload")}
          onClick={() =>
            void action({ action: state?.loading ? "stop" : "reload" })
          }
        >
          <RotateCw />
        </Button>
        {file ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {file}
          </span>
        ) : (
          <Input
            className="rounded-full"
            aria-label={t("sessions.browser.address")}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                void action({ action: "url", url: normalizeAddress(address) });
              if (e.key === "Escape") {
                setAddress(state?.url ?? "about:blank");
                e.currentTarget.blur();
              }
            }}
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("sessions.browser.external")}
          onClick={() =>
            void transport.client.system.openExternal({
              url: state?.url ?? address,
            })
          }
        >
          <ExternalLink />
        </Button>
      </div>
      {error ? (
        <div role="alert">
          <p>{t("sessions.browser.unavailable")}</p>
          <p>{error}</p>
          <Button onClick={() => void action({ action: "hard-reload" })}>
            {t("sessions.common.retry")}
          </Button>
        </div>
      ) : null}
      {state ? (
        <BrowserSurface
          lease={state.lease}
          presenter={presenter}
          visible={visible}
          blocked={blocked}
        />
      ) : null}
    </div>
  );
};
