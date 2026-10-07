/**
 * The bot's identity (spec 03 §16.2): ONE element with two homes. It lays out
 * in the title bar's identity slot (its docked, resting state: avatar 22,
 * name, dot + status in a row) and, while the transcript header is in view,
 * its parts are translated and scaled down into the header's layout (avatar
 * 56, name 15/600, status beneath, centred). The move is scroll-linked CSS
 * (bots.css): each part animates from its measured header offset to zero
 * over the first 120 px of the transcript's named scroll timeline, which the
 * shell `timeline-scope`s so the title bar can read it.
 *
 * The header keeps its height with a stand-in (`visibility: hidden`, inert)
 * whose parts are measured against the element's untransformed layout in the
 * title bar; the deltas are written to CSS variables on each part by a
 * ResizeObserver. An IntersectionObserver on the stand-in reports `docked`,
 * which is the whole behaviour where the scroll animation does not run
 * (reduced motion, no support, an inactive timeline): a cut with a 120 ms
 * fade. The same live rig stays interactive in both positions.
 */
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { Store, useStore } from "@tanstack/react-store";
import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { RoutePending } from "#renderer/components/page-state";
import { cn } from "#renderer/lib/cn";
import { AppLink } from "#renderer/lib/navigation/app-link";

import { BotFace } from "../avatar";
import { moodFor, type BotAttention } from "../data/attention";
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
export const BotPending = RoutePending;

const PARTS = ["avatar", "name", "status"] as const;
type Part = (typeof PARTS)[number];

interface IdentityHost {
  /** The travelling element, mounted in the title bar's slot. */
  element: HTMLButtonElement | null;
  /** The stand-in reports the header scrolled out of view. */
  docked: boolean;
  /** The header offsets have been measured at least once. */
  measured: boolean;
}
const host = new Store<IdentityHost>({
  element: null,
  docked: false,
  measured: false,
});

const setHostElement = (element: HTMLButtonElement | null): void =>
  host.setState((state) =>
    element == null
      ? state.element == null
        ? state
        : { element: null, docked: false, measured: false }
      : state.element === element
        ? state
        : { element, docked: false, measured: false }
  );

