import { Globe, Moon, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";

/**
 * The paid card's frame: "Deploy your site" (or, for a server, a bot or a
 * routine, "Keep it running 24/7" with its own `title` and `body`), its
 * steps, and a close.
 */
export const SiteDeployCardView = ({
  onClose,
  title,
  body,
  children,
}: {
  onClose: () => void;
  title?: string;
  body?: string;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const keep = title != null;
  return (
    <section
      data-slot="site-deploy-card"
      data-keep={keep ? "" : undefined}
      aria-label={title ?? t("siteDeploy.title")}
      className="bg-background relative my-2 flex w-full max-w-[520px] gap-3 rounded-xl border p-3.5 pr-9 text-sm"
    >
      <span
        aria-hidden
        className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-[9px]"
      >
        {keep ? <Moon className="size-4" /> : <Globe className="size-4" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{title ?? t("siteDeploy.title")}</p>
          <p className="text-muted-foreground">
            {body ?? t("siteDeploy.cardBody")}
          </p>
        </div>
        {children}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-2 right-2 size-7"
        aria-label={t("siteDeploy.close")}
        data-action="close"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </section>
  );
};
