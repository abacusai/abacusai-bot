/**
 * "Pick up where you left off" on the home screen (contract resume-card.ts):
 * after a long time away, the user's latest chat that ended on a result, with
 * the next steps it offered as chips. A chip opens the chat with its text in
 * the composer, never sent. Closed by hand, or gone once the user writes.
 */
import {
  isSuggestTasksTool,
  suggestedTasks,
  suggestsNextStep,
} from "@abacus-ai/contract/bots/suggested-tasks";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  RESUME_CARD_MAX_CHIPS,
  resumeCardDue,
  type ResumeCardMark,
} from "@abacus-ai/contract/resume-card";
import { parsePartialJSON, type UIMessage } from "@tanstack/ai-client";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useRouter } from "@tanstack/react-router";
import { History, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCollections, useDb } from "#renderer/data/db";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { externalOpenSince } from "#renderer/lib/navigation/external-open";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

/** A tool call's arguments, parsed if the transcript kept them as text. */
const callInput = (part: { input?: unknown; arguments: string }): unknown =>
  part.input ?? (part.arguments === "" ? {} : parsePartialJSON(part.arguments));

/** The next steps the latest result offered (suggest_tasks after_result), at most three, none copied. */
export const resumeCardChips = (messages: readonly UIMessage[]): string[] => {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool-call" || !isSuggestTasksTool(part.name)) continue;
      const input = callInput(part);
      if (!suggestsNextStep(input)) continue;
      return suggestedTasks(input)
        .filter((task) => !task.copy)
        .slice(0, RESUME_CARD_MAX_CHIPS)
        .map((task) => task.text);
    }
  }
  return [];
};

/** The mark the card shows at `now`: due, and its chat still one the user has. */
export const resumeCardShown = (
  mark: ResumeCardMark | null,
  row: Pick<SessionRow, "routineId" | "editorFor"> | undefined,
  now: number
): ResumeCardMark | null =>
  resumeCardDue(mark, now) &&
  row != null &&
  row.routineId == null &&
  row.editorFor == null
    ? mark
    : null;

/** "yesterday", "3 days ago": the card shows only after most of a day away. */
const ago = (at: number, now: number, language: string): string => {
  const hours = Math.max(0, Math.floor((now - at) / 3_600_000));
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  return hours < 24
    ? format.format(-hours, "hour")
    : format.format(-Math.floor(hours / 24), "day");
};

export const ResumeCardView = ({
  title,
  resultAt,
  now,
  chips,
  onOpen,
  onClose,
}: {
  title: string | null;
  resultAt: number;
  now: number;
  chips: readonly string[];
  /** `text`: the chip tapped, for the composer; none for the chat itself. */
  onOpen: (text?: string) => void;
  onClose: () => void;
}) => {
  const { t, i18n } = useTranslation();
  return (
    <section
      aria-label={t("bots.start.resume.title")}
      data-testid="resume-card"
      className="bg-background flex w-full max-w-[560px] items-start gap-3 rounded-2xl border p-4 text-start"
    >
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[10px]"
      >
        <History className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-muted-foreground text-xs">
            {t("bots.start.resume.title")}
          </h2>
          <button
            type="button"
            className="truncate text-start text-sm font-medium hover:underline"
            onClick={() => onOpen()}
          >
            {title ?? t("bots.start.resume.untitled")}
          </button>
          <time
            dateTime={new Date(resultAt).toISOString()}
            className="text-muted-foreground text-xs"
          >
            {ago(resultAt, now, i18n.language)}
          </time>
        </div>
        {chips.length > 0 ? (
          <div
            role="group"
            aria-label={t("bots.start.resume.nextSteps")}
            className="flex w-full flex-wrap gap-2"
          >
            {chips.map((chip) => (
              <Button
                key={chip}
                size="sm"
                variant="outline"
                className="h-auto max-w-full rounded-full py-1.5 text-left whitespace-normal"
                onClick={() => onOpen(chip)}
              >
                <span className="min-w-0">{chip}</span>
              </Button>
            ))}
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onOpen()}>
            {t("bots.start.resume.open")}
          </Button>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("bots.start.resume.dismiss")}
        onClick={onClose}
      >
        <X />
      </Button>
    </section>
  );
};

/**
 * Whether opening the app now lands on home, where the card is: once per
 * result, the first time the app launches or its window shows while the card
 * is due. A later visit keeps the page the user chose.
 */
export const createResumeLanding = () => {
  const landed = new Set<number>();
  return (mark: ResumeCardMark | null | undefined, now: number): boolean => {
    if (!resumeCardDue(mark, now) || landed.has(mark.resultAt)) return false;
    landed.add(mark.resultAt);
    return true;
  };
};

