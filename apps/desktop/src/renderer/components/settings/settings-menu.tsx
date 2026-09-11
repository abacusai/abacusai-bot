import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Brain,
  CalendarClock,
  ChartNoAxesColumn,
  CircleUserRound,
  Compass,
  FileText,
  Globe,
  Info,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Puzzle,
  Shapes,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Sun,
  TabletSmartphone,
} from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { canSignOutOfAbacus } from "#shared/settings";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { useTheme } from "../../hooks/use-theme";
import { defaultWorkspaceSearch } from "../../lib/route-search";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { displayName, useAccountStore } from "../../stores/account-store";
import { useLanguageStore } from "../../stores/language-store";
import { useTourStore } from "../../stores/tour-store";
import { LANGUAGES, Theme } from "../../types";
import { getLogDump } from "../../utils/log-collector";
import { Button } from "../ui";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
} from "../ui/sidebar";

export const SettingsMenu = (): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const memoryActive = useRouterState({
    select: (state) => state.location.pathname === "/settings/memory",
  });
  const { theme, effectiveTheme, setTheme } = useTheme();
  const languageCode = useLanguageStore((state) => state.languageCode);
  const setLanguageCode = useLanguageStore((state) => state.setLanguageCode);
  const startTour = useTourStore((state) => state.open);
  const account = useAccountStore((state) => state.account);
  const { data: abacusAccount } = useAbacusAccountQuery();
  const signOutAccount = useAccountStore((state) => state.signOut);
  const forgetAccount = useAccountStore((state) => state.forget);
  const [isOpen, setIsOpen] = useState(false);
  const credentialQuery = useQuery({
    queryKey: settingsQueryKeys.models.abacusCredential,
    queryFn: async () =>
      canSignOutOfAbacus(await window.api.agent.getSettings()),
    staleTime: 60_000,
  });
  const abacusSignedIn = credentialQuery.data ?? false;

  const signOutOfAbacus = async (): Promise<void> => {
    // No dialog, no choices: the main process stashes this account's sessions
    // into its hidden per-account folder (restored by its next sign-in) and
    // deletes every stored key — Abacus and the rest. The credential change
    // flips the app straight back to onboarding's sign-in screen (app.tsx).
    await window.api.agent.signOutAbacus({ keepOtherApiKeys: false });
    await signOutAccount();
    // Closes an open tour; nothing replays it on the next sign-in.
    useTourStore.getState().signedOut();
    void navigate({ to: "/", search: defaultWorkspaceSearch });
    toast.info(t("userMenu.signedOutRunningSessions"));
  };

  const restartOnboarding = async (): Promise<void> => {
    await forgetAccount();
    useTourStore.getState().reset();
    void navigate({ to: "/", search: defaultWorkspaceSearch });
  };

  const dumpLogs = async (): Promise<void> => {
    try {
      const result = await window.api.saveLogs(getLogDump());
      if (result.success)
        toast.success(t("logs.saved", { path: result.filePath ?? "" }));
      else if (result.error != null)
        toast.error(t("logs.saveFailed", { error: result.error }));
    } catch (error) {
      toast.error(
        t("logs.saveFailed", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };

  const themeItems = [
    { key: "dark", label: t("theme.dark"), icon: Moon },
    { key: "light", label: t("theme.light"), icon: Sun },
    { key: "system", label: t("theme.system"), icon: Monitor },
  ];

  // Second line of the trigger: email · organization, whichever are known.
  const accountDetail = [
    account?.email.trim() || abacusAccount?.email?.trim(),
    abacusAccount?.organization?.trim(),
  ]
    .filter((part): part is string => part != null && part.length > 0)
    .join(" · ");
  return (
    <div className="border-border relative shrink-0 border-t">
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem className="flex items-center gap-0.5">
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      data-id="settings-menu-trigger"
                      className="text-sidebar-foreground/80 hover:text-sidebar-accent-foreground h-auto min-h-8 min-w-0 flex-1 justify-start py-1"
                    />
                  }
                >
                  <Avatar size="sm">
                    {abacusAccount?.picture != null && (
                      <AvatarImage src={abacusAccount.picture} alt="" />
                    )}
                    <AvatarFallback>
                      <CircleUserRound className="size-3.5" />
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-col text-left">
                    <span
                      className="truncate"
                      data-id="settings-menu-trigger-name"
                    >
                      {displayName(account, abacusAccount) ??
                        (abacusAccount != null
                          ? t("profile.connectedAccount")
                          : t("profile.notSignedInShort"))}
                    </span>
                    {accountDetail.length > 0 && (
                      <span
                        className="text-muted-foreground truncate text-[11px] font-normal"
                        data-id="settings-menu-trigger-detail"
                      >
                        {accountDetail}
                      </span>
                    )}
                  </span>
                </DropdownMenuTrigger>

                {/* Beside the account rather than inside its menu: what the
                    agent remembers about you belongs next to who you are, and
                    it is one of the few settings pages people come back to.
                    Its own button — a control nested inside the menu trigger
                    would open the menu on the way past. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-id="settings-menu-memory"
                  aria-label={t("sidebarNav.memory")}
                  title={t("sidebarNav.memory")}
                  onClick={() => void navigate({ to: "/settings/memory" })}
                  data-active={memoryActive ? "" : undefined}
                  aria-current={memoryActive ? "page" : undefined}
                  className="text-sidebar-foreground/70 hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground shrink-0"
                >
                  <Brain />
                </Button>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={4}
          className="min-w-56"
          data-id="settings-menu"
        >
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/account" })}
              data-id="settings-menu-profile"
            >
              <CircleUserRound />
              {t("profile.title")}
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-id="settings-menu-theme">
                {effectiveTheme === "dark" ? <Moon /> : <Sun />}
                {t("userMenu.theme")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-40">
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) => setTheme(value as Theme)}
                >
                  {themeItems.map((item) => {
                    const ThemeIcon = item.icon;
                    return (
                      <DropdownMenuRadioItem
                        key={item.key}
                        value={item.key}
                        data-id={`settings-menu-theme-item-${item.key}`}
                      >
                        <ThemeIcon />
                        {item.label}
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-id="settings-menu-language">
                <Globe />
                {t("userMenu.language")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-56">
                <DropdownMenuRadioGroup
                  value={languageCode}
                  onValueChange={setLanguageCode}
                >
                  {LANGUAGES.map((language) => (
                    <DropdownMenuRadioItem
                      key={language.code}
                      value={language.code}
                      data-id={`settings-menu-language-item-${language.code}`}
                    >
                      {language.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          {/* The destinations the sidebar nav used to carry. The sidebar is
              the bots tree now, so where the agent's reach is configured and
              accounted for lives here, behind the profile. */}
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() =>
                void navigate({ to: "/settings/models", search: {} })
              }
              data-id="settings-menu-models"
            >
              <KeyRound />
              {t("apiKeys.title")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/tools" })}
              data-id="settings-menu-capabilities"
            >
              <Shapes />
              {t("sidebarNav.capabilities")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/memory" })}
              data-id="settings-menu-memory"
            >
              <Brain />
              {t("sidebarNav.memory")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/jobs" })}
              data-id="settings-menu-routines"
            >
              <CalendarClock />
              {t("sidebarNav.routines")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/usage" })}
              data-id="settings-menu-usage"
            >
              <ChartNoAxesColumn />
              {t("sidebarNav.usage")}
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/mcp" })}
              data-id="settings-menu-mcp"
            >
              <Puzzle />
              {t("userMenu.mcpManagement")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/skills" })}
              data-id="settings-menu-skills"
            >
              <SlidersHorizontal />
              {t("userMenu.skillsManagement")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/browser" })}
              data-id="settings-menu-browser"
            >
              <Smartphone />
              {t("userMenu.browserSettings")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/devices" })}
              data-id="settings-menu-devices"
            >
              <TabletSmartphone />
              {t("userMenu.deviceSettings")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/notifications" })}
              data-id="settings-menu-notifications"
            >
              <Bell />
              {t("userMenu.notificationSettings")}
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuGroup>
            <DropdownMenuItem onClick={startTour} data-id="settings-menu-tour">
              <Compass />
              {t("tour.replay")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void dumpLogs()}
              data-id="settings-menu-dump-logs"
            >
              <FileText />
              {t("userMenu.dumpLogs")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigate({ to: "/settings/changelog" })}
              data-id="settings-menu-changelog"
            >
              <Sparkles />
              {t("userMenu.whatsNew")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void window.api.showAboutPanel()}
              data-id="settings-menu-about"
            >
              <Info />
              {t("userMenu.about")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void (abacusSignedIn ? signOutOfAbacus() : restartOnboarding())
              }
              data-id="settings-menu-sign-out"
            >
              <LogOut />
              {abacusSignedIn ? t("userMenu.signOut") : t("userMenu.signIn")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
