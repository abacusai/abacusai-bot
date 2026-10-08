import { MESSAGE_REACTION_EMOJIS } from "@abacus-ai/contract/message-reactions";
import type { UIMessage } from "@tanstack/ai-client";
import { ChevronDown, Copy, Plus, Reply, Smile } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";
import { useMotionPreference } from "#renderer/lib/motion";
import { BubbleReactions } from "#renderer/ui/bubble";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
} from "#renderer/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { reactionPillEnter, reactionPillExit } from "../motion";
import { useChatView } from "./context";
import type { ReplyTarget } from "./reply";

type Emoji = (typeof MESSAGE_REACTION_EMOJIS)[number];
type Role = "user" | "assistant";

export const messageMarkdown = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("");

/*
 * The affordance (WhatsApp Web, iMessage): hovering a message shows one
 * small "add reaction" smiley beside the bubble on its inner side,
 * vertically centred, and a chevron inside the bubble's top corner for the
 * message menu. Nothing floats above the bubble at rest; the reaction tray
 * opens from the smiley, anchored above the bubble on the smiley's side.
 *
 * The smiley is a single element per transcript: one registry Popover
 * whose root wraps the transcript, with a hidden trigger inside every
 * bubble (`MessageAnchor`) and the hovered message's trigger selected
 * through the root's controlled `triggerId`. Base UI's positioner anchors
 * the popup to that trigger, so moving between messages re-anchors the
 * same element (the positioner's transform transitions, chat.css) instead
 * of unmounting and remounting it.
 */

/** A quick pass over a message does not flicker the affordance. */
export const HOVER_INTENT_MS = 80;
/** Leaving the bubble for the smiley crosses a gap: keep it that long. */
export const LEAVE_GRACE_MS = 120;
/** The smiley's distance from the bubble's inner edge. */
export const AFFORDANCE_GAP_PX = 6;
/** The tray's distance above the bubble. */
export const TRAY_GAP_PX = 6;
const TRAY_HEIGHT_FALLBACK_PX = 44;
const TRAY_WIDTH_FALLBACK_PX = 300;
const QUICK_REACTIONS = 6;

const VIEWPORT = '[data-slot="message-scroller-viewport"]';
const ROW = '[data-slot="message-scroller-item"]';
const ANCHOR = '[data-slot="message-anchor"]';
const AFFORDANCE = '[data-slot="message-actions-popup"]';
/** A popup open from the affordance: never the bubble's hidden anchor. */
const EXPANDED = `[aria-expanded="true"]:not(${ANCHOR})`;
const TABBABLE =
  'button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const anchorId = (id: string) => `message-anchor:${id}`;

/** Above or below the bubble, or beside the smiley as the last resort. */
export type TraySide = "top" | "bottom" | "side";

/**
 * What the tray must not cover: the rows before and after the message, and
 * the transcript's visible area (its viewport less the composer dock).
 */
export interface TrayObstacles {
  above?: DOMRect | null;
  below?: DOMRect | null;
  viewport?: DOMRect | null;
}

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

/** The positioner's own margin from the clipping boundary. */
const COLLISION_PADDING_PX = 5;

const outside = (
  top: number,
  bottom: number,
  viewport: DOMRect | null | undefined
): boolean =>
  viewport != null &&
  viewport.height > 0 &&
  (top < viewport.top + COLLISION_PADDING_PX ||
    bottom > viewport.bottom - COLLISION_PADDING_PX);

/**
 * Where the tray goes, so it never covers a bubble's text: above the
 * bubble on the smiley's side; below when above would cover the preceding
 * row (the first message of a day under its date pill, a bot bubble a few
 * pixels under the previous one) or leave the viewport; beside the smiley,
 * on the same row and extending away from the bubble, when below is
 * blocked too. The primitive still flips a side that leaves the viewport,
 * but a side chosen here fits, so it has nothing to flip.
 */
