/**
 * The Bots sidebar (spec 03 §7, canvas `BotsSidebar`, `BotsEmpty`,
 * `BotStates`), the 88 px strip (§7.7, canvas `BW800`) and the "Needs you"
 * group other areas show above their own sidebar (§7.2).
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ChevronRight, Plus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { ACCENT_OUTLINE_CLASS } from "#renderer/components/bot-avatar";
import { NavList } from "#renderer/components/nav-list";
import { usePrefs } from "#renderer/data/db/prefs";
import { NEUTRAL_LOOK } from "#renderer/lib/bots/avatar";
import { findCheckIn } from "#renderer/lib/bots/check-in";
import { cn } from "#renderer/lib/cn";
import { formatChatStamp } from "#renderer/lib/format/chat-stamp";
import {
  durations,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useNow } from "#renderer/lib/use-now";
import { Input } from "#renderer/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type { BotChatPreview } from "@abacus-ai/contract/contracts";

import { BotFace } from "../avatar";
import { moodFor, type BotAttention } from "../data/attention";
import { botsQueries, useBots } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import {
  attentionOf,
  useAttentionSources,
  type AttentionSources,
} from "../data/use-attention";
import { botMenuItems, useBotMenuActions } from "./bot-menu";
import { BotRowView, secondaryLine } from "./bot-row";
import { DeleteBotDialog } from "./delete-dialog";
import { sidebarEntries, stripOrder, type SidebarEntry } from "./order";

const EMPTY_PREVIEWS: Readonly<Record<string, BotChatPreview>> = {};

/** Everything the list needs, computed once per render. */
const useSidebarModel = (query: string) => {
  const transport = useBotsTransport();
  const { bots, status, retry } = useBots();
  const prefs = usePrefs();
  const sources = useAttentionSources();
  const previews =
    useQuery(botsQueries(transport.orpc).chatPreviews()).data ?? EMPTY_PREVIEWS;
  const attention = new Map<string, BotAttention>(
    bots.map((bot) => [bot.id, attentionOf(bot, sources)])
  );
  const entries = sidebarEntries({
    bots,
    pinnedIds: prefs.pinned.botIds,
    attention,
    previews,
    query,
  });
  return { bots, status, retry, entries, attention, previews, sources, prefs };
};

const BotRowContainer = ({
  bot,
  attention,
  previews,
  sources,
  pinned,
  active,
  hidden,
  allBots,
  onDelete,
}: {
  bot: BotRow;
  attention: BotAttention;
  previews: Readonly<Record<string, BotChatPreview>>;
  sources: AttentionSources;
  pinned: boolean;
  active: boolean;
  hidden: boolean;
  allBots: readonly BotRow[];
  onDelete(bot: BotRow): void;
}) => {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const checkIn = findCheckIn(sources.routines, bot.id);
  const preview = previews[bot.id];
  const items = botMenuItems({
    channel: bot.channel != null,
    pinned,
    unread: sources.unread.has(bot.id),
    botCount: allBots.length,
    checkIn: checkIn == null ? null : { enabled: checkIn.enabled },
  });
  const run = useBotMenuActions(bot, { checkIn, allBots, onDelete });
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (active)
      ref.current?.querySelector("a")?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div ref={ref} className="contents">
      <BotRowView
        bot={bot}
        attention={attention}
        preview={preview?.text ?? null}
        stamp={formatChatStamp(
          preview?.at ?? bot.updatedAt,
          now,
          i18n.language,
          t("bots.sidebar.yesterday")
        )}
        active={active}
        hidden={hidden}
        menu={items}
        onMenu={run}
      />
    </div>
  );
};

const GroupLabel = ({
  entry,
  pinnedOpen,
  onPinnedOpen,
}: {
  entry: Extract<SidebarEntry, { kind: "label" }>;
  pinnedOpen: boolean;
  onPinnedOpen(open: boolean): void;
}) => {
  const { t } = useTranslation();
  if (entry.group === "needs-you")
    return (
      <div
        role="presentation"
        className="text-muted-foreground flex h-7 items-center px-2 pt-1 text-xs"
      >
        {t("bots.sidebar.needsYou")}
      </div>
    );
  return (
    <button
      type="button"
      aria-expanded={pinnedOpen}
      onClick={() => onPinnedOpen(!pinnedOpen)}
      className="group/pinned text-muted-foreground hover:text-sidebar-foreground flex h-7 w-full items-center gap-1 rounded-md px-2 pt-1 text-xs"
    >
      <ChevronRight
        aria-hidden
        className={cn("size-3 transition-transform", pinnedOpen && "rotate-90")}
      />
      {t("bots.sidebar.pinned")}
    </button>
  );
};

