import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppLink } from "#next/lib/navigation/app-link";
import { useSharedElementName } from "#next/lib/navigation/shared-element";
import { Button } from "#next/ui/button";
import { Skeleton } from "#next/ui/skeleton";
import type { BotRow } from "#shared/contract/rows";

import { BotFace } from "../avatar";
import { moodFor } from "../data/attention";
import { useBotAttention } from "../data/use-attention";
export const BotGone = ({ chat = false }: { chat?: boolean }) => {
  const { t } = useTranslation();
  return (
    <div
      className="flex size-full flex-col items-center justify-center gap-4"
      role="status"
    >
      <BotFace
        look={{ shape: "round", color: "#a8a29e", accessory: "none" }}
        mood="asleep"
        size={44}
      />
      <h1>{t(chat ? "bots.gone.chat" : "bots.gone.bot")}</h1>
      <AppLink to="/bots/new" className="text-sm underline">
        {t("bots.gone.make")}
      </AppLink>
    </div>
  );
};
export const BotPending = () => (
  <div
    data-testid="pending-pane"
    aria-busy
    className="mx-auto flex max-w-[720px] flex-col gap-4 p-8"
  >
    <Skeleton className="mx-auto size-14 rounded-full" />
    <Skeleton className="h-24 w-3/4" />
    <Skeleton className="h-24 w-1/2 self-end" />
  </div>
);
export const BotIdentity = ({
  bot,
  docked = true,
  detailsOpen,
  onToggle,
}: {
  bot: BotRow;
  docked?: boolean;
  detailsOpen: boolean;
  onToggle(): void;
}) => {
  const { t } = useTranslation();
  const attention = useBotAttention(bot);
  return (
    <Button
      data-slot="bot-docked-identity"
      variant="ghost"
      onClick={onToggle}
      aria-label={t("bots.panel.detailsFor", { name: bot.name })}
      aria-expanded={detailsOpen}
      aria-hidden={!docked}
      tabIndex={docked ? 0 : -1}
      style={{
        opacity: docked ? 1 : 0,
        transform: docked ? "translateY(0)" : "translateY(4px)",
        transition: "opacity 160ms, transform 160ms",
      }}
    >
      <BotFace bot={bot} mood={moodFor(attention)} size={22} />
      <span>{bot.name}</span>
      <span
        data-slot="bot-identity-status"
        className="text-muted-foreground hidden text-xs xl:inline"
      >
        {attention.kind === "idle"
          ? bot.title
          : t(`bots.status.${attention.kind}`)}
      </span>
    </Button>
  );
};
export const BotTranscriptIdentity = ({
  bot,
  onDock,
  onToggle,
  detailsOpen,
}: {
  bot: BotRow;
  onDock(docked: boolean): void;
  onToggle(): void;
  detailsOpen: boolean;
}) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  const style = useSharedElementName(`bot-identity-${bot.id}`);
  const attention = useBotAttention(bot);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const root = element.closest('[data-slot="message-scroller-viewport"]');
    const observer = new IntersectionObserver(
      ([entry]) => {
        const value = (entry?.intersectionRatio ?? 1) < 0.5;
        setDocked(value);
        onDock(value);
      },
      { root, threshold: 0.5 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onDock]);
  return (
    <div className="flex flex-col items-center gap-1 pt-7 pb-2">
      <Button
        variant="ghost"
        className="h-auto flex-col"
        aria-hidden={docked}
        tabIndex={docked ? -1 : 0}
        onClick={onToggle}
        aria-expanded={detailsOpen}
        aria-label={t("bots.panel.detailsFor", { name: bot.name })}
      >
        <div ref={ref} style={style}>
          <BotFace bot={bot} mood={moodFor(attention)} size={56} />
        </div>
        <span className="text-[15px] font-semibold">{bot.name}</span>
      </Button>
      <p className="text-muted-foreground text-xs">
        {attention.kind === "idle"
          ? bot.title
          : t(`bots.status.${attention.kind}`)}
      </p>
    </div>
  );
};
