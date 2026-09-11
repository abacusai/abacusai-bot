import { CircleUserRound, Trash2 } from "lucide-react";
import { type JSX, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { clearAllRendererState } from "../../lib/durable-storage";
import { displayName, useAccountStore } from "../../stores/account-store";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import {
  Button,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";

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
 * Erase everything the app holds about you; uninstalling leaves
 * `~/.abacusai-bot/` in place. On success main deletes the directory and
 * exits, so the request never resolves and pending has no success branch.
 */
const DeleteAllData = (): JSX.Element => {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  const remove = (): void => {
    setDeleting(true);
    setFailed(false);
    // Main erases ~/.abacusai-bot but not what the renderer persisted (tour
    // flag, favourites, pins, layout); clear that first. IPC from this frame
    // is delivered in order.
    try {
      clearAllRendererState();
    } catch {
      // A storage failure must not block the delete itself.
    }
    window.api.deleteAllUserData().catch(() => {
      setDeleting(false);
      setFailed(true);
      setConfirming(false);
    });
  };

  return (
    <section className="mt-2" data-id="profile-danger-zone">
      <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        {t("profile.dangerZone")}
      </h2>
      <Item variant="outline" className="border-destructive/40">
        <ItemContent>
          <ItemTitle>{t("profile.deleteAll")}</ItemTitle>
          <ItemDescription>{t("profile.deleteAllDescription")}</ItemDescription>
          {failed && (
            <ItemDescription
              className="text-destructive"
              data-id="profile-delete-all-failed"
            >
              {t("profile.deleteAllFailed")}
            </ItemDescription>
          )}
        </ItemContent>
        <Button
          variant="destructive"
          disabled={deleting}
          data-id="profile-delete-all"
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
          {deleting ? t("profile.deleteAllPending") : t("profile.deleteAll")}
        </Button>
      </Item>

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("profile.deleteAllConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("profile.deleteAllConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-id="profile-delete-all-cancel">
              {t("profile.deleteAllCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              data-id="profile-delete-all-confirm"
              onClick={remove}
            >
              {t("profile.deleteAllConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

        <DeleteAllData />
      </FocusedPageBody>
    </FocusedPage>
  );
};
