import {
  Activity,
  AtSign,
  BarChart3,
  BellRing,
  BookOpen,
  Bot as BotIcon,
  Briefcase,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  Eye,
  FileCheck,
  FileText,
  Flame,
  Inbox,
  LineChart,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Microscope,
  PenLine,
  Plane,
  Radar,
  Receipt,
  Repeat,
  Rocket,
  Scale,
  Search,
  Send,
  Sparkles,
  Sun,
  Target,
  TrendingUp,
  UserCheck,
  Users,
  UserSearch,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import {
  defaultAvatarColor,
  defaultAvatarShape,
  MAX_BOT_NAME,
  type Bot,
} from "#shared/bots";

import { useBotsQuery } from "../../hooks/use-bots";
import { useConnectedConnectors } from "../../hooks/use-connected-connectors";
import { Button, Input } from "../ui";
import { BotAvatarPicker, type BotAvatarLook } from "./bot-avatar-picker";
import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  orderedTemplateIds,
  type BotTemplate,
  type BotTemplateCategory,
} from "./bot-templates";
import { NewBotDialog } from "./new-bot-dialog";

/**
 * The first page of Bots: a name box and Create, which opens the new-bot dialog
 * with whatever was typed filled in. Below, the template catalog, one tab per
 * category; a card opens the same dialog prefilled, so a bot from a card and a
 * bot from scratch go through one form.
 */

/** The icon and tile colour each template wears on its card. */
const TEMPLATE_PRESENTATION: Record<
  string,
  { icon: LucideIcon; color: string }
> = {
  // Featured
  "chief-of-staff": { icon: Briefcase, color: "#22c55e" },
  "whatsapp-agent": { icon: MessageCircle, color: "#22c55e" },
  "email-drafting": { icon: Mail, color: "#ef4444" },
  "telegram-agent": { icon: Send, color: "#0ea5e9" },
  "whats-hot": { icon: Flame, color: "#f97316" },
  "morning-brief": { icon: Sun, color: "#3b82f6" },
  "daily-stock-recommender": { icon: TrendingUp, color: "#6366f1" },
  "meeting-prep-bot": { icon: CalendarCheck, color: "#8b5cf6" },
  "discord-agent": { icon: MessagesSquare, color: "#6366f1" },
  "follow-up-tracker": { icon: ListChecks, color: "#14b8a6" },
  // Personal assistant
  "calendar-concierge": { icon: CalendarDays, color: "#3b82f6" },
  "inbox-to-calendar": { icon: Inbox, color: "#f97316" },
  "travel-planner": { icon: Plane, color: "#0ea5e9" },
  "personal-admin": { icon: ClipboardList, color: "#b08968" },
  "appointment-assistant": { icon: BellRing, color: "#ec4899" },
  // Productivity
  "daily-focus-planner": { icon: Target, color: "#ef4444" },
  "meeting-notes-actions": { icon: FileText, color: "#3b82f6" },
  "project-pulse": { icon: Activity, color: "#22c55e" },
  "knowledge-finder": { icon: Search, color: "#a855f7" },
  "weekly-review": { icon: CalendarClock, color: "#eab308" },
  // Social media
  "social-inbox-manager": { icon: Inbox, color: "#0ea5e9" },
  "trend-scout": { icon: Sparkles, color: "#f97316" },
  "content-repurposer": { icon: Repeat, color: "#a855f7" },
  "daily-post-writer": { icon: PenLine, color: "#ec4899" },
  "comment-mention-assistant": { icon: AtSign, color: "#14b8a6" },
  // Research
  "deep-researcher": { icon: Microscope, color: "#6366f1" },
  "competitor-watch": { icon: Eye, color: "#ef4444" },
  "news-radar": { icon: Radar, color: "#3b82f6" },
  "research-paper-scout": { icon: BookOpen, color: "#a855f7" },
  "decision-researcher": { icon: Scale, color: "#eab308" },
  // Finance
  "portfolio-pulse": { icon: LineChart, color: "#22c55e" },
  "earnings-watch": { icon: BarChart3, color: "#3b82f6" },
  "spending-digest": { icon: Receipt, color: "#f97316" },
  "bills-renewal-watch": { icon: CreditCard, color: "#ef4444" },
  // Marketing
  "launch-command-center": { icon: Rocket, color: "#a855f7" },
  "customer-voice-miner": { icon: Users, color: "#14b8a6" },
  "competitor-campaign-watch": { icon: Megaphone, color: "#f97316" },
  "content-calendar-manager": { icon: CalendarDays, color: "#3b82f6" },
  "campaign-performance-digest": { icon: BarChart3, color: "#22c55e" },
  // Recruiting
  "candidate-sourcer": { icon: UserSearch, color: "#3b82f6" },
  "resume-review-assistant": { icon: FileCheck, color: "#a855f7" },
  "interview-coordinator": { icon: CalendarClock, color: "#0ea5e9" },
  "candidate-follow-up": { icon: UserCheck, color: "#22c55e" },
  "hiring-manager-brief": { icon: ClipboardCheck, color: "#f97316" },
};

