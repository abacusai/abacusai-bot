import os from "node:os";

import { freeBytes } from "@abacus-ai/agent/atomic-file";
import { app, net, powerMonitor, type WebContents } from "electron";

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
/** Reloads before the lane parks; the gateway's LaneSupervisor retries it from there. */
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

/**
 * Free space a parked lane waits for before it loads its page again. A cold
 * WhatsApp Web boot alone writes about 30 MB (its service worker and cache);
 * a linked page then syncs its chats on top. Chromium's storage commits
 * down to a megabyte or so, so this is the page's room, not a quota reserve.
 */
const DISK_SPACE_BACK_BYTES = 256 * 1024 * 1024;

/** The disk holding the app's pages has room for one to load again. */
export const diskSpaceBack = (): boolean =>
  (freeBytes(app.getPath("userData")) ?? 0) >= DISK_SPACE_BACK_BYTES;

/** How often the network is looked at for a change while a lane is down. */
const NETWORK_CHECK_MS = 5_000;

/** Adapters that come and go on their own (containers, VMs, VPN tunnels, Apple's peer links). */
const VIRTUAL_ADAPTER =
  /^(lo\d*$|docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|utun|awdl|llw|anpi|ap\d|bridge|tun|tap|zt|tailscale|wg)/i;
/** Windows names adapters by their product, anywhere in the friendly name. */
const VIRTUAL_ADAPTER_NAMED =
  /vmware|virtualbox|zerotier|openvpn|bluetooth|local area connection\*/i;

/**
 * The machine's real IPv4 addresses: a router or adapter change moves them
 * while "online" stays true. IPv6 is left out (privacy addresses rotate on
 * their own), as are link-local and virtual adapters, so churn there never
 * reads as a network change.
 */
const networkFingerprint = (): string =>
  Object.entries(os.networkInterfaces())
    .filter(
      ([name]) =>
        !VIRTUAL_ADAPTER.test(name) && !VIRTUAL_ADAPTER_NAMED.test(name)
    )
    .flatMap(([, entries]) => entries ?? [])
    .filter(
      (entry) =>
        !entry.internal &&
        entry.family === "IPv4" &&
        !entry.address.startsWith("169.254.")
    )
    .map((entry) => entry.address)
    .sort()
    .join(",");

/**
 * When a lane that is down is worth trying sooner: the network changed (the
 * OS online flag or the machine's addresses), the computer woke or unlocked,
 * or an app window took focus. Returns the stop.
 */
export const watchLaneHints = (
  hint: (reason: string) => void
): (() => void) => {
  let online = net.isOnline();
  let addresses = networkFingerprint();
  const poll = setInterval(() => {
    const nowOnline = net.isOnline();
    const nowAddresses = networkFingerprint();
    if (nowOnline === online && nowAddresses === addresses) return;
    online = nowOnline;
    addresses = nowAddresses;
    hint("the network changed");
  }, NETWORK_CHECK_MS);
  poll.unref?.();
  const onWake = (): void => hint("the computer woke up");
  const onFocus = (): void => hint("the app came to the front");
  powerMonitor.on("resume", onWake);
  powerMonitor.on("unlock-screen", onWake);
  app.on("browser-window-focus", onFocus);
  return () => {
    clearInterval(poll);
    powerMonitor.removeListener("resume", onWake);
    powerMonitor.removeListener("unlock-screen", onWake);
    app.removeListener("browser-window-focus", onFocus);
  };
};

/** Someone used the computer in the last five minutes. */
export const userActive = (): boolean =>
  powerMonitor.getSystemIdleState(300) === "active";
