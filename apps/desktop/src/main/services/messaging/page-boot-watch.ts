import { net, type WebContents } from "electron";

/**
 * When a hidden chat-app page (Discord, Telegram Web) shows neither its app
 * nor its login form, whether to keep waiting, reload it, or stop and wait for
 * the user. Shared so every web connector recovers a page the same way.
 *
 * Only time the page spends idle counts: a page still fetching, or a machine
 * offline, is not stuck. On a slow link the app's bundle can take longer than
 * any fixed window, and a reload on a timer threw away a boot that was getting
 * there, every time. Each reload doubles the wait before the next, and after
 * the last the verdict is "give_up" until reset, so a page that can never load
 * is not reloaded on a timer for as long as the app runs. A load still running
 * after BOOT_BUSY_CAP_MS is wedged rather than slow, and counts as idle;
 * time offline never does.
 */
export type BootVerdict = "wait" | "reload" | "give_up";
/**
 * Why a page may still come up by itself: still loading, no network, or
 * starting up in a way its connector cannot see from outside (WhatsApp's
 * chat sync), which only a load that never settles overrides.
 */
export type PageBusy = "loading" | "offline" | "starting" | null;

/** Idle time on a page that has not booted before its first reload. */
export const BOOT_FIRST_WAIT_MS = 30_000;
/** Reloads before the lane stops and waits for the user. */
export const BOOT_MAX_RELOADS = 3;
/**
 * How long one load may keep the page busy before it stops counting as
 * fetching: loads that never settled left a lane on "connecting" for hours.
 */
export const BOOT_BUSY_CAP_MS = 5 * 60_000;
/** How long a lane's start waits on its first load before checking the page. */
export const FIRST_LOAD_WAIT_MS = 45_000;

export class PageBootWatch {
  private idleMs = 0;
  private lastAt: number | null = null;
  private reloads = 0;
  private loadingSince: number | null = null;

  constructor(
    private readonly firstWaitMs = BOOT_FIRST_WAIT_MS,
    private readonly maxReloads = BOOT_MAX_RELOADS
  ) {}

  /** The page booted (its app or its login form), or the user opened it. */
  reset(): void {
    this.idleMs = 0;
    this.lastAt = null;
    this.reloads = 0;
    this.loadingSince = null;
  }

  /** Reloads since the last reset. */
  get reloadCount(): number {
    return this.reloads;
  }

  /**
   * One poll that found the page neither signed in nor at its login. `busy`:
   * it is still loading, or there is no network for it to load over.
   */
  stuck(now: number, busy: PageBusy): BootVerdict {
    const since = this.lastAt;
    this.lastAt = now;
    this.loadingSince = busy === "loading" ? (this.loadingSince ?? now) : null;
    const wedged =
      this.loadingSince != null && now - this.loadingSince >= BOOT_BUSY_CAP_MS;
    if ((busy != null && !wedged) || since == null) return "wait";
    this.idleMs += now - since;
    if (this.idleMs < this.firstWaitMs * 2 ** this.reloads) return "wait";
    if (this.reloads >= this.maxReloads) return "give_up";
    this.reloads += 1;
    this.idleMs = 0;
    this.lastAt = null;
    this.loadingSince = null;
    return "reload";
  }
}

/** See PageBootWatch.stuck: whether the page may still come up by itself. */
export const pageBusy = (contents: WebContents): PageBusy =>
  !net.isOnline() ? "offline" : contents.isLoading() ? "loading" : null;
