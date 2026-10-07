import { formatForDisplay } from "@tanstack/react-hotkeys";
import { Search } from "lucide-react";
import { useContext } from "react";
import { useTranslation } from "react-i18next";

import { ActionBindingsContext } from "#renderer/lib/keyboard/action-bindings";
import { Button } from "#renderer/ui/button";
import { Kbd } from "#renderer/ui/kbd";

import { setCommandOpen } from "./shell-store";

export const CommandCenter = ({
  title,
  context,
}: {
  title: string;
  context?: string;
}) => {
  const { t } = useTranslation();
  const bindings = useContext(ActionBindingsContext);
  const chord =
    bindings?.["command-menu"] === undefined
      ? "Mod+K"
      : bindings["command-menu"];
  return (
    <Button
      variant="ghost"
      size="sm"
      data-slot="command-center"
      aria-label={t("shell.command.open", { title })}
      aria-haspopup="dialog"
      className="titlebar-nodrag bg-foreground/5 hover:bg-foreground/10 h-7 w-full max-w-80 min-w-0 justify-start gap-2 rounded-lg border border-transparent px-2 font-medium"
      onClick={() => setCommandOpen(true)}
      title={[context, title].filter(Boolean).join(" / ")}
    >
      <Search className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {context ? (
          <span className="text-muted-foreground">{context} / </span>
        ) : null}
        {title}
      </span>
      {chord ? (
        <Kbd className="hidden shrink-0 sm:inline-flex">
          {formatForDisplay(chord as never, {
            platform:
              document.documentElement.dataset.platform === "darwin"
                ? "mac"
                : "windows",
          })}
        </Kbd>
      ) : null}
    </Button>
  );
};