export const BotsSidebar = () => {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { botId?: string };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [deleting, setDeleting] = useState<BotRow | null>(null);
  const searchButton = useRef<HTMLButtonElement | null>(null);
  const model = useSidebarModel(searching ? query : "");
  const botEntries = model.entries.filter(
    (entry): entry is Extract<SidebarEntry, { kind: "bot" }> =>
      entry.kind === "bot"
  );
  const deletingIndex =
    deleting == null
      ? -1
      : botEntries.findIndex((entry) => entry.bot.id === deleting.id);
  const nextBot =
    deletingIndex < 0
      ? null
      : (botEntries[deletingIndex + 1] ??
        botEntries[deletingIndex - 1] ??
        null);

  const closeSearch = (): void => {
    setSearching(false);
    setQuery("");
    searchButton.current?.focus();
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeSearch();
  };

  return (
    <NavList.Root label={t("bots.sidebar.title")}>
      <NavList.Header title={t("bots.sidebar.title")}>
        <NavList.Action
          ref={searchButton}
          label={t("bots.sidebar.search")}
          aria-expanded={searching}
          onClick={() => (searching ? closeSearch() : setSearching(true))}
        >
          <Search />
        </NavList.Action>
        <NavList.Action
          label={t("bots.sidebar.new")}
          render={<AppLink to="/bots/new" transition="nav-lateral" />}
        >
          <Plus />
        </NavList.Action>
      </NavList.Header>
      {searching && (
        <div className="px-1 pb-1">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t("bots.sidebar.searchPlaceholder")}
            aria-label={t("bots.sidebar.search")}
            className="bg-muted h-8 rounded-[9px] border-0"
          />
        </div>
      )}
      {model.status === "error" ? (
        <NavList.Error
          message={t("shell.sidebar.loadError")}
          retryLabel={t("shell.sidebar.retry")}
          onRetry={model.retry}
        />
      ) : model.status !== "ready" ? (
        <NavList.Skeleton rows={5} />
      ) : model.bots.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 pt-10 text-center">
          <BotFace look={NEUTRAL_LOOK} mood="asleep" size={44} />
          <p className="text-sm font-medium">{t("bots.sidebar.emptyTitle")}</p>
          <p className="text-muted-foreground text-xs">
            {t("bots.sidebar.emptyBody")}
          </p>
        </div>
      ) : model.entries.length === 0 ? (
        <p className="text-muted-foreground px-2 pt-4 text-center text-xs">
          {t("bots.sidebar.noMatches")}
        </p>
      ) : (
        <div data-slot="nav-list-rows" className="flex flex-col pt-1">
          {model.entries.map((entry) =>
            entry.kind === "label" ? (
              <GroupLabel
                key={entry.key}
                entry={entry}
                pinnedOpen={pinnedOpen}
                onPinnedOpen={setPinnedOpen}
              />
            ) : (
              <BotRowContainer
                key={entry.key}
                bot={entry.bot}
                attention={
                  model.attention.get(entry.bot.id) ?? { kind: "idle" }
                }
                previews={model.previews}
                sources={model.sources}
                pinned={model.prefs.pinned.botIds.includes(entry.bot.id)}
                active={params.botId === entry.bot.id}
                hidden={entry.group === "pinned" && !pinnedOpen}
                allBots={model.bots}
                onDelete={setDeleting}
              />
            )
          )}
        </div>
      )}
      <DeleteBotDialog
        bot={deleting}
        hasCheckIn={
          deleting != null &&
          findCheckIn(model.sources.routines, deleting.id) != null
        }
        nextBotId={nextBot?.bot.id ?? null}
        onClose={() => setDeleting(null)}
      />
    </NavList.Root>
  );
};