export const preferTraySide = (
  bubble: DOMRect,
  tray: { width: number; height: number },
  role: Role,
  obstacles: TrayObstacles = {},
  gap = TRAY_GAP_PX
): TraySide => {
  // The tray aligns to the bubble's inner side: a user bubble's left edge,
  // an assistant bubble's right edge.
  const left = role === "user" ? bubble.left : bubble.right - tray.width;
  const right = left + tray.width;
  const aboveBottom = bubble.top - gap;
  const aboveTop = aboveBottom - tray.height;
  const belowTop = bubble.bottom + gap;
  const belowBottom = belowTop + tray.height;
  const aboveBlocked =
    intersects(aboveTop, aboveBottom, left, right, obstacles.above) ||
    outside(aboveTop, aboveBottom, obstacles.viewport);
  const belowBlocked =
    intersects(belowTop, belowBottom, left, right, obstacles.below) ||
    outside(belowTop, belowBottom, obstacles.viewport);
  if (!aboveBlocked) return "top";
  return belowBlocked ? "side" : "bottom";
};

/** The visible content of a neighbouring row: its pill, its bubble, or itself. */
const rowContent = (row: Element | null): DOMRect | null => {
  if (row == null) return null;
  const inner = row.matches('[data-slot="day-separator"]')
    ? row.firstElementChild
    : row.querySelector("[data-message-target]");
  return (inner ?? row).getBoundingClientRect();
};

/** The transcript's visible area: its viewport, less the composer dock over its end. */
const visibleArea = (host: HTMLElement): DOMRect | null => {
  const viewport = host.closest(VIEWPORT)?.getBoundingClientRect();
  if (viewport == null) return null;
  const dock = host
    .closest('[data-slot="chat-layout"]')
    ?.querySelector('[data-slot="composer-dock"]')
    ?.getBoundingClientRect();
  const bottom =
    dock != null && dock.height > 0
      ? Math.min(viewport.bottom, dock.top)
      : viewport.bottom;
  return new DOMRect(
    viewport.left,
    viewport.top,
    viewport.width,
    Math.max(0, bottom - viewport.top)
  );
};

const measureTraySide = (
  host: HTMLElement,
  bubble: Element,
  tray: HTMLElement | null,
  role: Role
): TraySide => {
  const row = host.closest(ROW);
  return preferTraySide(
    bubble.getBoundingClientRect(),
    {
      width: tray?.offsetWidth || TRAY_WIDTH_FALLBACK_PX,
      height: tray?.offsetHeight || TRAY_HEIGHT_FALLBACK_PX,
    },
    role,
    {
      above: rowContent(row?.previousElementSibling ?? null),
      below: rowContent(row?.nextElementSibling ?? null),
      viewport: visibleArea(host),
    }
  );
};

/** The first tabbable element after `host` in the document, outside it. */
const tabbableAfter = (host: HTMLElement | null): HTMLElement | null => {
  if (host == null) return null;
  for (const node of document.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (
      host.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !host.contains(node) &&
      node.closest(AFFORDANCE) == null
    )
      return node;
  }
  return null;
};

/** The message the affordance is on, and what its widgets act on. */
interface Target {
  id: string;
  role: Role;
  element: HTMLElement;
  /** The hidden trigger over the bubble the smiley and tray anchor to. */
  anchor: HTMLElement;
  viewport: HTMLElement | null;
}

interface Descriptor {
  message: UIMessage;
  text: string;
}

type Active = Target & Descriptor;

interface Controller {
  /** Hosts describe themselves on every render; the affordance reads it. */
  describe(id: string, descriptor: Descriptor, fail: () => void): void;
  forget(id: string): void;
  /** The host shows a failed action under its message. */
  fail(id: string): void;
  enter(target: Target): void;
  leave(): void;
  focus(target: Target): void;
  blur(): void;
  toggle(target: Target): void;
  dismiss(): void;
  settle(): void;
  /** Whether `node` is inside the positioned affordance. */
  contains(node: EventTarget | null): boolean;
  focusFirst(): boolean;
  /** Tab order stitched across the body: smiley → chevron → what follows. */
  onKeyDown(event: React.KeyboardEvent): void;
  onOpenChange: NonNullable<
    React.ComponentProps<typeof Popover>["onOpenChange"]
  >;
  pointerIn(): void;
  focusIn(): void;
  /** A popup (the tray, the menu, a feedback comment) open from the affordance. */
  expanded(): boolean;
  /** The popup's ref, handed over once mounted. */
  attach(popup: React.RefObject<HTMLElement | null>): void;
}

/** The controller never changes identity; hosts bind to it once. */
const ControllerContext = createContext<Controller | null>(null);
/** The message holding the affordance, for the hosts' `data-active`. */
const ActiveContext = createContext<string | null>(null);

