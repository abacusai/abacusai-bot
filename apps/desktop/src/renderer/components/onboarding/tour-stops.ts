import type { useNavigate } from "@tanstack/react-router";
import {
  Bot,
  MessageSquare,
  Plug,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { SpotlightStep } from "react-tourlight";

import { useWorkspaceStore } from "../../stores/code-store";

/** The tour, as one table: what each stop points at and how its card reads. */

export const TOUR_ID = "workspace-onboarding";

type Navigate = ReturnType<typeof useNavigate>;

export interface TourStop {
  /** Names the copy: `tour.steps.<key>.title` and `.body`. */
  key: string;
  icon: LucideIcon;
  target: string;
  placement: SpotlightStep["placement"];
  /** The route to be on. Absent when `prepare` navigates itself. */
  route?: string;
  /** Put the target on screen; runs before Tourlight measures it. */
  prepare?: (navigate: Navigate) => Promise<void>;
  optional?: boolean;
  subtitleKey?: string;
  /** Rows instead of a paragraph, when a stop covers two things. */
  bullets?: { icon: LucideIcon; bodyKey: string }[];
}

const BOT_MAKER_TARGET = '[data-id="bots-home-name-input"]';

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Wait until a selector has a box, not merely a node. Tourlight measures a
 * target the moment it is inserted, and a node in a pane still mounting
 * measures 0x0 at the origin, so the spotlight lands on the window's corner.
 */
export const waitForBox = async (
  selector: string,
  timeoutMs = 2_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const box = document
      .querySelector<HTMLElement>(selector)
      ?.getBoundingClientRect();
    if (box != null && box.width > 0 && box.height > 0) {
      // One more frame: the pane is still settling around it.
      await nextFrame();
      return;
    }
    await nextFrame();
  }
};

/**
 * Open the bot maker. The pane the stop would otherwise inherit can be a
 * read-only channel chat with no name field, and a stop with no target dims
 * the whole window over nothing. No `route` on this stop: the provider would
 * navigate again between this wait and its measurement, remounting the pane.
 */
const showBotMaker = async (navigate: Navigate): Promise<void> => {
  const store = useWorkspaceStore.getState();
  store.setNewPaneIntent("bot");
  if (store.activeWorkspaceId != null)
    store.setActiveSessionId(store.activeWorkspaceId, null);
  await navigate({ to: "/bots/new" });
  await waitForBox(BOT_MAKER_TARGET);
};

export const TOUR_STOPS: readonly TourStop[] = [
  {
    key: "bots",
    icon: Bot,
    // The bots tree, which is the whole sidebar.
    target: '[data-id="sidebar-lists"]',
    placement: "right",
    route: "/",
    bullets: [
      { icon: Bot, bodyKey: "tour.steps.bots.bulletBots" },
      { icon: MessageSquare, bodyKey: "tour.steps.bots.bulletSessions" },
    ],
  },
  {
    key: "makeBot",
    icon: MessageSquare,
    target: BOT_MAKER_TARGET,
    placement: "top",
    prepare: showBotMaker,
  },
  {
    key: "connectors",
    icon: Plug,
    target: '[data-id="sidebar-nav-connectors"]',
    placement: "right",
    route: "/",
  },
  {
    key: "terminal",
    icon: SquareTerminal,
    // On the bots pane, scoped to the bot's folder. Tourlight skips a stop
    // whose target is missing and still counts it.
    target: '[data-id="local-code-bottom-panel-toggle"]',
    placement: "bottom",
    route: "/",
    optional: true,
    subtitleKey: "tour.steps.terminal.audience",
  },
];
