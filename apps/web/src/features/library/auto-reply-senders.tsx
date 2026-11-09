import type {
  MessagingPairedUser,
  MessagingSnapshot,
  UpdateMessagingSettingsRequest,
} from "@abacus-ai/contract/messaging";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { SettingSwitch } from "#renderer/components/form-kit/controls";
import {
  GroupCard,
  PageNote,
  SettingRow,
} from "#renderer/components/form-kit/page";
import { useMutation, useMutationState } from "#renderer/data/query-client";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

/**
 * Who auto-reply answers, in one place: the switch, the rule it follows, the
 * people and groups it answers and the ones waiting for a decision. Turning it
 * on first shows exactly who will be answered.
 */
export const AutoReplySenders = ({
  snapshot: s,
  update,
  writesSnapshot,
}: {
  snapshot: MessagingSnapshot;
  update(patch: UpdateMessagingSettingsRequest): void;
  writesSnapshot: { onSuccess(next: MessagingSnapshot): void };
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [confirming, setConfirming] = useState(false);
  const decide = useMutation(
    transport.orpc.messaging.decidePairing.mutationOptions(writesSnapshot)
  );
  // Per sender: deciding one leaves the others' buttons usable.
  const deciding = useMutationState({
    filters: {
      mutationKey: transport.orpc.messaging.decidePairing.mutationKey(),
      status: "pending",
    },
    select: (mutation) =>
      (mutation.state.variables as { userId: string }).userId,
  });
  const platformName = (row: MessagingPairedUser) =>
    t(
      `messaging.platforms.${s.platforms.find((p) => p.id === row.platform)?.nameKey ?? row.platform}`
    );
  const detailOf = (row: MessagingPairedUser) =>
    [
      platformName(row),
      row.kind === "group" ? t("phase5.autoReplyGroup") : null,
      row.autoAdded === true ? t("phase5.autoReplyAutoAdded") : null,
    ]
      .filter((part) => part != null)
      .join(" · ");
  const approveButtons = (row: MessagingPairedUser) =>
    (["approve", "revoke"] as const).map((decision) => (
      <Button
        key={decision}
        size="sm"
        variant={decision === "approve" ? "default" : "ghost"}
        disabled={deciding.includes(row.userId)}
        onClick={() =>
          decide.mutate({
            platformId: row.platform,
            userId: row.userId,
            decision,
          })
        }
      >
        {t(decision === "approve" ? "phase5.approve" : "phase5.reject")}
      </Button>
    ));
  const waiting = s.pending;
  const answeredList = (
    <ul className="flex flex-col gap-1 text-[13px]" data-auto-reply-answered>
      <li>{t("phase5.autoReplyOwnChat")}</li>
      {s.answered.map((row) => (
        <li key={`${row.platform}:${row.userId}`}>
          {row.userName ?? row.userId}
          <span className="text-muted-foreground"> · {detailOf(row)}</span>
        </li>
      ))}
      {s.answerPrivateChats && <li>{t("phase5.autoReplyAnyonePrivate")}</li>}
      {s.answered.length === 0 && !s.answerPrivateChats && (
        <li className="text-muted-foreground">
          {t("phase5.autoReplyNobodyElse")}
        </li>
      )}
      {s.reapprove.length > 0 && (
        <li className="text-muted-foreground">
          {t("phase5.autoReplyReapprove", { count: s.reapprove.length })}
        </li>
      )}
      {waiting.length > 0 && (
        <li className="text-muted-foreground">
          {t("phase5.autoReplyRecentlyWrote", {
            names: waiting
              .slice(0, 5)
              .map((row) => row.userName ?? row.userId)
              .join(", "),
          })}
        </li>
      )}
    </ul>
  );
  return (
    <GroupCard title={t("phase5.autoReplyTitle")}>
      <SettingRow
        id="respondToInbound"
        title={t("phase5.respondInbound")}
        detail={t("phase5.autoReplyRule")}
      >
        <SettingSwitch
          id="respondToInbound"
          checked={s.respondToInbound}
          onCheckedChange={(on) =>
            on ? setConfirming(true) : update({ respondToInbound: false })
          }
        />
      </SettingRow>
      <SettingRow
        id="answerPrivateChats"
        title={t("phase5.answerPrivateChats")}
        detail={t("phase5.answerPrivateChatsDetail")}
      >
        <SettingSwitch
          id="answerPrivateChats"
          checked={s.answerPrivateChats}
          onCheckedChange={(on) => update({ answerPrivateChats: on })}
        />
      </SettingRow>
      {s.answered.map((row) => (
        <SettingRow
          key={`answered:${row.platform}:${row.userId}`}
          id={`answered-${row.platform}-${row.userId}`}
          title={row.userName ?? row.userId}
          detail={detailOf(row)}
        >
          <ConfirmAction
            title={t("phase5.revokeTitle")}
            description={t("phase5.revokeDescription")}
            label={t("phase5.autoReplyRemove")}
            onConfirm={() =>
              decide.mutateAsync({
                platformId: row.platform,
                userId: row.userId,
                decision: "revoke",
              })
            }
          />
        </SettingRow>
      ))}
      {s.reapprove.length > 0 && (
        <div className="px-3 pt-3">
          <PageNote>
            {t("phase5.autoReplyReapprove", { count: s.reapprove.length })}
          </PageNote>
        </div>
      )}
      {s.reapprove.map((row) => (
        <SettingRow
          key={`reapprove:${row.platform}:${row.userId}`}
          id={`reapprove-${row.platform}-${row.userId}`}
          title={row.userName ?? row.userId}
          detail={detailOf(row)}
        >
          {approveButtons(row)}
        </SettingRow>
      ))}
      {waiting.length > 0 && (
        <div className="px-3 pt-3">
          <PageNote>
            {t("phase5.autoReplyWaiting", { count: waiting.length })}
          </PageNote>
        </div>
      )}
      {waiting.map((row) => (
        <SettingRow
          key={`waiting:${row.platform}:${row.userId}`}
          id={`waiting-${row.platform}-${row.userId}`}
          title={row.userName ?? row.userId}
          detail={[detailOf(row), row.firstMessage]
            .filter((part) => part != null && part.length > 0)
            .join(" · ")}
        >
          {approveButtons(row)}
        </SettingRow>
      ))}
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={t("phase5.autoReplyConfirmTitle")}
        description={t("phase5.autoReplyConfirmDescription")}
        label={t("phase5.autoReplyTurnOn")}
        body={answeredList}
        onConfirm={async () => update({ respondToInbound: true })}
      />
    </GroupCard>
  );
};