const targetOf = (
  id: string,
  role: Role,
  element: HTMLElement
): Target | null => {
  const anchor = element.querySelector<HTMLElement>(ANCHOR);
  return anchor == null
    ? null
    : {
        id,
        role,
        element,
        anchor,
        viewport: element.closest<HTMLElement>(VIEWPORT),
      };
};

interface ControllerState {
  active: Active | null;
  moved: boolean;
  scrolling: boolean;
}

/**
 * The hover/focus/tap state machine behind the affordance, created once
 * per transcript. It mirrors `active` itself (set synchronously when it
 * shows or hides) so handlers never read a stale render.
 */
const createController = (
  set: (next: (state: ControllerState) => ControllerState) => void
): Controller => {
  let popupRef: React.RefObject<HTMLElement | null> | null = null;
  const popup = () => popupRef?.current ?? null;
  const descriptors = new Map<string, Descriptor & { fail: () => void }>();
  let active: Active | null = null;
  let enterTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerInside = false;
  let focusInside = false;
  let pinned = false;

  const clearEnter = () => {
    if (enterTimer != null) clearTimeout(enterTimer);
    enterTimer = null;
  };
  const clearLeave = () => {
    if (leaveTimer != null) clearTimeout(leaveTimer);
    leaveTimer = null;
  };
  const expanded = (): boolean =>
    popup()?.querySelector(EXPANDED) != null ||
    active?.element.querySelector(EXPANDED) != null;
  const hide = () => {
    clearEnter();
    clearLeave();
    pinned = false;
    active = null;
    set(() => ({ active: null, moved: false, scrolling: false }));
  };
  const show = (target: Target) => {
    const descriptor = descriptors.get(target.id);
    if (descriptor == null) return;
    const moved = active != null && active.id !== target.id;
    active = { ...target, message: descriptor.message, text: descriptor.text };
    const next = active;
    set((state) => ({
      active: next,
      moved: state.moved || moved,
      scrolling: false,
    }));
  };
  const settle = () => {
    if (!focusInside && !pinned && !expanded()) hide();
  };

  return {
    describe: (id, descriptor, fail) => {
      descriptors.set(id, { ...descriptor, fail });
      if (
        active == null ||
        active.id !== id ||
        (active.message === descriptor.message &&
          active.text === descriptor.text)
      )
        return;
      active = { ...active, ...descriptor };
      const next = active;
      set((state) => ({ ...state, active: next }));
    },
    forget: (id) => {
      descriptors.delete(id);
      if (active?.id === id) hide();
    },
    fail: (id) => descriptors.get(id)?.fail(),
    enter: (target) => {
      pointerInside = true;
      clearLeave();
      if (active != null) {
        // Already shown: switch at once, unless a popup holds it here.
        if (active.id !== target.id && !expanded()) show(target);
        return;
      }
      clearEnter();
      enterTimer = setTimeout(() => {
        enterTimer = null;
        show(target);
      }, HOVER_INTENT_MS);
    },
    leave: () => {
      pointerInside = false;
      clearEnter();
      clearLeave();
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        settle();
      }, LEAVE_GRACE_MS);
    },
    focus: (target) => {
      focusInside = true;
      clearEnter();
      clearLeave();
      if (active?.id !== target.id && !expanded()) show(target);
    },
    blur: () => {
      focusInside = false;
      if (!pointerInside) settle();
    },
    toggle: (target) => {
      if (active?.id === target.id && pinned) {
        hide();
        return;
      }
      pinned = true;
      clearEnter();
      clearLeave();
      show(target);
    },
    dismiss: hide,
    settle: () =>
      set((state) =>
        state.scrolling ? { ...state, scrolling: false } : state
      ),
    contains: (node) =>
      node instanceof Node && popup()?.contains(node) === true,
    focusFirst: () => {
      const first = popup()?.querySelector<HTMLElement>(TABBABLE);
      first?.focus();
      return first != null;
    },
    onKeyDown: (event) => {
      if (event.key !== "Tab" || active == null) return;
      const buttons = [
        ...(popup()?.querySelectorAll<HTMLElement>(TABBABLE) ?? []),
      ];
      if (event.shiftKey && event.target === buttons[0]) {
        event.preventDefault();
        active.element.focus();
      } else if (!event.shiftKey && event.target === buttons.at(-1)) {
        // On to the message's menu chevron, else whatever follows the message.
        const next =
          active.element.querySelector<HTMLElement>(
            '[data-slot="message-menu"]:not([disabled])'
          ) ?? tabbableAfter(active.element);
        if (next != null) {
          event.preventDefault();
          next.focus();
        }
      }
    },
    onOpenChange: (open, details) => {
      if (open || active == null) return;
      if (details.reason === "escape-key") {
        // A popup open from the affordance takes the first Escape.
        if (!expanded()) hide();
      } else if (details.reason === "outside-press") {
        // Pressing the message itself (selecting text) is not leaving it.
        const target = details.event.target;
        if (!(target instanceof Node && active.element.contains(target)))
          hide();
      }
    },
    pointerIn: () => {
      pointerInside = true;
      clearLeave();
    },
    focusIn: () => {
      focusInside = true;
      clearEnter();
      clearLeave();
    },
    expanded,
    attach: (ref) => {
      popupRef = ref;
    },
  };
};

