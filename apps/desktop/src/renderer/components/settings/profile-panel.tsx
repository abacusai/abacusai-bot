import { CircleUserRound } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import { AgentMode } from "#shared/agent-types";
import type { DefaultAgentMode } from "#shared/contracts";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import {
  useDefaultAgentModeQuery,
  useSandboxSupportQuery,
  useSetDefaultAgentMode,
} from "../../hooks/use-sandbox";
import { displayName, useAccountStore } from "../../stores/account-store";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";

const Detail = ({
  label,
  value,
  dataId,
}: {
  label: string;
  value: string;
  dataId: string;
}): JSX.Element => (
  <Item size="sm">
    <ItemContent>
      <ItemDescription>{label}</ItemDescription>
      <ItemTitle data-id={dataId} title={value} className="break-words">
        {value}
      </ItemTitle>
    </ItemContent>
  </Item>
);

/**
 * What new sessions, bots and routines run in: Full access, or Auto, the
 * same inside the kernel sandbox. Offered only where the sandbox works; a
 * machine that cannot confine a command has one honest mode, so the section
 * is not shown there at all.
 */
const DangerZone = (): JSX.Element | null => {
  const { t } = useTranslation();
  const support = useSandboxSupportQuery().data;
  const current = useDefaultAgentModeQuery().data ?? AgentMode.Yolo;
  const setMode = useSetDefaultAgentMode();

  if (support?.available !== true) return null;

  return (
    <section className="mt-2" data-id="profile-danger-zone">
      <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        {t("profile.dangerZone")}
      </h2>
      <Item variant="outline" data-id="profile-default-mode">
        <ItemContent>
          <ItemTitle>{t("profile.permissionsTitle")}</ItemTitle>
          <ItemDescription>
            {t("profile.permissionsDescription")}
          </ItemDescription>
          {current === AgentMode.Auto && (
            <ItemDescription
              className="text-amber-600 dark:text-amber-400"
              data-id="profile-default-mode-warning"
            >
              {t("profile.permissionsAutoWarning")}
            </ItemDescription>
          )}
        </ItemContent>
        <NativeSelect
          value={current}
          disabled={setMode.isPending}
          aria-label={t("profile.permissionsTitle")}
          data-id="profile-default-mode-select"
          onChange={(event) =>
            setMode.mutate(event.target.value as DefaultAgentMode)
          }
        >
          <NativeSelectOption value={AgentMode.Yolo}>
            {t("profile.permissionsFullAccess")}
          </NativeSelectOption>
          <NativeSelectOption value={AgentMode.Auto}>
            {t("profile.permissionsAuto")}
          </NativeSelectOption>
        </NativeSelect>
      </Item>
    </section>
  );
};

export const ProfilePanel = (): JSX.Element => {
  const { t } = useTranslation();
  const account = useAccountStore((state) => state.account);
  const { data: abacus } = useAbacusAccountQuery();
  const name =
    displayName(account, abacus) ??
    (abacus != null
      ? t("profile.connectedAccount")
      : t("profile.notSignedInShort"));
  const email = account?.email ?? abacus?.email ?? null;
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const credits =
    abacus?.credits_granted != null && abacus.credits_granted > 0
      ? t("profile.creditsValue", {
          used: Math.round(abacus.credits_used ?? 0).toLocaleString(),
          granted: Math.round(abacus.credits_granted).toLocaleString(),
        })
      : null;

  return (
    <FocusedPage data-id="profile-page">
      <FocusedPageBody>
        <FocusedPageLead description={t("profile.title")} />
        <Item variant="outline" data-id="profile-account-card">
          <Avatar size="lg">
            {abacus?.picture != null && (
              <AvatarImage src={abacus.picture} alt="" />
            )}
            <AvatarFallback>
              {initials.length > 0 ? (
                initials
              ) : (
                <CircleUserRound className="size-5" />
              )}
            </AvatarFallback>
          </Avatar>
          <ItemContent>
            <ItemTitle data-id="profile-name">{name}</ItemTitle>
            {email != null && (
              <ItemDescription data-id="profile-email">{email}</ItemDescription>
            )}
          </ItemContent>
          {abacus?.plan != null && (
            <span
              className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium"
              data-id="profile-plan"
            >
              {abacus.plan}
            </span>
          )}
        </Item>

        {abacus == null ? (
          <p
            className="text-muted-foreground text-sm"
            data-id="profile-signed-out"
          >
            {t("profile.notSignedIn")}
          </p>
        ) : (
          <ItemGroup className="rounded-lg border">
            {abacus.organization != null && (
              <Detail
                label={t("profile.organization")}
                value={abacus.organization}
                dataId="profile-organization"
              />
            )}
            {abacus.plan != null && (
              <Detail
                label={t("profile.plan")}
                value={abacus.plan}
                dataId="profile-plan-row"
              />
            )}
            {credits != null && (
              <Detail
                label={t("profile.credits")}
                value={credits}
                dataId="profile-credits"
              />
            )}
            {abacus.org_user_count != null && abacus.org_user_count > 1 && (
              <Detail
                label={t("profile.members")}
                value={String(abacus.org_user_count)}
                dataId="profile-members"
              />
            )}
          </ItemGroup>
        )}

        <DangerZone />
      </FocusedPageBody>
    </FocusedPage>
  );
};
