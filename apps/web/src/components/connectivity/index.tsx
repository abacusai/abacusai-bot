/**
 * Whether this computer is online, as main's connectivity owner says
 * (`status.connectivity`, kept fresh by `status.events`), and the one banner
 * that tells the user so: their internet dropped, not the app; or AbacusAI is
 * not answering while their internet is fine. A short "Back online" follows.
 */
import type { QueuedChatSend } from "@abacus-ai/contract/messaging";
import type { ConnectivitySnapshot } from "@abacus-ai/contract/status";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff, WifiOff } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { followNotice } from "#renderer/data/queries/notices";
import { cn } from "#renderer/lib/cn";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";

const ONLINE: ConnectivitySnapshot = {
  state: "online",
  since: null,
  nextCheckAt: null,
};

/** A blip shorter than this never shows: the banner would only flash. */
export const OFFLINE_SHOW_AFTER_MS = 3_000;
/** How long "Back online" stays up. */
const BACK_ONLINE_MS = 4_000;

/** The gallery's state and waiting sends, in place of the live ones. */
export const ConnectivityPreview = createContext<{
  snapshot: ConnectivitySnapshot;
  queued?: QueuedChatSend[];
} | null>(null);

/** The connectivity owner's snapshot; always online off the desktop. */
export const useConnectivity = (): ConnectivitySnapshot => {
  const preview = useContext(ConnectivityPreview);
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const options = transport.orpc.status.connectivity.queryOptions({
    input: {},
  });
  const query = useQuery({ ...options, enabled: IS_ELECTRON });
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const abort = new AbortController();
    followNotice(
      "status",
      transport,
      (event) => {
        if (event.type === "connectivity")
          void cache.invalidateQueries({ queryKey: options.queryKey });
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, cache, options.queryKey]);
  return preview?.snapshot ?? query.data ?? ONLINE;
};

const NO_SENDS: QueuedChatSend[] = [];

/** The agent's chat-app sends waiting for the connection; empty off the desktop. */
export const useQueuedSends = (): QueuedChatSend[] => {
  const preview = useContext(ConnectivityPreview);
  const { transport } = useAppContext();
  const { data } = useQuery({
    ...transport.orpc.messaging.snapshot.queryOptions({ input: {} }),
    enabled: IS_ELECTRON,
  });
  return preview?.queued ?? data?.queued ?? NO_SENDS;
};

/** The time now, ticking every second while `active`. */
export const useSecondTick = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

/** Offline long enough to say so: past the blip window. */
export const shownOffline = (
  snapshot: ConnectivitySnapshot,
  now: number
): boolean =>
  snapshot.state !== "online" &&
  (snapshot.since == null || now - snapshot.since >= OFFLINE_SHOW_AFTER_MS);

export interface ConnectivityBannerProps {
  /** The gallery's state, in place of the live one. */
  preview?: {
    snapshot: ConnectivitySnapshot;
    backOnline?: boolean;
    waiting?: number;
  };
}

/** The top-of-pane line while not online, and briefly once it is back. */
export const ConnectivityBanner = ({ preview }: ConnectivityBannerProps) => {
  const live = useConnectivity();
  const waiting = useQueuedSends().filter(
    (send) => send.status === "queued"
  ).length;
  const snapshot = preview?.snapshot ?? live;
  const now = useSecondTick(snapshot.state !== "online");
  const showing = shownOffline(snapshot, now);
  // "Back online" only after the banner was up, never after a blip.
  const [wasShowing, setWasShowing] = useState(showing);
  const [back, setBack] = useState(false);
  // How many were waiting the moment it came back: they leave as they go.
  const [backWaiting, setBackWaiting] = useState(0);
  if (wasShowing !== showing && (showing || snapshot.state === "online")) {
    setWasShowing(showing);
    setBack(!showing);
    setBackWaiting(waiting);
  }
  useEffect(() => {
    if (!back) return;
    const timer = setTimeout(() => setBack(false), BACK_ONLINE_MS);
    return () => clearTimeout(timer);
  }, [back]);
  if (preview?.backOnline === true)
    return <BackOnline waiting={preview.waiting ?? 0} />;
  if (showing) return <OfflineLine snapshot={snapshot} now={now} />;
  if (back) return <BackOnline waiting={backWaiting} />;
  return null;
};

const OfflineLine = ({
  snapshot,
  now,
}: {
  snapshot: ConnectivitySnapshot;
  now: number;
}) => {
  const { t } = useTranslation();
  const ours = snapshot.state === "degraded";
  const Icon = ours ? CloudOff : WifiOff;
  const seconds =
    snapshot.nextCheckAt == null
      ? null
      : Math.max(1, Math.ceil((snapshot.nextCheckAt - now) / 1000));
  return (
    <div
      role="status"
      data-slot="connectivity-banner"
      data-state={snapshot.state}
      className={cn(
        "flex shrink-0 items-start gap-3 border-b px-4 py-2.5 text-sm",
        ours
          ? "bg-muted/60 text-foreground"
          : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          ours ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"
        )}
      />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">
          {t(
            ours
              ? "connectivity.banner.abacusTitle"
              : "connectivity.banner.offlineTitle"
          )}
        </span>{" "}
        {t(
          ours
            ? "connectivity.banner.abacusBody"
            : "connectivity.banner.offlineBody"
        )}
      </p>
      {seconds != null && (
        <span
          data-slot="connectivity-next-check"
          className={cn(
            "shrink-0 text-xs whitespace-nowrap tabular-nums",
            ours
              ? "text-muted-foreground"
              : "text-amber-800 dark:text-amber-300"
          )}
        >
          {t("connectivity.banner.checkingIn", { seconds })}
        </span>
      )}
    </div>
  );
};

const BackOnline = ({ waiting }: { waiting: number }) => {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-slot="connectivity-banner"
      data-state="back"
      className="flex shrink-0 items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200"
    >
      <p className="min-w-0">
        <span className="font-semibold">
          {t("connectivity.banner.backTitle")}
        </span>
        {waiting > 0 && (
          <> {t("connectivity.banner.backSending", { count: waiting })}</>
        )}
      </p>
    </div>
  );
};
