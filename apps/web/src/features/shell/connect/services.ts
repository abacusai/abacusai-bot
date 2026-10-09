import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
/**
 * Reaching the browser's host (spec 09 D4). One blocking call decides who
 * the user is (`getOrCreateAbacusBotHost`: sign-in and tier); readiness
 * (bootstrap, `/healthz`, the socket) runs behind `hostConnection`, which
 * the shell renders, while the app is already usable. `runHostConnection`
 * owns the page's sockets: it opens each generation of the host transport
 * and replaces a dropped socket with jittered backoff (0.5 s to 8 s).
 */
import { Store } from "@tanstack/react-store";
import * as v from "valibot";

import {
  awaitWebSocketOpen,
  UNRESPONSIVE,
  type HostTransport,
} from "#renderer/data/transport/websocket";

export type ConnectStage =
  | "starting"
  | "installing"
  /** The server is moving the host onto the version bootstrap named. */
  | "updating"
  | "connecting"
  | "open"
  | "reconnecting";
/**
 * Why the host is out of reach, by remedy: `signin`, `tier`, `limit` and
 * `refused` (the apps server turned this account away for good, a 4xx)
 * replace the app; `version` (the host is older) offers a restart of the
 * user's computer, `reload` (this page is older, or the host refused it for
 * good) a reload; `connection` is retried.
 */
export class ConnectError extends Error {
  constructor(
    readonly kind:
      | "signin"
      | "tier"
      | "limit"
      | "refused"
      | "version"
      | "reload"
      | "connection",
    message: string,
    readonly network = false,
    /** The apps server's HTTP status, when it answered. */
    readonly status?: number,
    /** The server's own reason, when it is short plain text fit for the page. */
    readonly detail?: string
  ) {
    super(message);
  }
}
const Host = v.object({ deploymentConversationId: v.string() });
/** Same-origin path the server proxies to the host (`/api/botHost/<id>`). */
const HostBase = v.nullish(v.pipe(v.string(), v.regex(/^\/(?!\/)/)));
// Legacy per-conversation preview hostname; null once `hostBase` ships.
const PreviewHost = v.nullish(v.string());
const Bootstrap = v.variant("status", [
  v.object({
    status: v.literal("starting"),
    token: v.nullable(v.pipe(v.string(), v.minLength(1))),
    version: v.nullable(v.string()),
    hostBase: HostBase,
    previewHost: PreviewHost,
    detail: v.nullable(v.string()),
  }),
  v.object({
    status: v.literal("ready"),
    hostBase: HostBase,
    previewHost: PreviewHost,
    token: v.pipe(v.string(), v.minLength(1)),
    version: v.nullable(v.string()),
    detail: v.nullable(v.string()),
  }),
]);
const Health = v.object({
  ok: v.boolean(),
  owner: v.string(),
  contractVersion: v.number(),
  version: v.nullish(v.string()),
  busy: v.nullish(v.boolean()),
});
/** HTTP prefix for `/healthz`, `/rpc`, `/files` and `/upload`. */
export const hostHttpBase = (boot: {
  hostBase?: string | null;
  previewHost?: string | null;
}): string => {
  if (boot.hostBase) return location.origin + boot.hostBase.replace(/\/+$/, "");
  // Fallback for servers that still answer only `previewHost`; remove with it.
  if (boot.previewHost) return `https://${boot.previewHost}`;
  throw new ConnectError("connection", "Invalid connection service response");
};
const parse = <T>(schema: v.GenericSchema<unknown, T>, value: unknown): T => {
  try {
    return v.parse(schema, value);
  } catch {
    throw new ConnectError("connection", "Invalid connection service response");
  }
};
/** One HTTP attempt answers within this, or counts as unanswered. */
const ATTEMPT_MS = 30_000;

/**
 * `request(signal)` (a fetch and its body), or `timedOut` once `ms` passed:
 * a request a proxy accepted and never completed must not hold readiness
 * past its deadline. The signal also aborts the fetch.
 */
