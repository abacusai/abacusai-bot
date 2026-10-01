import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#next/components/form-kit/confirm";
import { NavList } from "#next/components/nav-list";
import { useCollectionStatus } from "#next/data/db/status";
import { AppLink } from "#next/lib/navigation/app-link";
import { showError } from "#next/lib/toast";
import { useAppContext, foldSearch } from "#next/lib/use-app-context";
import { useNow } from "#next/lib/use-now";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";

import { routineConnectorThreads } from "./attention";
import { stats, routineState, scheduleLabel, useRoutinesData } from "./data";
import { routineOwns } from "./notify";
import { RoutineSidebarRow } from "./row";
export const RoutinesSidebar = () => {
  const { t, i18n } = useTranslation();
  const connectorThreads = useStore(routineConnectorThreads, (state) => state);
  const asks = new Set(connectorThreads);
  const { db, transport } = useAppContext();
  const { routines, runs, sessions, bots } = useRoutinesData();
  const status = useCollectionStatus(db.collections.routines);
  const { routineId } = useParams({ strict: false }) as { routineId?: string };
  const [q, setQ] = useState("");
  const now = useNow();
  const counts = stats(routines, new Date(now));
  const snapshot = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const chats = useQuery(
    transport.orpc.bots.senderChats.queryOptions({ input: {} })
  );
  const cache = useQueryClient();
  const decide = async (
    platformId: Parameters<
      typeof transport.client.messaging.decidePairing
    >[0]["platformId"],
    userId: string,
    decision: "pause" | "resume" | "revoke"
  ) => {
    const next = await transport.client.messaging.decidePairing({
      platformId,
      userId,
      decision,
    });
    cache.setQueryData(
      transport.orpc.messaging.snapshot.queryKey({ input: {} }),
      next
    );
  };
  const ordered = routines
    .filter((r) => foldSearch(r.name + " " + r.prompt).includes(foldSearch(q)))
    .toSorted(
      (a, b) =>
        Number(routineState(b, runs, sessions, asks) === "running") -
          Number(routineState(a, runs, sessions, asks) === "running") ||
        a.name.localeCompare(b.name)
    );
  return (
    <NavList.Root label={t("routines.sidebar.label")}>
      <Input
        aria-label={t("phase5.searchRoutines")}
        placeholder={t("phase5.searchRoutines")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQ("");
        }}
      />
      {routines.length > 0 && (
        <p className="text-muted-foreground px-2 py-2 text-xs">
          {t("phase5.routineStats", counts)}
        </p>
      )}
      {status === "error" ? (
        <NavList.Error
          message={t("shell.sidebar.loadError")}
          retryLabel={t("shell.sidebar.retry")}
          onRetry={() => void db.collections.routines.utils.resync()}
        />
      ) : status !== "ready" ? (
        <NavList.Skeleton />
      ) : (
        <NavList.Rows>
          {ordered.map((r) => {
            const state = routineState(r, runs, sessions, asks);
            return (
              <RoutineSidebarRow
                key={r.id}
                row={r}
                bot={bots.find((b) => b.id === r.botId)}
                state={state}
                active={routineId === r.id}
                label={
                  state === "scheduled"
                    ? scheduleLabel(r, t, i18n.language)
                    : t(`phase5.states.${state}`)
                }
              />
            );
          })}
        </NavList.Rows>
      )}
      {!q && (snapshot.data?.autoReplies.length ?? 0) > 0 && (
        <NavList.Group label={t("phase5.autoReplies")}>
          {snapshot.data?.autoReplies.map((grant) => {
            const chat = chats.data?.find(
              (s) =>
                s.botId === grant.botId &&
                s.platform === grant.platform &&
                s.userId === grant.userId
            );
            return (
              <div
                key={`${grant.platform}:${grant.userId}`}
                className="flex flex-col gap-1 rounded-lg px-2 py-2 text-xs"
              >
                {chat ? (
                  <AppLink
                    to="/bots/$botId/chats/$sessionId"
                    params={{ botId: grant.botId!, sessionId: chat.sessionId }}
                  >
                    {bots.find((b) => b.id === grant.botId)?.name ??
                      grant.botId}{" "}
                    → {grant.userName ?? grant.userId}
                  </AppLink>
                ) : (
                  <span>
                    {bots.find((b) => b.id === grant.botId)?.name ??
                      grant.botId}{" "}
                    → {grant.userName ?? grant.userId}
                  </span>
                )}
                <span className="text-muted-foreground">
                  {grant.platform} ·{" "}
                  {t(
                    grant.status === "paused"
                      ? "phase5.states.paused"
                      : "phase5.on"
                  )}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void decide(
                        grant.platform,
                        grant.userId,
                        grant.status === "paused" ? "resume" : "pause"
                      ).catch(() => showError(t("phase5.failed")))
                    }
                  >
                    {t(
                      grant.status === "paused"
                        ? "phase5.resume"
                        : "phase5.pause"
                    )}
                  </Button>
                  <ConfirmAction
                    title={t("phase5.revokeTitle")}
                    description={t("phase5.revokeDescription")}
                    label={t("phase5.revoke")}
                    onConfirm={() =>
                      decide(grant.platform, grant.userId, "revoke")
                    }
                  />
                </div>
              </div>
            );
          })}
        </NavList.Group>
      )}
      <Button
        nativeButton={false}
        variant="secondary"
        className="mt-auto"
        render={<AppLink to="/routines/new" transition="none" />}
      >
        {t("routines.sidebar.new")}
      </Button>
    </NavList.Root>
  );
};
export const RoutinesNeedsYou = () => {
  const connectors = useStore(routineConnectorThreads, (s) => s);
  const { t } = useTranslation();
  const { routines, sessions } = useRoutinesData();
  const waiting = sessions.filter(
    (s) =>
      s.routineId != null &&
      routineOwns(routines.find((r) => r.id === s.routineId)) &&
      (s.turn?.phase === "waiting_permission" || connectors.includes(s.id))
  );
  if (!waiting.length) return null;
  return (
    <NavList.Group label={t("phase5.needsYou")}>
      {waiting.map((s) => {
        const r = routines.find((r) => r.id === s.routineId);
        if (!r) return null;
        return (
          <NavList.Item
            key={s.id}
            to="/routines/$routineId"
            params={{ routineId: r.id }}
            search={{ run: s.id }}
            title={t("phase5.routineNeedsYou", { name: r.name })}
          />
        );
      })}
    </NavList.Group>
  );
};