export const landOnResumeCard = createResumeLanding();

/** A link, a notice or the user's own click opens its place after the window shows; this waits it out. */
export const RESUME_LANDING_WAIT_MS = 500;

/**
 * The window shown again after a long time away: home, unless something chose
 * where to go meanwhile. Any navigation since the window showed (a link, a
 * notification or notch click, the user's own click) keeps its page; an opener
 * that lands on the page already showing says so through markExternalOpen.
 */
export const ResumeCardReturn = (): null => {
  const db = useDb();
  const navigate = useAppNavigate();
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shown = (): void => {
      if (document.hidden) return;
      const at = Date.now();
      const where = router.latestLocation.href;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (externalOpenSince(at) || router.latestLocation.href !== where)
          return;
        const mark = db.collections.prefs.get("app")?.dismissals.resumeCard;
        if (landOnResumeCard(mark, Date.now()))
          void navigate({ to: "/bots/new", transition: "nav-lateral" });
      }, RESUME_LANDING_WAIT_MS);
    };
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, [db, navigate, router]);
  return null;
};

/** Results already counted as shown, so a revisit of home counts nothing. */
const shown = new Set<number>();

export const ResumeCard = ({
  messagesOf,
  openChat,
}: {
  /** The chat's messages, loaded off screen. */
  messagesOf(threadId: string): Promise<readonly UIMessage[]>;
  /** Opens the chat with `text` in its composer, never sent. */
  openChat(sessionId: string, text: string | null): void;
}) => {
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const collections = useCollections();
  const { transport } = useAppContext();
  // Decided once per visit: the card does not appear under the user's hands.
  const [now] = useState(() => Date.now());
  const mark = prefs.dismissals.resumeCard ?? null;
  const row = useLiveQuery({
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, mark?.sessionId ?? ""))
        .findOne(),
  }).data;
  const due = resumeCardShown(mark, row, now);
  const visible = due != null && row != null;
  const [chips, setChips] = useState<{ id: string; texts: string[] } | null>(
    null
  );
  const sessionId = visible ? due.sessionId : null;
  useEffect(() => {
    if (sessionId == null) return;
    let live = true;
    void messagesOf(sessionId)
      .then((messages) => {
        if (live) setChips({ id: sessionId, texts: resumeCardChips(messages) });
      })
      .catch(() => {
        if (live) setChips({ id: sessionId, texts: [] });
      });
    return () => {
      live = false;
    };
  }, [sessionId, messagesOf]);
  const funnel = (
    step: "resume_card_shown" | "resume_card_opened" | "resume_card_dismissed",
    detail?: string
  ) =>
    void transport.client.system
      .funnelStep({ step, ...(detail != null && { detail }) })
      .catch(() => undefined);
  const reportShown = useEffectEvent((resultAt: number) => {
    if (shown.has(resultAt)) return;
    shown.add(resultAt);
    funnel("resume_card_shown");
  });
  const ready = visible && chips?.id === due.sessionId;
  useEffect(() => {
    if (ready) reportShown(due.resultAt);
  }, [ready, due?.resultAt]);
  if (!ready) return null;
  return (
    <ResumeCardView
      title={row.label.trim() || null}
      resultAt={due.resultAt}
      now={now}
      chips={chips.texts}
      onOpen={(text) => {
        funnel("resume_card_opened", text == null ? "chat" : "chip");
        openChat(due.sessionId, text ?? null);
      }}
      onClose={() => {
        funnel("resume_card_dismissed");
        void update({
          dismissals: { resumeCard: { ...due, closedAt: Date.now() } },
        }).catch(() => undefined);
      }}
    />
  );
};

const GALLERY_NOW = Date.UTC(2026, 10, 12, 9, 0);

/** The card as a returning user sees it: with next steps, and without. */
export const ResumeCardGallery = ({ chips }: { chips: boolean }) => (
  <div className="flex max-w-[640px] flex-col items-center p-6">
    <ResumeCardView
      title={
        "Landing page for my bakery" /* i18n-ignore: dev-only gallery fixture */
      }
      resultAt={GALLERY_NOW - 26 * 3_600_000}
      now={GALLERY_NOW}
      chips={
        chips
          ? [
              "Add my real menu and prices" /* i18n-ignore: dev-only gallery fixture */,
              "Add an online order form" /* i18n-ignore: dev-only gallery fixture */,
              "Check new reviews every Monday" /* i18n-ignore: dev-only gallery fixture */,
            ]
          : []
      }
      onOpen={() => undefined}
      onClose={() => undefined}
    />
  </div>
);
