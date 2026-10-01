import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Ellipsis,
} from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { BrowserSurface } from "#renderer/components/browser-surface";
import { followNotices } from "#renderer/data/queries/live";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import { Input } from "#renderer/ui/input";
import type { SessionRow } from "#shared/contract/rows";
import type { BrowserRuntimeState } from "#shared/contracts";
import {
  sessionConversationKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import { useSessionsTransport } from "../data/queries";
import { acquireLocalFile } from "./local-materialization";
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
  scope,
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
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const [retry, setRetry] = useState(0);
  const [profile, setProfile] = useState<string | undefined>();
  const profiles = useQuery(
    transport.orpc.browser.profiles.list.queryOptions({ input: {} })
  );
  const [state, setState] = useState<BrowserRuntimeState | null>(null);
  const [address, setAddress] = useState(url ?? "about:blank");
  const [error, setError] = useState<string | null>(null);
  const key = scope ?? sessionConversationKey(row.workspaceId, row.id);
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
          ...(url ? { url } : {}),
          ...(profile ? { profileId: profile } : {}),
        });
    void promise
      .then((s) => {
        if (live) {
          setError(null);
          setState(s);
          setAddress(s.url);
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
      local?.release();
    };
  }, [transport, key, id, url, file, root, retry, profile]);
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
                setAddress(state?.url ?? "about:blank");
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
            void transport.client.system.openExternal({
              url: state?.url ?? address,
            })
          }
        >
          <ExternalLink />
        </Button>
      </div>
      <div className="flex min-w-0 shrink-0 items-center justify-between gap-1">
        {!file ? (
          <select
            className="bg-card max-w-full min-w-0 flex-1 rounded-lg border px-2 py-1 text-xs"
            aria-label={t("sessions.browser.profile")}
            value={profile ?? ""}
            onChange={(e) => setProfile(e.target.value || undefined)}
          >
            <option value="">{t("sessions.browser.defaultProfile")}</option>
            {profiles.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.browserName} · {p.profileName}
              </option>
            ))}
          </select>
        ) : null}
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
