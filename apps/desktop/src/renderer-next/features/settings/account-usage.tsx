import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#next/components/form-kit/confirm";
import {
  AreaPage,
  GroupCard,
  SettingRow,
} from "#next/components/form-kit/page";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { showInfo } from "#next/lib/toast";
import { useAppContext, errorText } from "#next/lib/use-app-context";
import { Button } from "#next/ui/button";
import { Checkbox } from "#next/ui/checkbox";

import { ABACUS_PLAN_URL, ABACUS_BUY_CREDITS_URL } from "./credits";
export const AccountPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const account = useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: {} }),
    staleTime: 60000,
    refetchInterval: 300000,
  });
  const local = useQuery(
    transport.orpc.account.state.queryOptions({ input: {} })
  );
  const referrals = useQuery(
    transport.orpc.referrals.summary.queryOptions({ input: {} })
  );
  const [pending, setPending] = useState(false);
  const [removeOthers, setRemoveOthers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      if (pending) {
        attempt.current++;
        void transport.client.auth.abacus.cancel({});
      }
    },
    [pending, transport]
  );
  const signIn = async () => {
    const id = ++attempt.current;
    setPending(true);
    try {
      const result = await transport.client.auth.abacus.start({
        intent: "signin",
      });
      if (id !== attempt.current) return;
      if (result.ok)
        await cache.invalidateQueries({
          queryKey: transport.orpc.account.abacus.queryKey(),
        });
      else if (!result.cancelled) setError(result.error);
    } catch (e) {
      setError(errorText(e));
    }
    if (id === attempt.current) setPending(false);
  };
  if (!account.data)
    return (
      <AreaPage title={t("settings.pages.account")}>
        <h2 className="font-medium">{t("phase5.signedOut")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("phase5.signInDetail")}
        </p>
        <div className="flex gap-2">
          <Button disabled={pending} onClick={() => void signIn()}>
            {t(pending ? "phase5.waitingSignIn" : "phase5.signIn")}
          </Button>
          {pending && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  attempt.current++;
                  setPending(false);
                  void transport.client.auth.abacus.cancel({});
                }}
              >
                {t("phase5.cancel")}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  void transport.client.auth.abacus.openInBrowser({})
                }
              >
                {t("phase5.continueBrowser")}
              </Button>
            </>
          )}
          <Button
            variant="secondary"
            onClick={() => void navigate({ to: "/settings/models" })}
          >
            {t("phase5.ownKeys")}
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </AreaPage>
    );
  return (
    <AreaPage title={t("settings.pages.account")}>
      <GroupCard>
        <SettingRow
          id="identity"
          title={account.data.name ?? account.data.email ?? "Abacus.AI"}
          detail={account.data.email ?? undefined}
        >
          <ConfirmAction
            title={t("phase5.signOut")}
            description={t("phase5.signOutDetail")}
            label={t("phase5.signOut")}
            onConfirm={async () => {
              await transport.client.auth.abacus.signOut({
                keepOtherApiKeys: !removeOthers,
              });
              await transport.client.account.signOut({});
              void navigate({ to: "/bots/new", transition: "settings-out" });
            }}
          />
        </SettingRow>
        <label className="flex items-center gap-2 p-3 text-xs">
          <Checkbox
            checked={removeOthers}
            onCheckedChange={(value) => setRemoveOthers(value === true)}
          />
          {t("phase5.removeOtherKeys")}
        </label>
        <SettingRow
          id="plan"
          title={account.data.plan ?? t("phase5.unknownPlan")}
        >
          <Button
            size="sm"
            onClick={() =>
              void transport.client.system.openExternal({
                url: ABACUS_PLAN_URL,
              })
            }
          >
            {t("phase5.managePlan")}
          </Button>
        </SettingRow>
        <SettingRow
          id="credits"
          title={t("phase5.credits")}
          detail={
            account.data.credits_granted
              ? t("phase5.creditUsage", {
                  used: account.data.credits_used,
                  granted: account.data.credits_granted,
                })
              : undefined
          }
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void transport.client.system.openExternal({
                url: ABACUS_BUY_CREDITS_URL,
              })
            }
          >
            {t("phase5.topUp")}
          </Button>
        </SettingRow>
        {account.data.organization && (
          <SettingRow
            id="organization"
            title={account.data.organization}
            detail={
              account.data.org_user_count && account.data.org_user_count > 1
                ? t("phase5.members", { count: account.data.org_user_count })
                : undefined
            }
          />
        )}
      </GroupCard>
      <GroupCard title={t("phase5.referrals")}>
        <SettingRow id="inviteLink" title={t("phase5.inviteLink")}>
          <Button
            size="sm"
            disabled={!referrals.data?.inviteLink}
            onClick={() =>
              void navigator.clipboard
                .writeText(referrals.data!.inviteLink)
                .then(() => showInfo(t("phase5.copied")))
            }
          >
            {t("phase5.copy")}
          </Button>
        </SettingRow>
      </GroupCard>
      <GroupCard>
        {(["link", "gmail", "whatsapp"] as const).map((invite) => (
          <SettingRow
            key={invite}
            id={`invite-${invite}`}
            title={t(`phase5.inviteChannels.${invite}`)}
          >
            <Button
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/settings/account",
                  search: { invite },
                  transition: "none",
                })
              }
            >
              {t("phase5.invite")}
            </Button>
          </SettingRow>
        ))}
      </GroupCard>
      {local.data && (
        <GroupCard>
          <SettingRow id="forgetAccount" title={t("phase5.forgetComputer")}>
            <ConfirmAction
              title={t("phase5.forgetComputer")}
              description={t("phase5.forgetComputerDetail")}
              label={t("phase5.forget")}
              onConfirm={() => transport.client.account.forget({})}
            />
          </SettingRow>
        </GroupCard>
      )}
    </AreaPage>
  );
};
export const UsagePage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const query = useQuery({
    ...transport.orpc.account.usage.queryOptions({ input: {} }),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const account = useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: {} }),
    staleTime: 60000,
    refetchInterval: 300000,
  });
  const snapshot = query.data;
  return (
    <AreaPage
      title={t("settings.pages.usage")}
      actions={
        <Button
          size="sm"
          onClick={() => {
            void query.refetch();
            void account.refetch();
          }}
        >
          {t("phase5.refresh")}
        </Button>
      }
    >
      {query.isError ? (
        <p role="alert">{t("phase5.usageFailed")}</p>
      ) : !snapshot ? (
        <p role="status">{t("phase5.usageLoading")}</p>
      ) : (
        <>
          {snapshot.totals.requests === 0 && <p>{t("usage.empty")}</p>}
          <div className="grid grid-cols-3 gap-3">
            <GroupCard>
              <SettingRow
                id="abacusCredits"
                title={t("phase5.credits")}
                detail={String(account.data?.credits_used ?? 0)}
              />
            </GroupCard>
            <GroupCard>
              <SettingRow
                id="openrouterUsage"
                title={t("phase5.openrouterBrand")}
                detail={t(
                  snapshot.openrouter?.isFreeTier
                    ? "phase5.freeTier"
                    : "phase5.purchasedCredits"
                )}
              />
            </GroupCard>
            <GroupCard>
              <SettingRow
                id="weekUsage"
                title={t("phase5.thisWeek")}
                detail={t("phase5.usageNumbers", {
                  ...snapshot.totals,
                  tokens: snapshot.totals.input + snapshot.totals.output,
                })}
              />
            </GroupCard>
          </div>
          <GroupCard title={t("phase5.dailyActivity")}>
            <svg
              role="img"
              aria-label={t("phase5.dailyActivity")}
              viewBox="0 0 620 140"
              className="w-full p-3"
            >
              {snapshot.daily.map((day, i) => {
                const height = day.requests
                  ? Math.max(
                      3,
                      (day.requests /
                        Math.max(...snapshot.daily.map((x) => x.requests), 1)) *
                        100
                    )
                  : 0;
                return (
                  <rect
                    key={day.date}
                    x={(i * 620) / Math.max(snapshot.daily.length, 1)}
                    y={120 - height}
                    width={Math.max(
                      2,
                      600 / Math.max(snapshot.daily.length, 1) - 2
                    )}
                    height={height}
                    fill="var(--primary)"
                  >
                    <title>{t("phase5.dailyNumbers", { ...day })}</title>
                  </rect>
                );
              })}
            </svg>
            <table className="sr-only">
              <caption>{t("phase5.dailyActivity")}</caption>
              <thead>
                <tr>
                  <th>{t("phase5.date")}</th>
                  <th>{t("phase5.requests")}</th>
                  <th>{t("phase5.errors")}</th>
                  <th>{t("phase5.tokens")}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.daily.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{d.requests}</td>
                    <td>{d.errors}</td>
                    <td>{d.tokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GroupCard>
          <GroupCard title={t("phase5.byModel")}>
            {snapshot.models.map((model) => (
              <SettingRow
                id={`usage-${model.id}`}
                key={model.id}
                title={model.modelId}
                detail={t("phase5.usageNumbers", { ...model })}
              />
            ))}
          </GroupCard>
        </>
      )}
    </AreaPage>
  );
};