export const BotsHome = ({
  onCreated,
}: {
  onCreated: (bot: Bot) => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const botsQuery = useBotsQuery();
  const isFirstBot = (botsQuery.data ?? []).length === 0;

  const [name, setName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  /** The card the open dialog was opened from; null for a scratch bot. */
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  const [category, setCategory] = useState<BotTemplateCategory>("featured");
  // The name's default until the user picks; the pick carries into the dialog.
  const [pickedLook, setPickedLook] = useState<BotAvatarLook | null>(null);
  const look: BotAvatarLook = pickedLook ?? {
    shape: defaultAvatarShape(name.trim()),
    color: defaultAvatarColor(name.trim()),
  };

  // What is connected decides what leads within a tab.
  const connectors = useConnectedConnectors();
  const templates = useMemo(
    () =>
      orderedTemplateIds(category, connectors)
        .map((id) => BOT_TEMPLATES.find((template) => template.id === id))
        .filter((template) => template != null),
    [category, connectors]
  );

  const openDialog = (): void => {
    setTemplate(null);
    setDialogOpen(true);
  };

  const openTemplate = (templateId: string): void => {
    const picked = BOT_TEMPLATES.find((entry) => entry.id === templateId);
    if (picked == null) return;
    setTemplate(picked);
    setDialogOpen(true);
  };

  const handleNameKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.key === "Enter") openDialog();
  };

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col items-center overflow-y-auto px-6 py-8"
      data-id="bots-home"
    >
      <NewBotDialog
        isOpen={dialogOpen}
        initialName={name}
        initialLook={pickedLook}
        template={template}
        onClose={() => setDialogOpen(false)}
        onCreated={(bot) => {
          setDialogOpen(false);
          onCreated(bot);
        }}
      />
      <div className="my-auto flex w-full max-w-6xl flex-col items-center">
        {/* The bot's own face, not the mascot: it follows the name as typed
            and the pencil opens the picker. */}
        <BotAvatarPicker
          seed={name.trim() || "new-bot"}
          look={look}
          onChange={setPickedLook}
          size={64}
          dataId="bots-home-face"
        />

        <h1 className="mt-4 text-center text-3xl font-bold tracking-tight">
          {t("bots.home.heading")}{" "}
          <span className="text-primary">{t("bots.home.headingAccent")}</span>
        </h1>
        <p className="text-muted-foreground mt-2 text-center">
          {t("bots.home.subtitle")}
        </p>

        <div className="mt-6 w-full max-w-xl">
          <div className="relative">
            <BotIcon
              className="text-primary pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              id="bots-home-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={handleNameKeyDown}
              placeholder={t("bots.home.namePlaceholder")}
              maxLength={MAX_BOT_NAME}
              data-id="bots-home-name-input"
              autoFocus={isFirstBot}
              className="h-12 rounded-xl pl-11 text-base"
            />
          </div>

          <div className="mt-4 flex justify-center">
            <Button
              data-id="bots-home-get-started"
              onClick={openDialog}
              className="from-primary h-12 w-full max-w-md rounded-xl bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
            >
              {t("bots.home.createCta")}
            </Button>
          </div>
        </div>

        {/* Each card opens the create dialog prefilled with that role, so
            everything stays editable before Create. */}
        <div className="mt-8 w-full">
          <div className="mx-auto mb-5 flex max-w-md items-center gap-3">
            <span className="bg-border h-px flex-1" aria-hidden="true" />
            <span className="text-muted-foreground text-sm">
              {t("bots.home.templatesDivider")}
            </span>
            <span className="bg-border h-px flex-1" aria-hidden="true" />
          </div>

          {/* Tabs wrap onto a second line at narrow widths rather than
              clipping or scrolling, so every category stays reachable. */}
          <div
            role="tablist"
            aria-label={t("bots.home.categoriesLabel")}
            className="mb-5 flex flex-wrap justify-center gap-2"
            data-id="bots-home-categories"
          >
            {BOT_TEMPLATE_CATEGORIES.map((id) => {
              const active = id === category;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-id={`bots-home-category-${id}`}
                  onClick={() => setCategory(id)}
                  className={
                    active
                      ? "bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium"
                      : "border-border bg-card text-foreground hover:border-primary/40 rounded-lg border px-4 py-2 text-sm font-medium transition-colors"
                  }
                >
                  {t(`bots.home.categories.${id}`)}
                </button>
              );
            })}
          </div>

          {/* Auto-fill columns, not a fixed count per breakpoint: the pane can
              be any width, and a fixed count leaves an orphan card or squeezes
              five into a space for three. The minimum lets the full width take
              five, so a full page shows complete rows (ten featured, five per
              other tab). */}
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-3"
            data-id="bots-home-suggestions"
          >
            {templates.map((template) => {
              const presentation = TEMPLATE_PRESENTATION[template.id];
              const Icon = presentation?.icon ?? BotIcon;
              return (
                <button
                  key={template.id}
                  type="button"
                  data-id={`bots-home-template-${template.id}`}
                  onClick={() => openTemplate(template.id)}
                  className="border-border bg-card hover:border-primary/40 flex h-full flex-col items-start rounded-2xl border p-3.5 text-left transition-colors"
                >
                  <span className="flex w-full items-center gap-2.5">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor:
                          presentation?.color ?? template.avatarColor,
                      }}
                    >
                      <Icon className="size-5 text-white" aria-hidden="true" />
                    </span>
                    <span className="text-foreground min-w-0 text-sm leading-tight font-semibold">
                      {t(`bots.templates.${template.id}.name`)}
                    </span>
                  </span>
                  <span className="text-muted-foreground mt-2.5 line-clamp-3 text-xs leading-snug">
                    {t(`bots.templates.${template.id}.description`)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