const within = async <T>(
  ms: number,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T | typeof timedOut> => {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(
      () => {
        abort.abort();
        resolve(timedOut);
      },
      Math.max(0, ms)
    );
  });
  try {
    return await Promise.race([request(abort.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
};
const timedOut = Symbol("timed out");

/** 4xx answers that can pass: a timeout, a conflict, too early, too many. */
const TRANSIENT_4XX = new Set([408, 409, 425, 429]);

/** A server reason short and plain enough to show as it is. */
const shownReason = (message: unknown): string | undefined => {
  if (typeof message !== "string") return undefined;
  const reason = message.trim();
  return reason.length > 0 && reason.length <= 200 && !/[\r\n<>]/.test(reason)
    ? reason
    : undefined;
};

export const callApps = async (
  service: string,
  input: unknown,
  ms = ATTEMPT_MS
): Promise<unknown> => {
  const unavailable = () =>
    new ConnectError(
      "connection",
      "Connection service unavailable. Please retry.",
      true
    );
  let answer;
  try {
    answer = await within(ms, async (signal) => {
      const response = await fetch(`/api/_${service}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "REAI-UI": "1" },
        body: JSON.stringify(input),
        signal,
      });
      return { response, body: await response.json().catch(() => null) };
    });
  } catch {
    throw unavailable();
  }
  if (answer === timedOut) throw unavailable();
  const response = answer.response;
  const body = answer.body as {
    success?: boolean;
    result?: unknown;
    error?: string;
    errorType?: string;
  } | null;
  const message =
    typeof body?.error === "string"
      ? body.error
      : `Connection service failed (${response.status})`;
  if (body?.errorType === "AbacusBotHostTierRequired")
    throw new ConnectError("tier", message);
  // Today's web time is used up, or the free hosts are at capacity.
  if (body?.errorType === "AbacusBotHostLimitReached")
    throw new ConnectError("limit", message);
  if (
    response.status === 401 ||
    /not.?logged.?in/i.test(`${body?.errorType ?? ""} ${message}`)
  )
    throw new ConnectError("signin", message);
  // A definite refusal (wrong site for this account, no access): retrying
  // cannot change it, and it is not the host failing to wake.
  if (
    response.status >= 400 &&
    response.status < 500 &&
    !TRANSIENT_4XX.has(response.status)
  )
    throw new ConnectError(
      "refused",
      message,
      false,
      response.status,
      shownReason(body?.error)
    );
  if (!response.ok || body?.success !== true)
    throw new ConnectError("connection", message, false, response.status);
  return body.result;
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Poll `n` (0-based) of the apps server or `/healthz`: 0.5 s doubling to 3 s. */
export const pollDelayMs = (n: number): number => Math.min(500 * 2 ** n, 3000);
export interface BrowserConnection {
  url: string;
  /** HTTP prefix of the host routes (no trailing slash). */
  base: string;
  token: string;
  tokenIssuedAt: number;
  deploymentConversationId: string;
  local?: boolean;
}
let connection: BrowserConnection | undefined;
export const browserConnection = (): BrowserConnection => {
  if (!connection) throw new Error("Browser host is not connected");
  return connection;
};
/**
 * "Restart your computer", asked once: the first bootstrap call that the
 * apps server accepted consumes it, so neither a later poll nor a later
 * attempt of the connection loop restarts the host again.
 */
export interface RestartRequest {
  requested: boolean;
}

const bootstrap = async (
  deploymentConversationId: string,
  restart: RestartRequest = { requested: false }
) => {
  const deadline = Date.now() + 7 * 60_000;
  for (let polls = 0; ; polls += 1) {
    const forceRestart = restart.requested;
    const boot = parse(
      Bootstrap,
      await callApps(
        "bootstrapAbacusBotHost",
        {
          deploymentConversationId,
          ...(forceRestart ? { forceRestart: true } : {}),
        },
        Math.min(ATTEMPT_MS, deadline - Date.now())
      )
    );
    if (forceRestart) restart.requested = false;
    if (boot.status === "ready") return boot;
    if (Date.now() >= deadline)
      throw new ConnectError(
        "connection",
        boot.detail ?? "Computer start timed out"
      );
    await delay(pollDelayMs(polls));
  }
};
let refreshing: Promise<BrowserConnection> | undefined;
export const refreshUploadToken = (
  force = false,
  rejectedToken?: string
): Promise<BrowserConnection> => {
  const host = browserConnection();
  if (host.local || (rejectedToken != null && host.token !== rejectedToken))
    return Promise.resolve(host);
  if (!force && Date.now() - host.tokenIssuedAt < 8 * 60_000)
    return Promise.resolve(host);
  refreshing ??= bootstrap(host.deploymentConversationId)
    .then((boot) => {
      if (hostHttpBase(boot) !== host.base)
        throw new ConnectError(
          "connection",
          "Host identity changed; reconnect before uploading"
        );
      host.token = boot.token;
      host.tokenIssuedAt = Date.now();
      return host;
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
};
export interface HostIdentity {
  deploymentConversationId: string;
}

let identified: HostIdentity | undefined;

/** The user's host once `identifyHost()` answered; keys last-known state. */
export const hostIdentity = (): HostIdentity | undefined => identified;

/**
 * The blocking step: the user's host, or the sign-in or tier refusal that
 * replaces the app. A development host (`VITE_WEB_HOST_URL`) is ready at once.
 */
/** A development host (`VITE_WEB_HOST_URL`): no apps server behind the page. */
const devHostUrl = (): string | undefined =>
  import.meta.env.DEV ? import.meta.env.VITE_WEB_HOST_URL : undefined;

/**
 * Boot, before the identity step: the bot account behind this sign-in, set up
 * as the desktop's connect does (a fresh sign-up gets the bot's free tier), so
 * no gated call ever runs on an account the bot has not set up. Refusals are
 * the identity step's to explain (signed out, tier, an apps server without
 * this step): any answer below 500 leaves the boot to it. Only a setup that
 * could not run (network, server error) stops the boot.
 */
export const setUpBotAccount = async (): Promise<void> => {
  if (devHostUrl()) return;
  try {
    await callApps("setUpAbacusaibotWebAccount", {});
  } catch (error) {
    if (!(error instanceof ConnectError)) throw error;
    const refused =
      error.kind !== "connection" ||
      (error.status !== undefined && error.status < 500);
    if (!refused) throw error;
  }
};

export const identifyHost = async (): Promise<HostIdentity> => {
  const devHost = devHostUrl();
  if (devHost) {
    const url = new URL(devHost);
    if (!/^wss?:$/.test(url.protocol))
      throw new ConnectError(
        "connection",
        "VITE_WEB_HOST_URL must be a WebSocket URL"
      );
    const token =
      import.meta.env.VITE_WEB_HOST_TOKEN ?? url.searchParams.get("token");
    if (!token)
      throw new ConnectError(
        "connection",
        "Supply VITE_WEB_HOST_TOKEN for the local host"
      );
    connection = {
      url: url.href,
      base: url.origin.replace(/^ws/, "http"),
      token,
      tokenIssuedAt: Date.now(),
      deploymentConversationId: "local",
      local: true,
    };
    identified = { deploymentConversationId: "local" };
    return identified;
  }
  const host = parse(Host, await callApps("getOrCreateAbacusBotHost", {}));
  identified = { deploymentConversationId: host.deploymentConversationId };
  return identified;
};

let page: HostTransport | undefined;

/** The page's one host transport (spec 09 D2), from boot on. */
export const pageTransport = (): HostTransport => {
  if (!page) throw new Error("Browser host is not identified");
  return page;
};

export const setPageTransport = (transport: HostTransport): void => {
  page = transport;
};

const IDENTITY_MISMATCH = "Host identity mismatch";

/** How long an idle older host gets to come up on the bootstrap's version. */
const UPDATE_WAIT_MS = 90_000;

/**
 * Orders host versions (`x.y.z-web.N.M`): the release numbers, then the web
 * build's. Negative when `a` is older. Unparseable ones compare equal, so
 * nothing waits on a version it cannot read.
 */
export const compareHostVersions = (a: string, b: string): number => {
  const parse = (version: string): number[][] | null => {
    const parts = version.split("-web.");
    if (parts.length > 2) return null;
    const numbers = parts.map((part) => part.split(".").map(Number));
    return numbers.flat().every((n) => Number.isInteger(n) && n >= 0)
      ? numbers
      : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (left == null || right == null) return 0;
  for (const part of [0, 1]) {
    const x = left[part] ?? [];
    const y = right[part] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const order = (x[i] ?? 0) - (y[i] ?? 0);
      if (order !== 0) return order;
    }
  }
  return 0;
};

/** Readiness: the host started (bootstrap), healthy, and its token. */
export const readyHost = async (
  identity: HostIdentity,
  stage: (value: ConnectStage) => void,
  restart?: RestartRequest
): Promise<BrowserConnection> => {
  if (connection?.local) {
    stage("connecting");
    return connection;
  }
  const boot = await bootstrap(identity.deploymentConversationId, restart);
  const tokenIssuedAt = Date.now();
  stage("installing");
  const base = hostHttpBase(boot);
  let owner: string;
  try {
    const payload = JSON.parse(
      atob(boot.token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/"))
    ) as { o?: unknown };
    if (typeof payload.o !== "string") throw new Error();
    owner = payload.o;
  } catch {
    throw new ConnectError("connection", "Invalid host token");
  }
  let installDeadline = Date.now() + 5 * 60_000;
  let denialDeadline: number | undefined;
  let updateDeadline: number | undefined;
  for (let polls = 0; ; polls += 1) {
    let response: Response | undefined;
    let body: unknown = null;
    try {
      const answer = await within(
        Math.min(ATTEMPT_MS, installDeadline - Date.now()),
        async (signal) => {
          const reply = await fetch(`${base}/healthz`, {
            credentials: "include",
            signal,
          });
          return {
            reply,
            body: reply.ok ? await reply.json().catch(() => null) : null,
          };
        }
      );
      // Unanswered: polled again until the install deadline.
      if (answer !== timedOut) ({ reply: response, body } = answer);
    } catch {
      /* Proxy may still be starting. */
    }
    if (response?.ok) {
      const health = parse(Health, body);
      if (!health.ok || health.owner !== owner)
        throw new ConnectError("connection", IDENTITY_MISMATCH);
      // The older side updates: the host by a restart, this page by a reload.
      if (health.contractVersion < CONTRACT_VERSION)
        throw new ConnectError("version", "Restart your computer to update it");
      if (health.contractVersion > CONTRACT_VERSION)
        throw new ConnectError(
          "reload",
          "This page is out of date. Reload to update it."
        );
      // An idle older host is about to be restarted onto the new version;
      // a busy one is never upgraded mid-turn, and a newer one (a rollback)
      // never will be, so those are used as they are, and so is one that
      // outlasts the wait.
      if (
        boot.version == null ||
        health.version == null ||
        health.busy === true ||
        compareHostVersions(health.version, boot.version) >= 0
      )
        break;
      updateDeadline ??= Date.now() + UPDATE_WAIT_MS;
      if (Date.now() >= updateDeadline) break;
      // Its restart may take the host down for a while: give it the room.
      installDeadline = Math.max(installDeadline, updateDeadline);
      stage("updating");
      await delay(pollDelayMs(polls));
      continue;
    }
    if (response?.status === 403) denialDeadline ??= Date.now() + 65_000;
    else if (response && ![502, 503].includes(response.status))
      throw new ConnectError(
        "connection",
        `Host health failed (${response.status})`
      );
    if (
      Date.now() >= installDeadline ||
      (response?.status === 403 && Date.now() >= denialDeadline!)
    )
      throw new ConnectError(
        "connection",
        "Host did not become ready. Please retry."
      );
    await delay(pollDelayMs(polls));
  }
  stage("connecting");
  connection = {
    base,
    url: base.replace(/^http/, "ws") + "/rpc",
    token: boot.token,
    tokenIssuedAt,
    deploymentConversationId: identity.deploymentConversationId,
  };
  return connection;
};

/** Identity, then readiness, in one go. */
export const resolveBrowserHost = async (
  stage: (value: ConnectStage) => void,
  forceRestart = false
): Promise<BrowserConnection> => {
  stage("starting");
  return readyHost(await identifyHost(), stage, { requested: forceRestart });
};

export interface HostConnectionState {
  stage: ConnectStage;
  /** The last failure, shown with the stage until the next socket opens. */
  error: Error | null;
  /** The transport generation that is open, or the last one that was. */
  generation: number;
  /** An attempt is in flight (Retry has nothing to hurry). */
  attempting: boolean;
  /**
   * This browser has never reached this host, and no socket has opened yet:
   * the setup page, not the pill. Cleared for good by the first open.
   */
  firstVisit: boolean;
}

export const hostConnection = new Store<HostConnectionState>({
  stage: "starting",
  error: null,
  generation: 0,
  attempting: false,
  firstVisit: false,
});

/** Reconnect attempt `n` (0-based): 0.5 s doubling to 8 s, half of it jitter. */
export const reconnectDelayMs = (
  n: number,
  random: () => number = Math.random
): number => {
  const ceiling = Math.min(500 * 2 ** n, 8000);
  return ceiling / 2 + (random() * ceiling) / 2;
};

/** A socket that closes sooner than this after opening counts as a failure. */
const STABLE_MS = 5_000;

/** A token this old is re-minted (bootstrap) before the next socket. */
const TOKEN_REFRESH_MS = 8 * 60_000;

/**
 * Attempts in a row that failed or dropped at once before the loop slows to
 * one a minute (Retry, or the network coming back, still starts one now).
 */
const MAX_UNSTABLE = 6;
const SLOW_RETRY_MS = 60_000;

/** Identity mismatches in a row before they are final (a reload). */
const MAX_IDENTITY_MISMATCH = 3;

/**
 * Liveness: a probe after 30 s without a frame while visible (and on
 * `online`, `pageshow`, visible again); a probe with no answer and no other
 * frame in 10 s ends the socket.
 */
const PROBE_EVERY_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * What a socket's close code means (spec 09 D5):
 * - `refused` (1008, policy: a malformed frame or a missing token): this
 *   page is refused for good; a reload is the remedy.
 * - `stalled` (1013, the host cut off a consumer that stopped reading),
 *   `oversized` (1009, a frame larger than the limit) and `unresponsive`
 *   (4000, our liveness probe gave up): the next socket keeps the token
 *   but backs off as after a failure, so a slow host or link is not
 *   reconnected to at once, again and again; the chat streams decide what
 *   to replay (`pump.ts`).
 * - `dropped`, anything else (1006 above all: a network drop, or a token
 *   the proxy refused at the upgrade, which the browser cannot tell apart):
 *   a socket that lived reconnects with its token; one that dropped at
 *   once counts as a failure and the next attempt re-bootstraps.
 */
export const closePolicy = (
  code: number
): "refused" | "stalled" | "oversized" | "unresponsive" | "dropped" =>
  code === 1008
    ? "refused"
    : code === 1013
      ? "stalled"
      : code === 1009
        ? "oversized"
        : code === UNRESPONSIVE
          ? "unresponsive"
          : "dropped";

let wake: (() => void) | null = null;

/** The banner's Retry: the next attempt starts now instead of after its wait. */
export const retryHostNow = (): void => wake?.();

const RESTART_KEY = "abacusai-bot:restart-host";

/**
 * "Restart your computer": reload and force a restart on the next boot (the
 * request is local storage, consumed by that boot).
 */
export const restartHost = (): void => {
  try {
    localStorage.setItem(RESTART_KEY, "1");
  } catch {
    // Without storage the reload still reconnects, without the restart.
  }
  location.reload();
};

/** Whether this boot follows `restartHost()`; asks once. */
export const takeRestartRequest = (): boolean => {
  try {
    const requested = localStorage.getItem(RESTART_KEY) === "1";
    localStorage.removeItem(RESTART_KEY);
    return requested;
  } catch {
    return false;
  }
};

export interface HostConnectionOptions {
  forceRestart?: boolean;
  /** Whether this browser has never reached this host before. */
  firstVisit?: boolean;
  /** For tests; the global `WebSocket` otherwise. */
  WebSocket?: new (url: string, protocols: string[]) => WebSocket;
  random?: () => number;
  /** Liveness probe; `system.info` over the transport by default. */
  probe?: (signal: AbortSignal) => Promise<unknown>;
}

const visible = (): boolean => document.visibilityState !== "hidden";

const waitUntilVisible = (): Promise<void> =>
  new Promise((resolve) => {
    if (visible()) return resolve();
    const shown = (): void => {
      if (!visible()) return;
      document.removeEventListener("visibilitychange", shown);
      resolve();
    };
    document.addEventListener("visibilitychange", shown);
  });

/** `ms`, or until Retry or the network coming back. */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done);
    function done(): void {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      if (wake === done) wake = null;
      resolve();
    }
    wake = done;
  });

/**
 * Probes the socket that `generation` runs on: on `online`, when the tab
 * becomes visible, on `pageshow` and every 30 s while visible. A probe that
 * gets no answer in time means the link is gone even though the socket says
 * open (sleep, a network change, a proxy that dropped it without a FIN):
 * `drop()` ends the generation, and the loop replaces the socket.
 */
const watchLiveness = (
  transport: HostTransport,
  generation: number,
  probe: (signal: AbortSignal) => Promise<unknown>
): (() => void) => {
  let probing = false;
  const check = (quietOnly: boolean): void => {
    if (probing || !visible()) return;
    if (transport.state !== "open" || transport.generation !== generation)
      return;
    // Any frame is proof of life: the timer probes only a quiet socket.
    if (quietOnly && Date.now() - transport.heardAt() < PROBE_EVERY_MS) return;
    probing = true;
    const sentAt = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    void probe(abort.signal)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        probing = false;
        if (
          abort.signal.aborted &&
          transport.heardAt() < sentAt &&
          transport.state === "open" &&
          transport.generation === generation
        )
          transport.drop("unresponsive");
      });
  };
  const onVisibility = (): void => {
    if (visible()) check(false);
  };
  const onEvent = (): void => check(false);
  const interval = setInterval(() => check(true), PROBE_EVERY_MS);
  window.addEventListener("online", onEvent);
  window.addEventListener("pageshow", onEvent);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(interval);
    window.removeEventListener("online", onEvent);
    window.removeEventListener("pageshow", onEvent);
    document.removeEventListener("visibilitychange", onVisibility);
  };
};

/**
 * Opens every generation of `transport` until it closes for good. A
 * sign-in, tier, limit, account, contract or policy refusal closes it; any
 * other failure is shown and retried with backoff, and after `MAX_UNSTABLE`
 * in a row once a minute. A dropped socket first
 * reconnects with the current token; a failed attempt, or a token older
 * than eight minutes, starts over from bootstrap, and a hidden tab never
 * bootstraps (an idle pod is not restarted for nobody): it waits until it
 * is visible. Close codes follow `closePolicy`.
 */
export const runHostConnection = async (
  transport: HostTransport,
  identity: HostIdentity,
  options: HostConnectionOptions = {}
): Promise<void> => {
  const Socket = options.WebSocket ?? WebSocket;
  const probe =
    options.probe ??
    ((signal: AbortSignal) => transport.client.system.info({}, { signal }));
  const restart: RestartRequest = { requested: options.forceRestart ?? false };
  let failures = 0;
  let mismatches = 0;
  let fresh = false;
  const set = (patch: Partial<HostConnectionState>): void =>
    hostConnection.setState((state) => ({ ...state, ...patch }));
  set({ firstVisit: options.firstVisit ?? false });
  // A call: the state changes across every await below.
  const closed = (): boolean => transport.state === "closed";
  const terminal = (error: ConnectError): void => {
    set({ error, attempting: false });
    transport.fail();
  };
  /** After a failure: back off, slower once it keeps failing. */
  const backOff = async (): Promise<void> => {
    fresh = false;
    failures += 1;
    set({ attempting: false });
    await pause(
      failures >= MAX_UNSTABLE
        ? SLOW_RETRY_MS
        : reconnectDelayMs(failures, options.random)
    );
    await waitUntilVisible();
  };
  while (!closed()) {
    const reconnecting = transport.generation > 0;
    try {
      let host = connection;
      if (
        host == null ||
        !fresh ||
        Date.now() - host.tokenIssuedAt >= TOKEN_REFRESH_MS
      ) {
        await waitUntilVisible();
        if (closed()) return;
        set({ attempting: true });
        host = await readyHost(
          identity,
          (stage) => set({ stage: reconnecting ? "reconnecting" : stage }),
          restart
        );
        mismatches = 0;
      }
      if (closed()) return;
      set({ attempting: true });
      const socket = new Socket(host.url, [
        "abacus-rpc",
        `abacus-token.${host.token}`,
      ]);
      await awaitWebSocketOpen(socket);
      if (closed()) {
        socket.close();
        return;
      }
      const ended = transport.attach(socket);
      const generation = transport.generation;
      const openedAt = Date.now();
      set({
        stage: "open",
        error: null,
        generation,
        attempting: false,
        firstVisit: false,
      });
      const unwatch = watchLiveness(transport, generation, probe);
      const close = await ended;
      unwatch();
      if (closed()) return;
      set({ stage: "reconnecting" });
      const policy = closePolicy(close.code);
      if (policy === "refused") {
        terminal(
          new ConnectError(
            "reload",
            "The host refused this page's connection. Reload to reconnect."
          )
        );
        return;
      }
      if (policy === "dropped" && Date.now() - openedAt >= STABLE_MS) {
        failures = 0;
        fresh = true;
        await pause(reconnectDelayMs(0, options.random));
      } else {
        // Accepted, then dropped at once (a dead pod behind a live proxy),
        // cut off for a stalled or oversized stream, or unresponsive: a
        // failure, so the backoff grows. Only an unexplained drop
        // re-bootstraps.
        const keepToken = policy !== "dropped";
        await backOff();
        fresh = keepToken;
      }
    } catch (error) {
      if (error instanceof ConnectError && error.kind !== "connection") {
        terminal(error);
        return;
      }
      if (
        error instanceof ConnectError &&
        error.message === IDENTITY_MISMATCH &&
        ++mismatches >= MAX_IDENTITY_MISMATCH
      ) {
        terminal(
          new ConnectError(
            "reload",
            "The host answering is not yours. Reload to reconnect."
          )
        );
        return;
      }
      set({
        stage: reconnecting ? "reconnecting" : hostConnection.state.stage,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await backOff();
    }
  }
};