/** At 800–899 px (canvas `BW800`): tiles with the mood and a dot. */
export const BotsStrip = () => {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { botId?: string };
  const model = useSidebarModel("");
  return (
    <nav
      aria-label={t("bots.sidebar.title")}
      data-slot="bots-strip"
      className="flex flex-col items-center gap-1 p-2"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <AppLink
              to="/bots/new"
              transition="nav-lateral"
              aria-label={t("bots.sidebar.new")}
              className="bg-muted text-muted-foreground hover:text-sidebar-foreground mb-1 flex size-10 items-center justify-center rounded-xl"
            />
          }
        >
          <Plus className="size-4" />
        </TooltipTrigger>
        <TooltipContent side="right">{t("bots.sidebar.new")}</TooltipContent>
      </Tooltip>
      {model.status === "ready" &&
        stripOrder(model.entries).map((bot) => {
          const attention = model.attention.get(bot.id) ?? { kind: "idle" };
          const line = secondaryLine(
            attention,
            bot,
            model.previews[bot.id]?.text ?? null,
            t
          );
          const dot =
            attention.kind === "needs-you" || attention.kind === "unread";
          return (
            <Tooltip key={bot.id}>
              <TooltipTrigger
                render={
                  <AppLink
                    to="/bots/$botId"
                    params={{ botId: bot.id }}
                    transition="nav-lateral"
                    aria-label={`${bot.name}, ${line.text}`}
                    aria-current={params.botId === bot.id ? "page" : undefined}
                    className="hover:bg-sidebar-accent/60 aria-[current=page]:bg-sidebar-accent relative flex size-14 items-center justify-center rounded-[14px]"
                  />
                }
              >
                <BotFace bot={bot} mood={moodFor(attention)} size={40} />
                {dot && (
                  <span
                    aria-hidden
                    className={cn(
                      "bots-pop absolute top-1.5 right-1.5 size-2 rounded-full bg-(--bots-attention) ring-2 ring-(--sidebar)",
                      ACCENT_OUTLINE_CLASS
                    )}
                  />
                )}
              </TooltipTrigger>
              <TooltipContent side="right">{bot.name}</TooltipContent>
            </Tooltip>
          );
        })}
    </nav>
  );
};

/**
 * The "Needs you" group for other areas' sidebars (§7.2): up to three
 * compact rows and "{n} more"; nothing when no bot needs you.
 */
export const BotsNeedsYou = () => {
  const { t } = useTranslation();
  const motionPref = useMotionPreference();
  const { bots } = useBots();
  const sources = useAttentionSources();
  const waiting = bots
    .map((bot) => ({ bot, attention: attentionOf(bot, sources) }))
    .filter(
      (
        item
      ): item is {
        bot: BotRow;
        attention: Extract<BotAttention, { kind: "needs-you" }>;
      } => item.attention.kind === "needs-you"
    )
    .toSorted((a, b) => a.attention.since - b.attention.since);
  return (
    <AnimatePresence initial={false}>
      {waiting.length > 0 && (
        <motion.div
          key="bots-needs-you"
          role="group"
          aria-label={t("bots.sidebar.needsYou")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={
            motionPref === "reduced"
              ? reducedTransition
              : { duration: durations.childFade / 1000 }
          }
          className="border-sidebar-border mx-2 mb-1 flex flex-col border-b pb-1"
        >
          <div className="text-muted-foreground flex h-7 items-center px-2 text-xs">
            {t("bots.sidebar.needsYou")}
          </div>
          {waiting.slice(0, 3).map(({ bot, attention }) => (
            <AppLink
              key={bot.id}
              to="/bots/$botId"
              params={{ botId: bot.id }}
              transition="nav-lateral"
              className="hover:bg-sidebar-accent/60 flex h-8 items-center gap-2 rounded-lg px-2 text-[13px]"
            >
              <BotFace bot={bot} mood="waiting" size={22} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              <span className="shrink-0 text-xs text-(--bots-attention)">
                {attention.count}
              </span>
            </AppLink>
          ))}
          {waiting.length > 3 && (
            <AppLink
              to="/bots"
              className="text-muted-foreground hover:text-sidebar-foreground px-2 py-1 text-xs"
            >
              {t("bots.sidebar.moreWaiting", { count: waiting.length - 3 })}
            </AppLink>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
