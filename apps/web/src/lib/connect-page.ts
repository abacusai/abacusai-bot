/**
 * One connect of one connector, from a click to connected. The target
 * (`connectTarget`) says what opens; the attempt takes its tab before any
 * await, signs the host in first when a platform connect finds it signed out,
 * has the host mint the link and opens it, then waits for the host to report
 * the connector connected.
 * The host follows every connect it is told of and announces the change
 * (`connectors.events` status-changed, or connect-failed); the attempt
 * re-reads on each, on window focus, and once at once. One deadline;
 * `cancel` releases it here and on the host.
 */
import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";
import type { TFunction } from "i18next";

import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import {
  blankTab,
  openTab,
  type ConnectTarget,
} from "#renderer/lib/connect-target";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { connectTarget } from "#renderer/lib/platform-system";

export const CONNECT_WAIT_MS = 180_000;

/** Outcome errors the app translates rather than shows. */
const CONNECT_ERRORS: Readonly<Record<string, string>> = {
  "popup-blocked": "phase5.popupBlocked",
  timeout: "phase5.connectTimedOut",
  failed: "phase5.connectFailed",
  // A browser has no chat-app pairing; the desktop keeps its own wording.
  ...(IS_ELECTRON ? {} : { "needs-pairing": "phase5.connectChatAppOnDesktop" }),
};

/** An attempt's error for the page: the app's words for its own codes. */
export const connectErrorText = (t: TFunction, error: string): string => {
  const key = CONNECT_ERRORS[error];
  return key != null ? t(key) : error;
};

export interface ConnectAttemptOptions {
  /** Signs the host in, when a platform connect finds it signed out. */
  signIn?: () => Promise<ConnectorOutcome>;
  /** The attempt moved between signing the host in and waiting. */
  onPhase?: (phase: "signing-in" | "waiting") => void;
  timeoutMs?: number;
}

const CANCELLED: ConnectorOutcome = {
  ok: false,
  cancelled: true,
  error: "cancelled",
};

export class ConnectAttempt {
  readonly target: ConnectTarget;
  readonly result: Promise<ConnectorOutcome>;
  private readonly abort = new AbortController();
  /** The tab a browser connect link opens in, until the link fills it. */
  private tab: Window | null = null;
  private opened = false;

  /** Call inside the click: a tab opens before this returns. */
  constructor(
    private readonly transport: Transport,
    private readonly connectorId: string,
    private readonly options: ConnectAttemptOptions = {}
  ) {
    this.target = connectTarget(connectorId);
    let blocked = false;
    if (this.target.kind === "host-route") blocked = !openTab(this.target.url);
    else if (
      this.target.kind === "connect-link" &&
      this.target.opens === "tab"
    ) {
      this.tab = blankTab();
      blocked = this.tab == null;
    }
    const stopped = new Promise<ConnectorOutcome>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        options.timeoutMs ?? CONNECT_WAIT_MS
      );
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(CANCELLED);
        },
        { once: true }
      );
    });
    const run = blocked
      ? Promise.resolve<ConnectorOutcome>({
          ok: false,
          error: "popup-blocked",
        })
      : this.run().catch((error: unknown): ConnectorOutcome => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    this.result = Promise.race([run, stopped]).finally(() => {
      this.abort.abort();
      // A tab the link never filled is left blank: close it.
      if (!this.opened) this.tab?.close();
    });
  }

  /** Stop waiting, and have the host drop the connect: its sign-in and its watch. */
  cancel(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    void this.transport.client.connectors
      .cancelConnect({ connectorId: this.connectorId })
      .catch(() => undefined);
  }

  private async run(): Promise<ConnectorOutcome> {
    const { connectorId, options, target } = this;
    const { client } = this.transport;
    const connect = () => client.connectors.connect({ connectorId });
    switch (target.kind) {
      case "fields":
      case "pairing":
        return { ok: false, error: `needs-${target.kind}` };
      case "in-app":
        return connect();
      case "host-route":
        // The route tells the host itself.
        break;
      case "connect-link": {
        const signedIn = await this.signedIn();
        if (!signedIn.ok) return signedIn;
        const told = await connect();
        if (!told.ok) return told;
        // The host's link as it answered it; nothing else carries the hand-off.
        if (!told.url) return { ok: false, error: "failed" };
        if (this.abort.signal.aborted) return CANCELLED;
        if (target.opens === "external")
          await client.system.openExternal({ url: told.url });
        else if (this.tab != null) this.tab.location.href = told.url;
        this.opened = true;
        break;
      }
    }
    options.onPhase?.("waiting");
    return this.connected();
  }

  /** The platform's page needs the host signed in: done first, explicitly. */
  private async signedIn(): Promise<ConnectorOutcome> {
    if (this.options.signIn == null) return { ok: true };
    const statuses = await this.transport.client.connectors.statuses({});
    if (statuses[this.connectorId]?.reason !== "not-signed-in")
      return { ok: true };
    this.options.onPhase?.("signing-in");
    return this.options.signIn();
  }

  /** Resolves once the host reads the connector connected; never on its own otherwise. */
  private connected(): Promise<ConnectorOutcome> {
    const { transport, connectorId } = this;
    const { signal } = this.abort;
    return new Promise((resolve) => {
      let checking = false;
      let again = false;
      const check = async (): Promise<void> => {
        if (checking) {
          again = true;
          return;
        }
        checking = true;
        try {
          do {
            again = false;
            const statuses = await transport.client.connectors.statuses({});
            if (statuses[connectorId]?.state === "connected")
              return resolve({ ok: true });
          } while (again && !signal.aborted);
        } catch {
          // A failed read is retried on the next change or focus.
        } finally {
          checking = false;
        }
      };
      window.addEventListener("focus", () => void check(), { signal });
      // The page's one connectors stream; a new socket may have missed one.
      followNotice(
        "connectors",
        transport,
        (event) => {
          if (event.type === "status-changed") void check();
          // The host's page said it did not finish: no waiting out the deadline.
          else if (
            event.type === "connect-failed" &&
            event.connectorId === connectorId
          )
            resolve({ ok: false, error: "failed" });
        },
        signal,
        { reopened: () => void check() }
      );
      void check();
    });
  }
}
