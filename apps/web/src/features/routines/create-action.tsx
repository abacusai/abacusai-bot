import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { NavList } from "#renderer/components/nav-list";
import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";
import { defaultLook } from "#renderer/lib/bots/avatar";
import { useContextualUpsell } from "#renderer/lib/contextual-upsell";
import { creditsTier } from "#renderer/lib/credits";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { IS_BROWSER } from "#renderer/lib/platform";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from "#renderer/ui/popover";

export const RoutineUpgradeActions = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => void openUpgrade(transport.client)}>
        {t("routines.hosted.upgrade")}
      </Button>
      {IS_BROWSER && (
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={
            <a
              href={DESKTOP_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          {t("web.routines.download")}
        </Button>
      )}
    </div>
  );
};
export const RoutineUpgradeAvatar = () => (
  <BotAvatar
    look={defaultLook("AbacusAI Bot")}
    mood="idle"
    size={36}
    animate={false}
  />
);

export const RoutineCreateAction = ({
  iconOnly = false,
}: {
  iconOnly?: boolean;
}) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  useContextualUpsell(open && creditsTier(account.data) === "free");
  const label = t("routines.sidebar.new");
  const action = iconOnly ? (
    <NavList.Action label={label}>
      <Plus />
    </NavList.Action>
  ) : (
    <Button>{label}</Button>
  );
  if (creditsTier(account.data) !== "free")
    return iconOnly ? (
      <NavList.Action
        label={label}
        disabled={account.isPending}
        render={<AppLink to="/routines/new" transition="none" />}
      >
        <Plus />
      </NavList.Action>
    ) : (
      <Button
        disabled={account.isPending}
        nativeButton={false}
        render={<AppLink to="/routines/new" transition="none" />}
      >
        {label}
      </Button>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={action} />
      <PopoverContent
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] gap-3 p-3"
      >
        <div className="flex items-center gap-3">
          <RoutineUpgradeAvatar />
          <div className="flex min-w-0 flex-col gap-1">
            <PopoverTitle>{t("routines.upgrade.title")}</PopoverTitle>
            <PopoverDescription>
              {t("routines.upgrade.description")}
            </PopoverDescription>
          </div>
        </div>
        <RoutineUpgradeActions />
      </PopoverContent>
    </Popover>
  );
};
