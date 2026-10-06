/**
 * The bot's identity (spec 03 §16.2): one visual element with two homes. At
 * the top of the transcript it is the chat header (avatar 56, name, status);
 * as the transcript scrolls it shrinks and slides into its docked place in
 * the title bar. The scroll-linked part is CSS (bots.css: a named scroll
 * timeline on the transcript viewport, `timeline-scope`d at the shell so the
 * title bar can read it); an IntersectionObserver keeps the accessible copy
 * to one (the other is `aria-hidden`) and is the whole behaviour where
 * scroll-driven animation is missing or motion is reduced (a cut). Across
 * routes the showing copy carries the view-transition name, so entering or
 * leaving the chat morphs it with the sidebar row.
 */
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { RoutePending } from "#renderer/components/page-state";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { Button } from "#renderer/ui/button";

import { BotFace } from "../avatar";
import { moodFor } from "../data/attention";
import { useBotAttention } from "../data/use-attention";

/** The shared view-transition name of the bot's avatar (sidebar, header, dock). */
export const botIdentityName = (botId: string): string =>
  `bot-identity-${botId}`;

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
export const BotPending = RoutePending;

/**
 * The docked copy in the title bar. Clicking it opens or closes the details
 * panel. `docked` is the transcript copy's report (scrolled out of view):
 * only then is this copy the accessible one; a chat without a header
 * (a sender chat) docks it permanently.
 */
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
  const shared = useSharedElementName(docked ? botIdentityName(bot.id) : null);
  return (
    <Button
      data-slot="bot-docked-identity"
      data-docked={docked ? "" : undefined}
      className="max-w-full min-w-0 justify-start overflow-hidden"
      title={bot.name}
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
      <span className="flex shrink-0" style={shared}>
        <BotFace bot={bot} mood={moodFor(attention)} size={22} />
      </span>
      <span className="min-w-0 truncate">{bot.name}</span>
      <span
        data-slot="bot-identity-status"
        className="text-muted-foreground hidden max-w-48 shrink-0 truncate text-xs xl:inline"
      >
        {attention.kind === "idle"
          ? bot.title
          : t(`bots.status.${attention.kind}`)}
      </span>
    </Button>
  );
};

/** The header copy at the top of the transcript; clicking it toggles details too. */
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
  const style = useSharedElementName(docked ? null : botIdentityName(bot.id));
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
    <div
      className="flex flex-col items-center gap-1 pt-7 pb-2"
      data-slot="bot-transcript-identity"
      data-docked={docked ? "" : undefined}
    >
      <Button
        variant="ghost"
        className="h-auto max-w-full flex-col whitespace-normal"
        aria-hidden={docked}
        tabIndex={docked ? -1 : 0}
        onClick={onToggle}
        aria-expanded={detailsOpen}
        aria-label={t("bots.panel.detailsFor", { name: bot.name })}
      >
        <div ref={ref} style={style}>
          <BotFace bot={bot} mood={moodFor(attention)} size={56} />
        </div>
        <span className="max-w-full text-[15px] font-semibold break-words">
          {bot.name}
        </span>
      </Button>
      <p className="text-muted-foreground text-xs">
        {attention.kind === "idle"
          ? bot.title
          : t(`bots.status.${attention.kind}`)}
      </p>
    </div>
  );
};