/**
 * One affordance per transcript (`ChatLayout` mounts it over the rows):
 * the controller every message host talks to, and the positioned smiley.
 */
export const MessageActionBar = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<ControllerState>({
    active: null,
    moved: false,
    scrolling: false,
  });
  const [controller] = useState(() => createController(setState));
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => controller.attach(popupRef), [controller]);
  const { active, moved, scrolling } = state;
  const { skin } = useChatView();

  // Hidden while the transcript scrolls, until the pointer moves again; a
  // popup open from it stays (it closes on scroll by itself if it must).
  const viewport = active?.viewport ?? null;
  useEffect(() => {
    if (viewport == null) return;
    const onScroll = () => {
      if (!controller.expanded())
        setState((current) =>
          current.scrolling ? current : { ...current, scrolling: true }
        );
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [viewport, controller]);

  if (skin === "session") return <>{children}</>;
  return (
    <ControllerContext value={controller}>
      <Popover
        open={active != null}
        triggerId={active == null ? null : anchorId(active.id)}
        onOpenChange={controller.onOpenChange}
        modal={false}
      >
        <ActiveContext value={active?.id ?? null}>{children}</ActiveContext>
        <PopoverContent
          ref={popupRef}
          onMouseDown={(event) => event.preventDefault()}
          data-slot="message-actions-popup"
          data-moving={moved ? "" : undefined}
          data-scrolling={scrolling ? "" : undefined}
          side={active?.role === "user" ? "inline-start" : "inline-end"}
          align="center"
          sideOffset={AFFORDANCE_GAP_PX}
          initialFocus={false}
          finalFocus={false}
          className="w-fit animate-none! rounded-full bg-transparent p-0 shadow-none ring-0"
          onMouseEnter={controller.pointerIn}
          onMouseLeave={controller.leave}
          onFocusCapture={controller.focusIn}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (
              controller.contains(next) ||
              (next instanceof Node && active?.element.contains(next))
            )
              return;
            controller.blur();
          }}
          onKeyDown={controller.onKeyDown}
        >
          {active != null ? (
            <ReactionAffordance key={active.id} active={active} />
          ) : null}
        </PopoverContent>
      </Popover>
    </ControllerContext>
  );
};

/**
 * The smiley beside the bubble and the tray it opens: six quick reactions
 * and "+" for the whole grid, anchored above the bubble on the smiley's
 * side (below when above would cover the previous row or leave the
 * viewport; beside the smiley when below is blocked too). Hovering a quick reaction lifts it and eases its neighbours aside
 * (chat.css); the chosen ones keep a ring, not a fill.
 */