const part = (root: Element, name: Part): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-part="${name}"]`);

/**
 * Where each part sits in the header relative to its docked layout: the
 * stand-in's rect (at scroll 0: its viewport's scrollTop is added back)
 * against the element's untransformed layout (the button itself never
 * transforms, so its rect is layout; the parts use offsetLeft/Top and
 * offsetWidth/Height, which ignore transforms). Centres are aligned, so the
 * scale is about the part's own origin (0 0) plus the delta.
 */
export const measureIdentity = (
  standIn: HTMLElement,
  element: HTMLElement
): void => {
  const viewport = standIn.closest<HTMLElement>(
    '[data-slot="message-scroller-viewport"]'
  );
  const scrollTop = viewport?.scrollTop ?? 0;
  const dock = element.getBoundingClientRect();
  for (const name of PARTS) {
    const from = part(standIn, name);
    const to = part(element, name);
    if (from == null || to == null) continue;
    const rect = from.getBoundingClientRect();
    const toW = to.offsetWidth;
    const toH = to.offsetHeight;
    const scale =
      name === "avatar"
        ? toH > 0
          ? rect.height / toH
          : 1
        : (Number.parseFloat(getComputedStyle(from).fontSize) || 1) /
          (Number.parseFloat(getComputedStyle(to).fontSize) || 1);
    const toX = dock.left + to.offsetLeft;
    const toY = dock.top + to.offsetTop;
    const dx = rect.left + rect.width / 2 - (toX + (toW * scale) / 2);
    const dy =
      rect.top + scrollTop + rect.height / 2 - (toY + (toH * scale) / 2);
    to.style.setProperty("--bi-x", `${Math.round(dx * 100) / 100}px`);
    to.style.setProperty("--bi-y", `${Math.round(dy * 100) / 100}px`);
    to.style.setProperty("--bi-s", `${Math.round(scale * 1000) / 1000}`);
  }
  host.setState((state) =>
    state.measured ? state : { ...state, measured: true }
  );
};

const statusText = (
  bot: BotRow,
  attention: BotAttention,
  t: ReturnType<typeof useTranslation>["t"]
): string =>
  attention.kind === "idle" ? bot.title : t(`bots.status.${attention.kind}`);

const dotClass = (attention: BotAttention): string =>
  attention.kind === "idle"
    ? "bg-(--bots-done)"
    : attention.kind === "working" || attention.kind === "routine"
      ? "bg-(--bots-running)"
      : "bg-(--bots-attention)";

/**
 * The identity: one button, rendered into the title bar's slot. Clicking it
 * opens or closes the details panel in both states. `travels` is set by a
 * chat with a transcript header (the stand-in below): the parts then rest in
 * the header until the transcript scrolls; a sender chat docks it for good.
 */
export const BotIdentity = ({
  bot,
  travels = false,
  detailsOpen,
  onToggle,
}: {
  bot: BotRow;
  travels?: boolean;
  detailsOpen: boolean;
  onToggle(): void;
}) => {
  const { t } = useTranslation();
  const attention = useBotAttention(bot);
  const docked = useStore(host, (state) => state.docked);
  const measured = useStore(host, (state) => state.measured);
  return (
    <button
      type="button"
      ref={travels ? setHostElement : undefined}
      data-slot="bot-identity"
      data-travels={travels ? "" : undefined}
      data-docked={!travels || docked ? "" : undefined}
      data-measured={!travels || measured ? "" : undefined}
      className={cn(
        "titlebar-nodrag relative z-10 flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-[13px] outline-none",
        "[&:focus-visible>[data-part=avatar]]:ring-ring/40 [&:focus-visible>[data-part=avatar]]:ring-2"
      )}
      title={bot.name}
      onClick={onToggle}
      aria-label={t("bots.panel.detailsFor", { name: bot.name })}
      aria-expanded={detailsOpen}
    >
      <span
        data-part="avatar"
        className="flex size-[22px] shrink-0 rounded-full"
      >
        <BotFace
          bot={bot}
          mood={moodFor(attention)}
          size={travels ? 56 : 22}
          interactive={travels}
          style={{ "--bav-size": "22px" } as CSSProperties}
        />
      </span>
      <span
        data-part="name"
        className="text-sidebar-foreground min-w-0 truncate font-medium"
      >
        {bot.name}
      </span>
      <span
        data-part="status"
        data-slot="bot-identity-status"
        className="text-muted-foreground flex min-w-0 shrink items-center gap-1.5 truncate text-xs"
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClass(attention))}
        />
        <span className="min-w-0 truncate">
          {statusText(bot, attention, t)}
        </span>
      </span>
    </button>
  );
};

/**
 * The header's stand-in at the top of the transcript: the identity's layout
 * at 56 px (centred column), kept invisible so the messages below never
 * jump, and measured so the element can be placed over it. With no
 * travelling element registered (the gallery) it simply shows.
 */
export const BotTranscriptIdentity = ({ bot }: { bot: BotRow }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const attention = useBotAttention(bot);
  const element = useStore(host, (state) => state.element);
  useEffect(() => {
    const standIn = ref.current;
    if (!standIn || element == null) return;
    const measure = () => measureIdentity(standIn, element);
    measure();
    const slot = element.parentElement;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resize?.observe(standIn);
    resize?.observe(element);
    if (slot) resize?.observe(slot);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    const root = standIn.closest('[data-slot="message-scroller-viewport"]');
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              const docked = (entry?.intersectionRatio ?? 1) < 0.5;
              host.setState((state) =>
                state.docked === docked ? state : { ...state, docked }
              );
            },
            { root, threshold: 0.5 }
          );
    observer?.observe(part(standIn, "avatar") ?? standIn);
    return () => {
      resize?.disconnect();
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      host.setState((state) =>
        state.docked || state.measured
          ? { ...state, docked: false, measured: false }
          : state
      );
    };
  }, [element]);
  const standAlone = element == null;
  return (
    <div
      ref={ref}
      data-slot="bot-identity-stand-in"
      aria-hidden={!standAlone}
      inert={!standAlone}
      className={cn(
        "flex flex-col items-center gap-1 pt-7 pb-2",
        !standAlone && "invisible"
      )}
      style={{ "--bav-size": "56px" } as CSSProperties}
    >
      <span data-part="avatar" className="flex size-14 shrink-0">
        {standAlone && (
          <BotFace bot={bot} mood={moodFor(attention)} size={56} />
        )}
      </span>
      <span
        data-part="name"
        className="max-w-full text-[15px] leading-5 font-semibold break-words"
      >
        {bot.name}
      </span>
      <span
        data-part="status"
        className="text-muted-foreground flex items-center gap-1.5 text-xs leading-4"
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClass(attention))}
        />
        <span>{statusText(bot, attention, t)}</span>
      </span>
    </div>
  );
};
