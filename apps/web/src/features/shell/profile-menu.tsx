import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import { useQuery } from "@tanstack/react-query";
import {
  CreditCard,
  Gift,
  HelpCircle,
  LogOut,
  Monitor,
  Moon,
  Palette,
  UserRound,
  Sun,
  ChartNoAxesColumn,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { signOutAbacus } from "#platform/sign-out";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { ReferralLink } from "#renderer/features/settings/referral-link";
import { accountIdentity } from "#renderer/lib/account-identity";
import { cn } from "#renderer/lib/cn";
import {
  springs,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Avatar, AvatarFallback, AvatarImage } from "#renderer/ui/avatar";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

export const ProfileMenu = () => {
  const { t } = useTranslation();
  const context = useAppContext();
  const { transport } = context;
  const navigate = useAppNavigate();
  const account = useAccount();
  const identity = accountIdentity(account.data);
  const policy = sidebarAccount(account.data);
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState(false);
  const [signOut, setSignOut] = useState(false);
  const inviteOpens = useRef(0);
  const reduced = useMotionPreference() === "reduced";
  const trigger = useRef<HTMLButtonElement>(null);
  const summary = useQuery({
    ...transport.orpc.referrals.summary.queryOptions({ input: {} }),
    enabled: account.data != null && (open || invite),
    staleTime: 60_000,
  });
  const settings = useQuery({
    ...transport.orpc.settings.get.queryOptions({ input: {} }),
    enabled: IS_ELECTRON && open,
    staleTime: 60_000,
  });
  const label = identity.name || t("shell.rail.account");
  const button = (
    <button
      ref={trigger}
      type="button"
      aria-label={label}
      data-slot="profile-button"
      className="titlebar-nodrag hover:bg-sidebar-accent/50 focus-visible:ring-ring/50 flex size-9 shrink-0 items-center justify-center rounded-[10px] outline-none focus-visible:ring-2"
    >
      <Avatar size="sm">
        {identity.picture && <AvatarImage src={identity.picture} alt="" />}
        <AvatarFallback className="text-[11px] font-semibold">
          {identity.initials}
        </AvatarFallback>
      </Avatar>
    </button>
  );
  const row = "h-8 [&_svg]:size-4";
  const go = (
    to:
      | "/settings/account"
      | "/settings/usage"
      | "/settings/appearance"
      | "/settings/about"
  ) => void navigate({ to, transition: "settings-in" });
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger render={<DropdownMenuTrigger render={button} />} />
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="right"
          align="end"
          className="floating-surface scroll-fade-y w-60 rounded-(--pane-radius)"
          data-sidebar-overlay=""
        >
          {account.data?.email && (
            <DropdownMenuGroup>
              <DropdownMenuLabel
                className="truncate"
                title={account.data.email}
              >
                {account.data.email}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
          )}
          <DropdownMenuItem
            className={row}
            onClick={() => go("/settings/account")}
          >
            <UserRound aria-hidden />
            <span className="truncate">{t("settings.pages.account")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={row}
            onClick={() => go("/settings/usage")}
          >
            <ChartNoAxesColumn aria-hidden />
            <span className="truncate">{t("settings.pages.usage")}</span>
          </DropdownMenuItem>
          {policy.billing && (
            <DropdownMenuItem
              className={row}
              onClick={() => go("/settings/account")}
            >
              <CreditCard aria-hidden />
              <span className="truncate">
                {t(
                  policy.billing === "upgrade"
                    ? "creditsCard.cta"
                    : "phase5.managePlan"
                )}
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className={row}
            onClick={() => go("/settings/appearance")}
          >
            <Palette aria-hidden />
            <span className="truncate">{t("settings.pages.appearance")}</span>
          </DropdownMenuItem>
          <DropdownMenuRadioGroup
            value={prefs.theme}
            onValueChange={(theme) => {
              if (theme === "light" || theme === "dark" || theme === "system")
                void updatePrefs({ theme }).catch(() => undefined);
            }}
            aria-label={t("settings.theme.label")}
            className="bg-sidebar-accent/40 mx-1 my-1 flex gap-1 rounded-lg p-1"
          >
            {(
              [
                ["light", Sun],
                ["dark", Moon],
                ["system", Monitor],
              ] as const
            ).map(([theme, Icon]) => (
              <DropdownMenuRadioItem
                key={theme}
                value={theme}
                closeOnClick={false}
                aria-label={t(`theme.${theme}`)}
                title={t(`theme.${theme}`)}
                className={cn(
                  "flex h-8 flex-1 justify-center px-2 [&>span]:hidden",
                  prefs.theme === theme && "bg-background"
                )}
              >
                <Icon className="size-4" aria-hidden />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={row}
            onClick={() => go("/settings/about")}
          >
            <HelpCircle aria-hidden />
            <span className="truncate">{t("profile.help")}</span>
          </DropdownMenuItem>
          {account.data && (
            <DropdownMenuItem
              className={row}
              onClick={() => {
                inviteOpens.current += 1;
                setInvite(true);
              }}
            >
              <Gift aria-hidden />
              <span className="truncate">{t("referrals.title")}</span>
            </DropdownMenuItem>
          )}
          {(!IS_ELECTRON || canSignOutOfAbacus(settings.data ?? null)) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={row}
                onClick={() => setSignOut(true)}
              >
                <LogOut aria-hidden />
                <span className="truncate">{t("profile.logOut")}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={invite} onOpenChange={setInvite}>
        <DialogContent
          render={
            <motion.div
              initial={
                reduced ? false : { opacity: 0, transform: "scale(0.98)" }
              }
              animate={{ opacity: 1, transform: "scale(1)" }}
              transition={reduced ? reducedTransition : springs.surface}
            />
          }
          finalFocus={trigger}
          showCloseButton={false}
          data-sidebar-overlay=""
          className="floating-surface scroll-fade-y max-h-[calc(100dvh-2rem)] animate-none! overflow-y-auto rounded-(--pane-radius) sm:max-w-sm"
        >
          <DialogHeader className="pe-6">
            <DialogTitle>{t("referrals.title")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("profile.referralValue")}
            </DialogDescription>
          </DialogHeader>
          {summary.data ? (
            <ReferralLink
              summary={summary.data}
              firstOpen={inviteOpens.current === 1}
            />
          ) : (
            <div
              className="bg-muted h-40 rounded-(--pane-radius)"
              aria-busy="true"
            />
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setInvite(false);
              void navigate({
                to: "/settings/account",
                search: { invite: "gmail" },
                transition: "settings-in",
              });
            }}
          >
            {t("profile.inviteContacts")}
          </Button>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute end-2 top-2"
                aria-label={t("profile.close")}
              />
            }
          >
            <X className="size-4" />
          </DialogClose>
        </DialogContent>
      </Dialog>
      <ConfirmAction
        open={signOut}
        onOpenChange={(next) => {
          setSignOut(next);
          if (!next) trigger.current?.focus();
        }}
        title={t("phase5.signOut")}
        description={t(
          IS_ELECTRON ? "phase5.signOutDetail" : "web.signOutDetail"
        )}
        label={t("profile.logOut")}
        onConfirm={() => signOutAbacus(context, true)}
      />
    </>
  );
};
