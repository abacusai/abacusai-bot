import { MESSAGE_REACTION_EMOJIS } from "@abacus-ai/contract/message-reactions";
import type { UIMessage } from "@tanstack/ai-client";
import { Copy, Reply, SmilePlus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { useMotionPreference } from "#renderer/lib/motion";
import { BubbleReactions } from "#renderer/ui/bubble";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "#renderer/ui/context-menu";
import { Popover, PopoverTrigger, PopoverContent } from "#renderer/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { updateDraft } from "../composer/draft-store";
import {
  ACTION_BAR_RISE_PX,
  actionBarTransition,
  reactionPillEnter,
  reactionPillExit,
} from "../motion";
import { useChatView } from "./context";
import type { ReplyTarget } from "./reply";

type Emoji = (typeof MESSAGE_REACTION_EMOJIS)[number];

export const messageMarkdown = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("");

/** The gap between the bubble's edge and the bar, and the bar's height. */
const BAR_GAP_PX = 6;
const BAR_HEIGHT_FALLBACK_PX = 36;
/** Leaving the bubble for the bar crosses the gap: keep the bar that long. */
const LEAVE_GRACE_MS = 120;

interface Placement {
  side: "above" | "below";
  top: number;
  left?: number;
  right?: number;
}

/** What the bar must not cover: the rows before and after the message. */
export interface BarObstacles {
  above?: DOMRect | null;
  below?: DOMRect | null;
}

const BAR_WIDTH_FALLBACK_PX = 320;

const intersects = (
  top: number,
  bottom: number,
  left: number,
  right: number,
  rect: DOMRect | null | undefined
): boolean =>
  rect != null &&
  top < rect.bottom &&
  bottom > rect.top &&
  left < rect.right &&
  right > rect.left;

/**
 * Where the bar sits, from the message's rect: above the bubble, aligned
 * to its outer side, flipped below when the transcript viewport leaves no
 * room above or the bar would cover the preceding row (the first message
 * of a day under its date pill, or the sticky pill at the very top). If
 * below would cover the following row too, above wins.
 */
export const placeActionBar = (
  host: DOMRect,
  viewport: DOMRect,
  role: "user" | "assistant",
  barHeight: number,
  windowWidth: number,
  obstacles: BarObstacles = {},
  barWidth = BAR_WIDTH_FALLBACK_PX
): Placement => {
  const left = role === "user" ? host.right - barWidth : host.left;
  const right = left + barWidth;
  const aboveTop = host.top - BAR_GAP_PX - barHeight;
  const belowTop = host.bottom + BAR_GAP_PX;
  const aboveBlocked =
    aboveTop < viewport.top ||
    intersects(aboveTop, aboveTop + barHeight, left, right, obstacles.above);
  const belowBlocked =
    belowTop + barHeight > viewport.bottom ||
    intersects(belowTop, belowTop + barHeight, left, right, obstacles.below);
  const side =
    aboveBlocked && (!belowBlocked || aboveTop < viewport.top)
      ? "below"
      : "above";
  const top = side === "above" ? aboveTop : belowTop;
  return role === "user"
    ? { side, top, right: Math.max(0, windowWidth - host.right) }
    : { side, top, left: Math.max(0, host.left) };
};

const VIEWPORT = '[data-slot="message-scroller-viewport"]';
const TABBABLE =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The first tabbable element after `host` in the document, outside it. */
const tabbableAfter = (host: HTMLElement | null): HTMLElement | null => {
  if (host == null) return null;
  for (const node of document.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (
      host.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !host.contains(node) &&
      node.closest('[data-slot="message-actions-overlay"]') == null
    )
      return node;
  }
  return null;
};

const MotionBubbleReactions = motion.create(BubbleReactions);

const ROW = '[data-slot="message-scroller-item"]';

/** The visible content of a neighbouring row: its pill, its bubble, or itself. */
const rowContent = (row: Element | null): DOMRect | null => {
  if (row == null) return null;
  const inner = row.matches('[data-slot="day-separator"]')
    ? row.firstElementChild
    : row.querySelector("[data-message-target]");
  return (inner ?? row).getBoundingClientRect();
};

const measureBar = (
  host: HTMLElement | null,
  bar: HTMLElement | null,
  role: "user" | "assistant"
): Placement | null => {
  if (host == null) return null;
  const viewport =
    host.closest(VIEWPORT)?.getBoundingClientRect() ??
    new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const row = host.closest(ROW);
  return placeActionBar(
    host.getBoundingClientRect(),
    viewport,
    role,
    bar?.offsetHeight || BAR_HEIGHT_FALLBACK_PX,
    window.innerWidth,
    {
      above: rowContent(row?.previousElementSibling ?? null),
      below: rowContent(row?.nextElementSibling ?? null),
    },
    bar?.offsetWidth || BAR_WIDTH_FALLBACK_PX
  );
};

export const MessageActions = ({
  message,
  text = messageMarkdown(message),
  feedback,
  children,
}: {
  message: UIMessage;
  text?: string;
  feedback?: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const { threadId, session, composer, skin } = useChatView();
  const preference = useMotionPreference();
  const reduce = preference === "reduced";
  const role = message.role === "user" ? "user" : "assistant";
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = !dismissed && (hovered || focused || revealed || menuOpen);
  const show = wanted && (!scrolling || menuOpen);
  const reactions: Emoji[] = message.metadata?.abacus?.reactions ?? [];
  const readOnly = composer.readOnly != null;

  // The bar is an overlay (the transcript's rows contain their paint), so
  // it follows the bubble's rect: measured when shown, again on resize,
  // and hidden while the transcript scrolls until the pointer moves.
  useLayoutEffect(() => {
    if (show) setPlacement(measureBar(hostRef.current, barRef.current, role));
  }, [show, role]);
  useEffect(() => {
    if (!wanted) return;
    const viewport = hostRef.current?.closest(VIEWPORT);
    const onScroll = () => setScrolling(true);
    const onResize = () =>
      setPlacement(measureBar(hostRef.current, barRef.current, role));
    viewport?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      viewport?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [wanted, role]);
  useEffect(
    () => () => {
      if (leaveTimer.current != null) clearTimeout(leaveTimer.current);
    },
    []
  );

  const enter = () => {
    if (leaveTimer.current != null) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
    setDismissed(false);
  };
  /** A popover (the emoji grid, a feedback comment) open from the bar. */
  const expanded = (): boolean =>
    barRef.current?.querySelector('[aria-expanded="true"]') != null;
  const leave = () => {
    if (leaveTimer.current != null) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      if (!expanded()) setHovered(false);
    }, LEAVE_GRACE_MS);
  };
  const within = (node: EventTarget | null): boolean =>
    node instanceof Node &&
    (hostRef.current?.contains(node) === true ||
      barRef.current?.contains(node) === true);
  const onFocusCapture = () => {
    setFocused(true);
    setDismissed(false);
  };
  const onBlurCapture = (event: React.FocusEvent) => {
    if (!within(event.relatedTarget) && !expanded()) setFocused(false);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setDismissed(true);
      setRevealed(false);
      setMenuOpen(false);
    }
  };
  // The bar lives in an overlay, so Tab order is stitched back by hand:
  // host → first button, Shift+Tab from the first button → host, and Tab
  // from the last button → whatever follows the message in the document.
  const onHostKeyDown = (event: React.KeyboardEvent) => {
    onKeyDown(event);
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      event.target === hostRef.current &&
      show
    ) {
      const first = barRef.current?.querySelector<HTMLElement>(TABBABLE);
      if (first != null) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  const onBarKeyDown = (event: React.KeyboardEvent) => {
    onKeyDown(event);
    if (event.key !== "Tab" || barRef.current == null) return;
    const buttons = [
      ...barRef.current.querySelectorAll<HTMLElement>(TABBABLE),
    ].filter((node) => node.closest("[data-slot=message-actions]") != null);
    if (event.shiftKey && event.target === buttons[0]) {
      event.preventDefault();
      hostRef.current?.focus();
    } else if (!event.shiftKey && event.target === buttons.at(-1)) {
      const next = tabbableAfter(hostRef.current);
      if (next != null) {
        event.preventDefault();
        next.focus();
      }
    }
  };

  const reply = () => {
    const replyTo: ReplyTarget = {
      messageId: message.id,
      role,
      excerpt: text.slice(0, 80),
    };
    updateDraft(threadId, (draft) => ({ ...draft, replyTo }));
    document
      .querySelector<HTMLTextAreaElement>(
        `[data-continuity-id="composer:${CSS.escape(threadId)}"]`
      )
      ?.focus();
  };
  const react = (emoji: Emoji) => {
    setError(false);
    setPending(true);
    void session
      .react(message.id, emoji, !reactions.includes(emoji))
      .catch(() => setError(true))
      .finally(() => setPending(false));
  };
  const reactionButton = (emoji: Emoji, cell = false) => (
    <Button
      key={emoji}
      variant="ghost"
      size="icon"
      className={cn(
        "aria-pressed:bg-foreground/10 rounded-full text-base",
        cell && "size-8 rounded-md"
      )}
      aria-label={t("chat.actions.react", { emoji })}
      aria-pressed={reactions.includes(emoji)}
      disabled={readOnly || pending}
      onClick={() => react(emoji)}
    >
      <span aria-hidden>{emoji}</span>
    </Button>
  );
  const iconButton = (
    label: string,
    icon: ReactNode,
    props: React.ComponentProps<typeof Button>
  ) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={label}
            {...props}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  const rise = reduce ? 0 : ACTION_BAR_RISE_PX;
  const bar = (
    <motion.div
      key="bar"
      ref={barRef}
      data-slot="message-actions-overlay"
      data-side={placement?.side ?? "above"}
      className={cn(
        "fixed z-40 has-[[aria-expanded=true]]:pointer-events-auto! has-[[aria-expanded=true]]:opacity-100!",
        // The hit area reaches across the gap to the bubble.
        placement?.side === "below" ? "pt-1.5" : "pb-1.5"
      )}
      initial={{ opacity: 0, y: rise }}
      animate={{ opacity: show ? 1 : 0, y: show ? 0 : rise }}
      exit={{ opacity: 0, y: rise }}
      transition={actionBarTransition(preference)}
      style={{
        top:
          placement == null
            ? 0
            : placement.side === "above"
              ? placement.top
              : placement.top - BAR_GAP_PX,
        left: placement?.left,
        right: placement?.right,
        visibility: placement == null ? "hidden" : undefined,
        pointerEvents: show ? "auto" : "none",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      onKeyDown={onBarKeyDown}
    >
      <div
        data-slot="message-actions"
        aria-label={t("chat.actions.label")}
        role="toolbar"
        className={cn(
          "bg-popover/70 text-popover-foreground ring-foreground/10 relative isolate flex max-w-[calc(100vw-16px)] items-center gap-0.5 rounded-full p-1 shadow-md ring-1 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-xl before:backdrop-saturate-[1.3]",
          role === "user" && "flex-row-reverse"
        )}
      >
        {MESSAGE_REACTION_EMOJIS.slice(0, 5).map((emoji) =>
          reactionButton(emoji)
        )}
        <Popover onOpenChange={setMenuOpen}>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      aria-label={t("chat.actions.moreReactions")}
                    />
                  }
                />
              }
            >
              <SmilePlus aria-hidden className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("chat.actions.moreReactions")}</TooltipContent>
          </Tooltip>
          <PopoverContent
            data-slot="reaction-grid"
            className="grid w-fit grid-cols-8 gap-0.5 p-1.5"
            side="top"
            align={role === "user" ? "end" : "start"}
          >
            {MESSAGE_REACTION_EMOJIS.map((emoji) =>
              reactionButton(emoji, true)
            )}
          </PopoverContent>
        </Popover>
        {iconButton(t("chat.actions.reply"), <Reply className="size-4" />, {
          onClick: reply,
          disabled: readOnly,
        })}
        {iconButton(t("chat.actions.copy"), <Copy className="size-4" />, {
          onClick: () => {
            void navigator.clipboard
              .writeText(text)
              .catch(() => setError(true));
          },
        })}
        {feedback}
      </div>
    </motion.div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        className={cn("flex min-w-0", role === "user" && "justify-end")}
      >
        <div
          ref={hostRef}
          data-slot="message-actions-host"
          data-message-target={message.id}
          tabIndex={0}
          className={cn(
            "focus-visible:ring-ring relative min-w-[min(100%,320px)] rounded-[20px] outline-none focus-visible:ring-2",
            role === "user" ? "w-fit max-w-full self-end" : "w-fit max-w-full",
            // Room for the tapback pill hanging off the bubble's bottom edge.
            skin === "session" &&
              role === "assistant" &&
              reactions.length > 0 &&
              "mb-2"
          )}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onPointerMove={() => {
            if (scrolling) {
              setScrolling(false);
              setPlacement(measureBar(hostRef.current, barRef.current, role));
            }
          }}
          onFocusCapture={onFocusCapture}
          onBlurCapture={onBlurCapture}
          onClick={(event) => {
            if (
              window.matchMedia("(max-width: 799px)").matches &&
              !(event.target as HTMLElement).closest("button,a,input,textarea")
            ) {
              setRevealed((value) => !value);
              setDismissed(revealed);
            }
          }}
          onKeyDown={onHostKeyDown}
        >
          {children}
          {createPortal(
            <AnimatePresence>{wanted ? bar : null}</AnimatePresence>,
            document.body
          )}
          {skin === "session" && role === "assistant" ? (
            <MessageReactionPills message={message} />
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {t("chat.actions.failed")}
            </p>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem disabled={readOnly} onClick={reply}>
            <Reply aria-hidden />
            {t("chat.actions.reply")}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/**
 * The user's own reactions as a tapback pill on the bubble's bottom corner
 * (user bubbles bottom-left, assistant bottom-right), ringed in the pane
 * colour so it reads as sitting on the edge. `inline` lays it next to the
 * bot's ReactionBadge instead, when a user bubble carries both.
 */
export const MessageReactionPills = ({
  message,
  inline = false,
}: {
  message: UIMessage;
  inline?: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  const preference = useMotionPreference();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const reactions: Emoji[] = message.metadata?.abacus?.reactions ?? [];
  const align = message.role === "user" ? "start" : "end";
  const pills = (
    <AnimatePresence initial={false}>
      {reactions.map((emoji) => (
        <motion.span
          key={emoji}
          className="flex"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{
            scale: 1,
            opacity: 1,
            transition: reactionPillEnter(preference),
          }}
          exit={{
            scale: 0.8,
            opacity: 0,
            transition: reactionPillExit(preference),
          }}
        >
          <Button
            variant="ghost"
            size="xs"
            className="hover:bg-foreground/10 h-5 min-w-5 rounded-full px-1 text-[13px]/none"
            aria-label={t("chat.actions.removeReaction", { emoji })}
            aria-pressed
            disabled={composer.readOnly != null || pending}
            onClick={() => {
              setPending(true);
              setFailed(false);
              void session
                .react(message.id, emoji, false)
                .catch(() => setFailed(true))
                .finally(() => setPending(false));
            }}
          >
            {emoji}
          </Button>
        </motion.span>
      ))}
    </AnimatePresence>
  );
  if (!reactions.length && !failed) return null;
  return (
    <>
      <AnimatePresence initial={false}>
        {reactions.length ? (
          <MotionBubbleReactions
            key="pills"
            align={align}
            className={cn(
              "bg-muted text-foreground ring-background gap-0 shadow-sm ring-2 has-[button]:p-0.5",
              inline
                ? "relative inset-auto translate-y-0"
                : "-bottom-1.5 translate-y-0"
            )}
            data-inline={inline ? "" : undefined}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{
              scale: 1,
              opacity: 1,
              transition: reactionPillEnter(preference),
            }}
            exit={{
              scale: 0.8,
              opacity: 0,
              transition: reactionPillExit(preference),
            }}
          >
            {pills}
          </MotionBubbleReactions>
        ) : null}
      </AnimatePresence>
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          {t("chat.actions.failed")}
        </p>
      ) : null}
    </>
  );
};
