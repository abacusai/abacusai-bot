import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LocalDataReset } from "#platform/data-reset";
import { signInAbacus } from "#platform/sign-in";
import { signOutAbacus } from "#platform/sign-out";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { ConnectPending } from "#renderer/components/form-kit/connect-dialog";
import {
  AreaPage,
  GroupCard,
  PageNote,
  SettingRow,
} from "#renderer/components/form-kit/page";
import { accountIdentity } from "#renderer/lib/account-identity";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { showInfo } from "#renderer/lib/toast";
import { openTopUp, openUpgrade } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useRowConnects } from "#renderer/lib/use-row-connects";
import { forgetAccount } from "#renderer/platform/forget-account";
import { Button } from "#renderer/ui/button";
import { Checkbox } from "#renderer/ui/checkbox";
export const AccountPage = () => {
  const { t, i18n } = useTranslation();
  const number = (value: unknown) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(
      Number(value) || 0
    );
  const context = useAppContext();
  const { transport, credentialsChanged } = context;
  const navigate = useAppNavigate();
  const account = useAccount();
  const billing = sidebarAccount(account.data).billing;
  const local = useQuery(
    transport.orpc.account.state.queryOptions({ input: {} })
  );
  const referrals = useQuery(
    transport.orpc.referrals.summary.queryOptions({ input: {} })
  );
  const settings = useQuery(
    transport.orpc.settings.get.queryOptions({ input: {} })
  );
  // The platform's own link to the vault page; null when this account has none.
  const vaultUrl = useQuery({
    ...transport.orpc.account.vaultUrl.queryOptions({ input: {} }),
    enabled: account.data != null,
    staleTime: 300000,
  }).data;
  const inviteLink = referrals.data?.inviteLink;
  const canSignOut = !IS_ELECTRON || canSignOutOfAbacus(settings.data ?? null);
  const [removeOthers, setRemoveOthers] = useState(true);
  // The sign-in waits on its own button; the page stays usable, and leaving it cancels.
  const connects = useRowConnects();
  const cancelSignIn = () => {
    if (IS_ELECTRON)
      void transport.client.auth.abacus.cancel({}).catch(() => undefined);
  };
  const signIn = () =>
    connects.start("abacus", {
      run: () => signInAbacus(transport, { intent: "signin" }),
      cancel: cancelSignIn,
      leave: cancelSignIn,
      connected: credentialsChanged,
    });
  const error = connects.error("abacus");
  if (!account.data)
    return (
      <AreaPage title={t("settings.pages.account")}>
        <h2 className="font-medium">{t("phase5.signedOut")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("phase5.signInDetail")}
        </p>
        <div className="flex gap-2">
          {connects.waiting("abacus") ? (
            <ConnectPending onCancel={() => connects.cancel("abacus")} />
          ) : (
            <Button onClick={signIn}>{t("phase5.signIn")}</Button>
          )}
          {!IS_ELECTRON && (
            <ConfirmAction
              title={t("phase5.signOut")}
              description={t("web.signOutDetail")}
              label={t("userMenu.signOut")}
              onConfirm={() => signOutAbacus(context, true)}
            />
          )}
          <Button
            variant="secondary"
            onClick={() => void navigate({ to: "/settings/models" })}
          >
            {t("phase5.ownKeys")}
          </Button>
        </div>
        {error && <PageNote error>{error}</PageNote>}
        <LocalDataReset />
      </AreaPage>
    );
  return (
    <AreaPage title={t("settings.pages.account")}>
      <GroupCard>
        <SettingRow
          id="identity"
          title={accountIdentity(account.data).name || "Abacus.AI"}
          detail={account.data.email ?? undefined}
        >
          {canSignOut && (
            <ConfirmAction
              title={t("phase5.signOut")}
              description={t(
                IS_ELECTRON ? "phase5.signOutDetail" : "web.signOutDetail"
              )}
              label={t("userMenu.signOut")}
              body={
                IS_ELECTRON && (
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={removeOthers}
                      onCheckedChange={(value) =>
                        setRemoveOthers(value === true)
                      }
                    />
                    {t("phase5.removeOtherKeys")}
                  </label>
                )
              }
              onConfirm={async () => {
                await signOutAbacus(context, !removeOthers);
                if (IS_ELECTRON)
                  await navigate({
                    to: "/onboarding/$step",
                    params: { step: "welcome" },
                    replace: true,
                    transition: "settings-out",
                  });
              }}
            />
          )}
        </SettingRow>
        <SettingRow
          id="plan"
          title={account.data.plan ?? t("phase5.unknownPlan")}
        >
          {billing && (
            <Button
              size="sm"
              onClick={() => void openUpgrade(transport.client, "settings")}
            >
              {t(
                billing === "upgrade" ? "creditsCard.cta" : "phase5.managePlan"
              )}
            </Button>
          )}
        </SettingRow>
        <SettingRow
          id="credits"
          title={t("phase5.credits")}
          detail={
            account.data.credits_granted
              ? t("phase5.creditUsage", {
                  used: number(account.data.credits_used),
                  granted: number(account.data.credits_granted),
                })
              : undefined
          }
        >
          {billing === "manage" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void openTopUp(transport.client)}
            >
              {t("phase5.topUp")}
            </Button>
          )}
        </SettingRow>
        {vaultUrl && (
          <SettingRow
            id="vault"
            title={t("phase5.vault")}
            detail={t("phase5.vaultDetail")}
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void platformSystem(transport.client).openExternal({
                  url: vaultUrl,
                })
              }
            >
              {t("phase5.openVault")}
            </Button>
          </SettingRow>
        )}
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
        {(
          [
            ...(referrals.data?.gmailConnected
              ? (["gmail", "link"] as const)
              : (["link", "gmail"] as const)),
            "whatsapp",
          ] as const
        )
          .filter((invite) => IS_ELECTRON || invite !== "whatsapp")
          .map((invite) => (
            <SettingRow
              key={invite}
              id={invite === "link" ? "inviteLink" : `invite-${invite}`}
              title={t(`phase5.inviteChannels.${invite}`)}
            >
              {invite === "link" && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!inviteLink}
                  onClick={() => {
                    if (inviteLink)
                      void navigator.clipboard
                        .writeText(inviteLink)
                        .then(() => showInfo(t("phase5.copied")));
                  }}
                >
                  {t("phase5.copy")}
                </Button>
              )}
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
          <SettingRow
            id="forgetAccount"
            title={t(
              IS_ELECTRON ? "phase5.forgetComputer" : "web.forgetAccount"
            )}
          >
            <ConfirmAction
              title={t(
                IS_ELECTRON ? "phase5.forgetComputer" : "web.forgetAccount"
              )}
              description={t(
                IS_ELECTRON
                  ? "phase5.forgetComputerDetail"
                  : "web.forgetAccountDetail"
              )}
              label={t("phase5.forget")}
              onConfirm={async () => {
                await forgetAccount(context);
                await navigate({
                  to: "/onboarding/$step",
                  params: { step: "welcome" },
                  replace: true,
                  transition: "settings-out",
                });
              }}
            />
          </SettingRow>
        </GroupCard>
      )}
      <LocalDataReset />
    </AreaPage>
  );
};
