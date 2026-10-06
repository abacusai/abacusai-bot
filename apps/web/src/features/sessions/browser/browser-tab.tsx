import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import type { BrowserRuntimeState } from "@abacus-ai/contract/contracts";
import {
  sessionConversationKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Ellipsis,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";

import { BrowserSurface } from "#renderer/components/browser-surface";
import { followNotices } from "#renderer/data/queries/notices";
import { platformSystem } from "#renderer/lib/platform-system";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import { Input } from "#renderer/ui/input";

import { useSessionsTransport } from "../data/queries";
import { acquireLocalFile } from "./local-materialization";
/** What a browser tab opens on when nothing asked for a page. */
export const NEW_TAB_URL = "https://www.google.com/";

export const normalizeAddress = (raw: string): string => {
  const text = raw.trim();
  if (!text) return NEW_TAB_URL;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^localhost:\d/.test(text))
    return text;
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(text)
    ? `http://${text}`
    : `https://${text}`;
};
/**
 * One browser tab over one runtime resource (`id`): its own page, history
 * and address bar. Without a `url` it opens the new-tab page. `onState`
 * reports the page it shows (the strip titles the tab after it).
 */
export const BrowserTab = ({
  row,
  id,
  url,
  file,
  root,
  visible,
  presenter,
  blocked,
  scope,
  onState,
}: {
  row: Pick<SessionRow, "workspaceId" | "id">;
  scope?: ConversationKey;
  id: string;
  url?: string;
  file?: string;
  root: string;
  visible: boolean;
  presenter: ComponentProps<typeof BrowserSurface>["presenter"];
  blocked: ComponentProps<typeof BrowserSurface>["blocked"];
  onState?(state: { url: string; title: string }): void;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<BrowserRuntimeState | null>(null);
  const [address, setAddress] = useState(url ?? NEW_TAB_URL);
  const [error, setError] = useState<string | null>(null);
  const key = scope ?? sessionConversationKey(row.workspaceId, row.id);
  const apply = (next: BrowserRuntimeState) => {
    setState(next);
    setAddress(next.url);
    onState?.({ url: next.url, title: next.title });
  };
  const report = useEffectEvent(apply);
  useEffect(() => {
    let live = true;
    const local = file
      ? acquireLocalFile(transport, {
          conversationKey: key,
          resourceId: id,
          filePath: file,
          hostRoot: root,
        })
      : null;
    const promise = local
      ? local.promise
      : transport.client.browser.runtime.materialize({
          conversationKey: key,
          resourceId: id,
          url: url ?? NEW_TAB_URL,
        });
    void promise
      .then((s) => {
        if (live) {
          setError(null);
          report(s);
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
      local?.release();
    };
  }, [transport, key, id, url, file, root, retry]);
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
        )
          report(event.state);
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
      apply(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col gap-2 p-2">
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessions.browser.back")}
          disabled={!state?.canGoBack || !!file}
          onClick={() => void action({ action: "back" })}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessions.browser.forward")}
          disabled={!state?.canGoForward || !!file}
          onClick={() => void action({ action: "forward" })}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
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
            className="min-w-0 flex-1 rounded-lg"
            aria-label={t("sessions.browser.address")}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                void action({ action: "url", url: normalizeAddress(address) });
              if (e.key === "Escape") {
                setAddress(state?.url ?? NEW_TAB_URL);
                e.currentTarget.blur();
              }
            }}
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessions.browser.external")}
          onClick={() =>
            void platformSystem(transport.client).openExternal({
              url: state?.url ?? address,
            })
          }
        >
          <ExternalLink />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("phase5.manage")}
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {(
              [
                "zoom-out",
                "zoom-reset",
                "zoom-in",
                "open-devtools",
                "clear-site-data",
              ] as const
            ).map((command) => (
              <DropdownMenuItem
                key={command}
                disabled={!state}
                onClick={() => void action({ action: command })}
              >
                {t(`sessions.browser.${command}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error ? (
        <div role="alert">
          <p>{t("sessions.browser.unavailable")}</p>
          <p>{error}</p>
          <Button
            onClick={() => {
              setError(null);
              setState(null);
              setRetry((n) => n + 1);
            }}
          >
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