const ReactionAffordance = ({ active }: { active: Active }) => {
  const { t } = useTranslation();
  const controller = use(ControllerContext);
  const { session, composer } = useChatView();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<TraySide>("top");
  const [grid, setGrid] = useState(false);
  const [pending, setPending] = useState(false);
  const [lifted, setLifted] = useState<Emoji | null>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const reactions: Emoji[] = active.message.metadata?.abacus?.reactions ?? [];
  const readOnly = composer.readOnly != null;
  const quick = MESSAGE_REACTION_EMOJIS.slice(0, QUICK_REACTIONS);

  // The tray anchors to the smiley (the popover's trigger) and sits above
  // the bubble's top edge: the smiley is centred on the bubble, so the
  // offset is half the bubble less half the smiley, plus the gap.
  const [bubbleHeight, setBubbleHeight] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      setBubbleHeight(active.anchor.getBoundingClientRect().height);
      setSide(
        measureTraySide(
          active.element,
          active.anchor,
          trayRef.current,
          active.role
        )
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, active]);

  const react = (emoji: Emoji) => {
    setPending(true);
    void session
      .react(active.message.id, emoji, !reactions.includes(emoji))
      .catch(() => controller?.fail(active.id))
      .finally(() => setPending(false));
  };
  const lift = (emoji: Emoji): "up" | "left" | "right" | undefined => {
    if (lifted == null) return undefined;
    if (emoji === lifted) return "up";
    const at = quick.indexOf(emoji);
    const of = quick.indexOf(lifted);
    if (at === of - 1) return "left";
    if (at === of + 1) return "right";
    return undefined;
  };
  const reactionButton = (emoji: Emoji, cell = false) => (
    <Button
      key={emoji}
      variant="ghost"
      size={cell ? "icon" : "icon-lg"}
      data-slot={cell ? "reaction-cell" : "quick-reaction"}
      data-lift={cell ? undefined : lift(emoji)}
      className={cn(
        "aria-pressed:border-foreground/30 rounded-full hover:bg-transparent dark:hover:bg-transparent",
        cell ? "text-base" : "text-lg"
      )}
      aria-label={t("chat.actions.react", { emoji })}
      aria-pressed={reactions.includes(emoji)}
      disabled={readOnly || pending}
      onClick={() => react(emoji)}
      onPointerEnter={
        cell
          ? undefined
          : (event) => {
              if (event.pointerType === "mouse") setLifted(emoji);
            }
      }
      onPointerLeave={
        cell
          ? undefined
          : () => setLifted((current) => (current === emoji ? null : current))
      }
    >
      <span aria-hidden>{emoji}</span>
    </Button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setGrid(false);
      }}
      modal={false}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  data-slot="react-affordance"
                  className="text-muted-foreground hover:text-foreground rounded-full hover:bg-transparent dark:hover:bg-transparent"
                  aria-label={t("chat.actions.addReaction")}
                  disabled={readOnly}
                />
              }
            />
          }
        >
          <Smile aria-hidden className="size-5" strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent>{t("chat.actions.addReaction")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={trayRef}
        data-slot="reaction-tray"
        data-prefer={side}
        data-grid={grid ? "" : undefined}
        side={
          side === "side"
            ? active.role === "user"
              ? "inline-start"
              : "inline-end"
            : side
        }
        align={
          side === "side" ? "center" : active.role === "user" ? "start" : "end"
        }
        sideOffset={({ anchor }) =>
          side === "side"
            ? AFFORDANCE_GAP_PX
            : Math.max(0, bubbleHeight / 2 - anchor.height / 2) + TRAY_GAP_PX
        }
        finalFocus={false}
        className={cn(
          "w-fit animate-none! bg-transparent p-0 shadow-none ring-0",
          grid ? "rounded-xl" : "rounded-full"
        )}
      >
        <div
          data-slot="message-actions"
          role="toolbar"
          aria-label={t("chat.actions.label")}
          className={cn(
            "bg-popover/70 text-popover-foreground ring-foreground/10 relative isolate max-w-[calc(100vw-16px)] p-1 shadow-md ring-1 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-xl before:backdrop-saturate-[1.3]",
            grid
              ? "grid w-fit grid-cols-8 gap-0.5 rounded-xl"
              : "flex items-center gap-0.5 rounded-full"
          )}
        >
          {grid
            ? MESSAGE_REACTION_EMOJIS.map((emoji) =>
                reactionButton(emoji, true)
              )
            : quick.map((emoji) => reactionButton(emoji))}
          {grid ? null : (
            <Button
              variant="ghost"
              size="icon-lg"
              data-slot="more-reactions"
              className="text-muted-foreground hover:text-foreground rounded-full"
              aria-label={t("chat.actions.moreReactions")}
              aria-expanded={grid}
              onClick={() => setGrid(true)}
            >
              <Plus aria-hidden className="size-4" />
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

/**
 * The bubble's corner: the hidden anchor the affordance positions against
 * (a popover trigger covering the bubble, never pointed at or tabbed to)
 * and the chevron inside the top corner for the message menu (Reply, Copy,
 * the bot's feedback when it offers one). Rendered by the bubble itself so
 * both sit exactly on it; the chevron shows while its message holds the
 * affordance.
 */
export const MessageMenu = ({
  message,
  text = messageMarkdown(message),
  feedback,
  className,
}: {
  message: UIMessage;
  text?: string;
  feedback?: ReactNode;
  className?: string;
}) => {
  const { t } = useTranslation();
  const controller = use(ControllerContext);
  const activeId = use(ActiveContext);
  const { threadId, composer } = useChatView();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const afterClose = useRef<(() => void) | null>(null);
  const role: Role = message.role === "user" ? "user" : "assistant";
  const shown = activeId === message.id || open;
  const readOnly = composer.readOnly != null;
  const reply = () => {
    // The draft takes the reply now; the composer takes focus once the
    // menu has closed (it would otherwise hand focus back to the chevron).
    updateDraft(threadId, (draft) => ({
      ...draft,
      replyTo: replyTarget(message.id, role, text),
    }));
    afterClose.current = () => focusComposer(threadId);
  };
  return (
    <>
      {controller != null ? (
        <PopoverTrigger
          id={anchorId(message.id)}
          data-slot="message-anchor"
          aria-label={t("chat.actions.label")}
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
        />
      ) : null}
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(next) => {
          if (next) return;
          const run = afterClose.current;
          afterClose.current = null;
          run?.();
        }}
      >
        <DropdownMenuTrigger
          onMouseDown={(event) => event.preventDefault()}
          data-slot="message-menu"
          data-shown={shown ? "" : undefined}
          aria-label={t("chat.actions.menu")}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2",
            className
          )}
        >
          <ChevronDown aria-hidden className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-fit min-w-40"
          finalFocus={false}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={readOnly} onClick={reply}>
              <Reply aria-hidden />
              {t("chat.actions.reply")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setFailed(false);
                void navigator.clipboard
                  .writeText(text)
                  .catch(() => setFailed(true));
              }}
            >
              <Copy aria-hidden />
              {t("chat.actions.copy")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {feedback != null ? (
            <>
              <DropdownMenuSeparator />
              <div data-slot="message-menu-feedback" className="px-1 py-0.5">
                {feedback}
              </div>
            </>
          ) : null}
          {failed ? (
            <p role="alert" className="text-destructive px-2 py-1 text-xs">
              {t("chat.actions.failed")}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

const replyTarget = (
  messageId: string,
  role: Role,
  text: string
): ReplyTarget => ({ messageId, role, excerpt: text.slice(0, 80) });

const focusComposer = (threadId: string) =>
  document
    .querySelector<HTMLTextAreaElement>(
      `[data-continuity-id="composer:${CSS.escape(threadId)}"]`
    )
    ?.focus();

const replyTo = (
  threadId: string,
  messageId: string,
  role: Role,
  text: string
) => {
  const replyTo = replyTarget(messageId, role, text);
  updateDraft(threadId, (draft) => ({ ...draft, replyTo }));
  focusComposer(threadId);
};

const MotionBubbleReactions = motion.create(BubbleReactions);

/**
 * A message's host: hovering, focusing or (on a phone) tapping it hands
 * the message to the transcript's affordance; Escape dismisses it; Tab from
 * the host reaches the smiley and the menu. Hosts without a bubble (the
 * session skin's assistant prose) carry the menu chevron themselves.
 */
const SessionActions = ({
  message,
  text,
  feedback,
  children,
}: {
  message: UIMessage;
  text: string;
  feedback?: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const { composer } = useChatView();
  const [failed, setFailed] = useState(false);
  return (
    <div
      data-slot="message-actions-host"
      data-message-target={message.id}
      className="group/message relative max-w-full min-w-0"
    >
      {children}
      {text.trim() !== "" ? (
        <div
          onMouseDown={(event) => event.preventDefault()}
          data-slot="session-message-actions"
          className="pointer-events-none absolute start-0 top-full z-10 flex h-7 items-center gap-0.5 rounded-md bg-[var(--chat-surface)] opacity-0 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("chat.actions.copy")}
            onClick={() =>
              void navigator.clipboard
                .writeText(text)
                .catch(() => setFailed(true))
            }
          >
            <Copy aria-hidden />
          </Button>
          {message.role === "assistant" &&
          !composer.readOnly &&
          !composer.turnBusy
            ? feedback
            : null}
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          {t("chat.actions.failed")}
        </p>
      ) : null}
    </div>
  );
};
export const MessageActions = (props: {
  message: UIMessage;
  text?: string;
  feedback?: ReactNode;
  children: ReactNode;
}) => {
  const { skin } = useChatView();
  const text = props.text ?? messageMarkdown(props.message);
  if (props.message.role === "assistant" && text.trim() === "")
    return <>{props.children}</>;
  return skin === "session" ? (
    <SessionActions
      {...props}
      text={props.text ?? messageMarkdown(props.message)}
    />
  ) : (
    <ChatMessageActions {...props} />
  );
};
const ChatMessageActions = ({
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
  const { threadId, composer } = useChatView();
  const controller = use(ControllerContext);
  const active = use(ActiveContext) === message.id;
  const role: Role = message.role === "user" ? "user" : "assistant";
  const [error, setError] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const readOnly = composer.readOnly != null;
  const fail = () => setError(true);

  useLayoutEffect(() => {
    controller?.describe(message.id, { message, text }, fail);
  });
  useEffect(
    () => () => controller?.forget(message.id),
    [controller, message.id]
  );

  const target = (): Target | null =>
    hostRef.current == null
      ? null
      : targetOf(message.id, role, hostRef.current);
  const within = (node: EventTarget | null): boolean =>
    node instanceof Node &&
    (hostRef.current?.contains(node) === true ||
      controller?.contains(node) === true);
  const onKeyDown = (event: React.KeyboardEvent) => {
    // The menu's popup is a React child but lives in the body: its own
    // Escape closes it (Base UI), the next one here dismisses.
    if (
      !(event.target instanceof Node) ||
      !hostRef.current?.contains(event.target)
    )
      return;
    if (event.key === "Escape") {
      event.stopPropagation();
      controller?.dismiss();
    } else if (
      event.key === "Tab" &&
      !event.shiftKey &&
      event.target === hostRef.current &&
      active &&
      controller?.focusFirst()
    )
      event.preventDefault();
  };
  const bare = false;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        className={cn(
          "flex min-w-0 select-text",
          role === "user" && "justify-end"
        )}
      >
        <div
          ref={hostRef}
          data-slot="message-actions-host"
          data-message-target={message.id}
          data-active={active ? "" : undefined}
          tabIndex={0}
          className={cn(
            "focus-visible:ring-ring relative min-w-[min(100%,320px)] rounded-[20px] outline-none focus-visible:ring-2",
            role === "user" ? "w-fit max-w-full self-end" : "w-fit max-w-full"
          )}
          onMouseEnter={() => {
            const next = target();
            if (next != null) controller?.enter(next);
          }}
          onMouseLeave={() => controller?.leave()}
          onPointerMove={() => controller?.settle()}
          onFocusCapture={() => {
            const next = target();
            if (next != null) controller?.focus(next);
          }}
          onBlurCapture={(event) => {
            if (!within(event.relatedTarget)) controller?.blur();
          }}
          onClick={(event) => {
            if (
              window.getSelection()?.isCollapsed !== false &&
              window.matchMedia("(max-width: 799px)").matches &&
              !(event.target as HTMLElement).closest("button,a,input,textarea")
            ) {
              const next = target();
              if (next != null) controller?.toggle(next);
            }
          }}
          onKeyDown={onKeyDown}
        >
          {children}
          {bare ? (
            <MessageMenu message={message} text={text} feedback={feedback} />
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
          <ContextMenuItem
            disabled={readOnly}
            onClick={() => replyTo(threadId, message.id, role, text)}
          >
            <Reply aria-hidden />
            {t("chat.actions.reply")}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(text).catch(fail);
            }}
          >
            <Copy aria-hidden />
            {t("chat.actions.copy")}
          </ContextMenuItem>
        </ContextMenuGroup>
        {/* The bot's feedback (Good / Bad response, the comment popover),
            the same controls and state as the hover menu's footer. */}
        {feedback != null ? (
          <>
            <ContextMenuSeparator />
            <div data-slot="message-menu-feedback" className="px-1 py-0.5">
              {feedback}
            </div>
          </>
        ) : null}
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
  const { session, composer, skin } = useChatView();
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
            onMouseDown={(event) => event.preventDefault()}
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
  if (skin === "session" || (!reactions.length && !failed)) return null;
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
