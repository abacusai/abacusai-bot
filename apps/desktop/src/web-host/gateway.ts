/**
 * The hosted web app's front door. One process per machine:
 *
 *   GET  <base>/...            the web build (dist/web), index for any route
 *   WS   <base>/rpc            a browser tab -> that user's host process
 *   WS   <base>/runner         a signed-in desktop offering itself for coding
 *   WS   <base>/runner/data    one tunnel from that desktop, on request
 *   WS   <base>/runner-rpc     a browser tab -> the user's own desktop
 *
 * Who the caller is never comes from the request's own claims: a tab's
 * cookie, or a desktop's API key, goes to the platform's identity endpoint,
 * which answers with the user and the key their host may use. Each user gets
 * one host process (host.ts) with its own home directory, started on the
 * first tab and stopped once idle. Tabs only ever reach their own user's
 * host, and a desktop only ever serves its own user's tabs.
 *
 * Configuration (environment):
 *   ABACUSAI_BOT_WEB_DATA            root of the per-user homes (required)
 *   ABACUSAI_BOT_WEB_IDENTITY_URL    the platform's identity endpoint
 *   ABACUSAI_BOT_WEB_SERVICE_TOKEN   sent to it, proving the caller is us
 *   ABACUSAI_BOT_WEB_ORIGINS         origins allowed to open sockets
 *   ABACUSAI_BOT_WEB_BASE            path prefix, default /bot
 *   ABACUSAI_BOT_WEB_LISTEN          host:port, default 0.0.0.0:8080
 *   ABACUSAI_BOT_WEB_IDLE_MS         idle time before a host stops
 *   ABACUSAI_BOT_WEB_MAX_HOSTS       host processes per machine
 *   ABACUSAI_BOT_WEB_DEV_KEY         local development only: skip identity
 *                                    and run one user with this key; refused
 *                                    unless listening on loopback
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

interface Identity {
  /** Stable and opaque; only ever hashed into a directory name. */
  userId: string;
  email: string;
  name: string;
  /** The key the user's host and agents use. Never sent to a browser. */
  apiKey: string;
}

interface Runner {
  control: WebSocket;
  /** Tunnels asked for and not yet opened by the desktop. */
  pending: Map<string, (socket: WebSocket) => void>;
}

interface HostEntry {
  userKey: string;
  child: ChildProcess;
  socketPath: string;
  keyHash: string;
  ready: Promise<void>;
  /** Live browser sockets on this host, and their re-check credential. */
  tabs: Map<WebSocket, string>;
  lastActive: number;
}

const env = (name: string, fallback = ""): string =>
  (process.env[name] ?? fallback).trim();

const BASE = env("ABACUSAI_BOT_WEB_BASE", "/bot").replace(/\/+$/, "");
const [LISTEN_HOST = "0.0.0.0", LISTEN_PORT = "8080"] = env(
  "ABACUSAI_BOT_WEB_LISTEN",
  "0.0.0.0:8080"
).split(/:(?=\d+$)/);
const DATA = env("ABACUSAI_BOT_WEB_DATA");
const RUN = env("ABACUSAI_BOT_WEB_RUN", join(tmpdir(), "abacusai-bot-web"));
const STATIC = resolve(
  env("ABACUSAI_BOT_WEB_STATIC", join(import.meta.dirname, "..", "web"))
);
const IDENTITY_URL = env("ABACUSAI_BOT_WEB_IDENTITY_URL");
const SERVICE_TOKEN = env("ABACUSAI_BOT_WEB_SERVICE_TOKEN");
const IDLE_MS = Number(env("ABACUSAI_BOT_WEB_IDLE_MS", "900000"));
const MAX_HOSTS = Number(env("ABACUSAI_BOT_WEB_MAX_HOSTS", "40"));
const DEV_KEY = env("ABACUSAI_BOT_WEB_DEV_KEY");
const ORIGINS = new Set(
  env("ABACUSAI_BOT_WEB_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
);

/** How long an identity answer is reused for the same credential. */
const IDENTITY_TTL_MS = 60_000;
/** How often a live tab's session is checked again. */
const RECHECK_MS = 5 * 60_000;
const HOST_START_TIMEOUT_MS = 30_000;
const TUNNEL_TIMEOUT_MS = 10_000;

/** Passed through to host processes; nothing else of ours is. */
const HOST_ENV_PASSTHROUGH = [
  "PATH",
  "LANG",
  "TZ",
  "NODE_ENV",
  "ABACUSAI_BOT_ABACUS_HOST",
  "ABACUSAI_BOT_WEB_VERSION",
];

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const log = (...parts: unknown[]): void => {
  console.log("[web-gateway]", ...parts);
};

// ── Identity ────────────────────────────────────────────────────────────

class IdentityError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super(`identity ${status}`);
  }
}

const identityCache = new Map<string, { at: number; identity: Identity }>();

/**
 * Asks the platform who holds this credential: the browser's cookies, or a
 * desktop's `Bearer` key. A 401 is "not signed in", 403 "not allowed to use
 * the web app"; anything else is the platform being unavailable.
 */
const resolveIdentity = async (credential: {
  cookie?: string;
  bearer?: string;
}): Promise<Identity> => {
  if (DEV_KEY.length > 0)
    return {
      userId: "dev",
      email: env("ABACUSAI_BOT_WEB_DEV_EMAIL", "dev@localhost"),
      name: env("ABACUSAI_BOT_WEB_DEV_NAME", "Developer"),
      apiKey: DEV_KEY,
    };
  const raw = credential.bearer ?? credential.cookie ?? "";
  if (raw.length === 0) throw new IdentityError(401);
  const cacheKey = sha256(raw);
  const cached = identityCache.get(cacheKey);
  if (cached != null && Date.now() - cached.at < IDENTITY_TTL_MS)
    return cached.identity;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-abacusai-bot-web-token": SERVICE_TOKEN,
  };
  if (credential.bearer != null)
    headers.authorization = `Bearer ${credential.bearer}`;
  else if (credential.cookie != null) headers.cookie = credential.cookie;

  let response: Response;
  try {
    response = await fetch(IDENTITY_URL, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    log("identity endpoint unreachable", error);
    throw new IdentityError(503);
  }
  if (response.status === 401 || response.status === 403)
    throw new IdentityError(response.status);
  if (!response.ok) {
    log("identity endpoint answered", response.status);
    throw new IdentityError(503);
  }
  const body = (await response.json()) as {
    result?: Partial<Identity>;
  } & Partial<Identity>;
  const fields = body.result ?? body;
  if (
    typeof fields.userId !== "string" ||
    typeof fields.apiKey !== "string" ||
    fields.userId.length === 0 ||
    fields.apiKey.length === 0
  )
    throw new IdentityError(503);
  const identity: Identity = {
    userId: fields.userId,
    email: typeof fields.email === "string" ? fields.email : "",
    name: typeof fields.name === "string" ? fields.name : "",
    apiKey: fields.apiKey,
  };
  identityCache.set(cacheKey, { at: Date.now(), identity });
  return identity;
};

const userKeyFor = (identity: Identity): string =>
  sha256(`abacusai-bot-web:${identity.userId}`).slice(0, 40);

// ── Host processes ──────────────────────────────────────────────────────

const hosts = new Map<string, HostEntry>();
const runners = new Map<string, Runner>();

const hostStatus = (
  socketPath: string
): Promise<{ sockets: number; busy: boolean } | null> =>
  new Promise((resolveStatus) => {
    const request = httpRequest(
      { socketPath, path: "/status", method: "GET", timeout: 2_000 },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          try {
            resolveStatus(
              JSON.parse(text) as { sockets: number; busy: boolean }
            );
          } catch {
            resolveStatus(null);
          }
        });
      }
    );
    request.on("error", () => resolveStatus(null));
    request.on("timeout", () => request.destroy());
    request.end();
  });

const tellHostRunner = (entry: HostEntry, attached: boolean): void => {
  const request = httpRequest({
    socketPath: entry.socketPath,
    path: `/runner?attached=${attached ? "1" : "0"}`,
    method: "POST",
    timeout: 2_000,
  });
  request.on("error", () => undefined);
  request.end();
};

const stopHost = (entry: HostEntry, why: string): void => {
  log(`stopping host ${entry.userKey.slice(0, 8)}: ${why}`);
  for (const tab of entry.tabs.keys()) tab.close(1012, "restarting");
  entry.child.kill("SIGTERM");
};

const startHost = (identity: Identity, userKey: string): HostEntry => {
  const home = join(DATA, userKey.slice(0, 2), userKey);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const socketPath = join(RUN, `${userKey.slice(0, 24)}.sock`);

  const childEnv: Record<string, string> = {};
  for (const name of HOST_ENV_PASSTHROUGH) {
    const value = process.env[name];
    if (value != null) childEnv[name] = value;
  }
  Object.assign(childEnv, {
    HOME: home,
    ABACUSAI_BOT_HOME: home,
    ABACUSAI_BOT_WEB_KEY: identity.apiKey,
    ABACUSAI_BOT_WEB_SOCKET: socketPath,
    ABACUSAI_BOT_WEB_EMAIL: identity.email,
    ABACUSAI_BOT_WEB_NAME: identity.name,
  });

  const child = fork(join(import.meta.dirname, "host.js"), [], {
    env: childEnv,
    cwd: home,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const tag = `[host ${userKey.slice(0, 8)}]`;
  child.stdout?.on("data", (chunk: Buffer) =>
    process.stdout.write(prefixLines(tag, chunk))
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    process.stderr.write(prefixLines(tag, chunk))
  );

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const deadline = Date.now() + HOST_START_TIMEOUT_MS;
    const poll = (): void => {
      if (child.exitCode != null) {
        rejectReady(new Error("host exited while starting"));
        return;
      }
      void hostStatus(socketPath).then((status) => {
        if (status != null) resolveReady();
        else if (Date.now() > deadline)
          rejectReady(new Error("host did not start in time"));
        else setTimeout(poll, 200);
      });
    };
    poll();
  });

  const entry: HostEntry = {
    userKey,
    child,
    socketPath,
    keyHash: sha256(identity.apiKey),
    ready,
    tabs: new Map(),
    lastActive: Date.now(),
  };
  child.on("exit", (code, signal) => {
    log(`host ${userKey.slice(0, 8)} exited`, code ?? signal);
    if (hosts.get(userKey) === entry) hosts.delete(userKey);
    for (const tab of entry.tabs.keys()) tab.close(1012, "host stopped");
  });
  void ready.then(
    () => {
      if (runners.has(userKey)) tellHostRunner(entry, true);
    },
    (error: unknown) => {
      log(`host ${userKey.slice(0, 8)} failed to start`, error);
      child.kill("SIGKILL");
    }
  );
  hosts.set(userKey, entry);
  return entry;
};

const prefixLines = (tag: string, chunk: Buffer): string =>
  chunk
    .toString("utf8")
    .split(/\n(?=.)/)
    .map((line) => `${tag} ${line}`)
    .join("\n");

/** The user's host, started if needed; null when this machine is full. */
const hostFor = async (identity: Identity): Promise<HostEntry | null> => {
  const userKey = userKeyFor(identity);
  let entry = hosts.get(userKey);
  // A rotated key takes effect once nobody is using the old process.
  if (
    entry != null &&
    entry.keyHash !== sha256(identity.apiKey) &&
    entry.tabs.size === 0
  ) {
    stopHost(entry, "key changed");
    hosts.delete(userKey);
    entry = undefined;
  }
  if (entry == null) {
    if (hosts.size >= MAX_HOSTS && !(await evictIdleHost())) return null;
    entry = startHost(identity, userKey);
  }
  await entry.ready;
  entry.lastActive = Date.now();
  return entry;
};

/** Stops the longest-idle host nobody is using; false if there is none. */
const evictIdleHost = async (): Promise<boolean> => {
  const idle = [...hosts.values()]
    .filter((entry) => entry.tabs.size === 0)
    .sort((a, b) => a.lastActive - b.lastActive);
  for (const entry of idle) {
    const status = await hostStatus(entry.socketPath);
    if (status?.busy === true) continue;
    stopHost(entry, "making room");
    hosts.delete(entry.userKey);
    return true;
  }
  return false;
};

const reapIdleHosts = async (): Promise<void> => {
  for (const entry of hosts.values()) {
    if (entry.tabs.size > 0) {
      entry.lastActive = Date.now();
      continue;
    }
    const status = await hostStatus(entry.socketPath);
    // A run in flight finishes even with nobody watching.
    if (status?.busy === true) {
      entry.lastActive = Date.now();
      continue;
    }
    if (Date.now() - entry.lastActive > IDLE_MS) stopHost(entry, "idle");
  }
};

// ── Sockets ─────────────────────────────────────────────────────────────

/** Both directions, frame for frame; either side closing closes the other. */
const pipe = (a: WebSocket, b: WebSocket): void => {
  const forward =
    (to: WebSocket) =>
    (data: RawData, isBinary: boolean): void => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    };
  a.on("message", forward(b));
  b.on("message", forward(a));
  const closeBoth = (): void => {
    if (
      a.readyState === WebSocket.OPEN ||
      a.readyState === WebSocket.CONNECTING
    )
      a.close();
    if (
      b.readyState === WebSocket.OPEN ||
      b.readyState === WebSocket.CONNECTING
    )
      b.close();
  };
  a.on("close", closeBoth);
  b.on("close", closeBoth);
  a.on("error", closeBoth);
  b.on("error", closeBoth);
};

const openUpstream = (socketPath: string): Promise<WebSocket> =>
  new Promise((resolveSocket, rejectSocket) => {
    const upstream = new WebSocket(`ws+unix://${socketPath}:/`);
    upstream.once("open", () => resolveSocket(upstream));
    upstream.once("error", rejectSocket);
  });

const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 });

const refuse = (socket: Duplex, status: number, reason: string): void => {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
};

const originAllowed = (request: IncomingMessage): boolean => {
  if (DEV_KEY.length > 0) return true;
  const origin = request.headers.origin;
  return origin != null && ORIGINS.has(origin);
};

const bearerOf = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
};

const identityStatus = (error: unknown): [number, string] =>
  error instanceof IdentityError
    ? error.status === 401
      ? [401, "Unauthorized"]
      : error.status === 403
        ? [403, "Forbidden"]
        : [503, "Service Unavailable"]
    : [500, "Internal Server Error"];

/** A browser tab to its user's host. */
const onTab = async (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> => {
  if (!originAllowed(request)) return refuse(socket, 403, "Forbidden");
  const cookie = request.headers.cookie ?? "";
  let identity: Identity;
  try {
    identity = await resolveIdentity({ cookie });
  } catch (error) {
    const [status, reason] = identityStatus(error);
    return refuse(socket, status, reason);
  }
  let entry: HostEntry | null;
  let upstream: WebSocket;
  try {
    entry = await hostFor(identity);
    if (entry == null) return refuse(socket, 503, "Service Unavailable");
    upstream = await openUpstream(entry.socketPath);
  } catch (error) {
    log("could not reach a host", error);
    return refuse(socket, 503, "Service Unavailable");
  }
  const host = entry;
  sockets.handleUpgrade(request, socket, head, (tab) => {
    host.tabs.set(tab, cookie);
    tab.on("close", () => {
      host.tabs.delete(tab);
      host.lastActive = Date.now();
    });
    pipe(tab, upstream);
  });
};

/** A desktop offering itself for coding: its control connection. */
const onRunner = async (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> => {
  const bearer = bearerOf(request);
  let identity: Identity;
  try {
    identity = await resolveIdentity({ bearer });
  } catch (error) {
    const [status, reason] = identityStatus(error);
    return refuse(socket, status, reason);
  }
  const userKey = userKeyFor(identity);
  sockets.handleUpgrade(request, socket, head, (control) => {
    runners.get(userKey)?.control.close(4000, "replaced by another desktop");
    const runner: Runner = { control, pending: new Map() };
    runners.set(userKey, runner);
    log(`runner attached for ${userKey.slice(0, 8)}`);
    const entry = hosts.get(userKey);
    if (entry != null) void entry.ready.then(() => tellHostRunner(entry, true));
    control.on("close", () => {
      if (runners.get(userKey) !== runner) return;
      runners.delete(userKey);
      log(`runner left for ${userKey.slice(0, 8)}`);
      const current = hosts.get(userKey);
      if (current != null) tellHostRunner(current, false);
    });
    // The desktop's keep-alive; nothing else is expected on this socket.
    control.on("message", () => undefined);
  });
};

/** One tunnel the desktop opened because a tab asked for it. */
const onRunnerData = async (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL
): Promise<void> => {
  const bearer = bearerOf(request);
  let identity: Identity;
  try {
    identity = await resolveIdentity({ bearer });
  } catch (error) {
    const [status, reason] = identityStatus(error);
    return refuse(socket, status, reason);
  }
  const runner = runners.get(userKeyFor(identity));
  const channel = url.searchParams.get("channel") ?? "";
  const waiting = runner?.pending.get(channel);
  if (runner == null || waiting == null)
    return refuse(socket, 404, "Not Found");
  runner.pending.delete(channel);
  sockets.handleUpgrade(request, socket, head, (tunnel) => waiting(tunnel));
};

/** A browser tab to the user's own desktop, through a fresh tunnel. */
const onTabToRunner = async (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> => {
  if (!originAllowed(request)) return refuse(socket, 403, "Forbidden");
  let identity: Identity;
  try {
    identity = await resolveIdentity({ cookie: request.headers.cookie ?? "" });
  } catch (error) {
    const [status, reason] = identityStatus(error);
    return refuse(socket, status, reason);
  }
  const runner = runners.get(userKeyFor(identity));
  if (runner == null) return refuse(socket, 404, "Not Found");
  const channel = randomBytes(18).toString("base64url");
  const tunnel = new Promise<WebSocket>((resolveTunnel, rejectTunnel) => {
    const timer = setTimeout(() => {
      runner.pending.delete(channel);
      rejectTunnel(new Error("the desktop did not open a tunnel"));
    }, TUNNEL_TIMEOUT_MS);
    runner.pending.set(channel, (opened) => {
      clearTimeout(timer);
      resolveTunnel(opened);
    });
  });
  runner.control.send(JSON.stringify({ type: "open", channel }));
  let desktop: WebSocket;
  try {
    desktop = await tunnel;
  } catch (error) {
    log("runner tunnel failed", error);
    return refuse(socket, 504, "Gateway Timeout");
  }
  sockets.handleUpgrade(request, socket, head, (tab) => pipe(tab, desktop));
};

/** Closes tabs whose session has ended or moved to another user. */
const recheckTabs = async (): Promise<void> => {
  for (const entry of hosts.values()) {
    for (const [tab, cookie] of entry.tabs) {
      try {
        const identity = await resolveIdentity({ cookie });
        if (userKeyFor(identity) !== entry.userKey)
          tab.close(4401, "signed in as someone else");
      } catch (error) {
        if (error instanceof IdentityError && error.status !== 503)
          tab.close(4401, "signed out");
      }
    }
  }
};

// ── Static files ────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

/**
 * `<base>/session`: may this browser use the app? The page asks before it
 * opens a socket, whose refusal a browser cannot read: 200, 401 (sign in),
 * 403 (not enabled for this account). `?runner=1` also wants the user's
 * desktop attached, 404 if it is not.
 */
const serveSession = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> => {
  let status = 200;
  try {
    const identity = await resolveIdentity({
      cookie: request.headers.cookie ?? "",
    });
    if (
      url.searchParams.get("runner") === "1" &&
      !runners.has(userKeyFor(identity))
    )
      status = 404;
  } catch (error) {
    [status] = identityStatus(error);
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ ok: status === 200 }));
};

const serveStatic = (
  request: IncomingMessage,
  response: ServerResponse
): void => {
  const url = new URL(request.url ?? "/", "http://gateway");
  if (url.pathname === `${BASE}/session`) {
    void serveSession(request, response, url).catch((error: unknown) => {
      log("session check failed", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    return;
  }
  if (url.pathname === `${BASE}/healthz`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hosts: hosts.size, runners: runners.size }));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === BASE) {
    response.writeHead(308, { location: `${BASE}/` }).end();
    return;
  }
  if (!url.pathname.startsWith(`${BASE}/`)) {
    response.writeHead(404).end();
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice(BASE.length + 1));
  } catch {
    response.writeHead(400).end();
    return;
  }
  const candidate = normalize(join(STATIC, relative));
  const inside = candidate === STATIC || candidate.startsWith(STATIC + sep);
  const isFile =
    inside && existsSync(candidate) && statSync(candidate).isFile();
  // Routes are the app's: anything that is not a file is the page itself.
  const file = isFile ? candidate : join(STATIC, "web.html");
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const immutable = isFile && relative.startsWith("assets/");
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": type,
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
};

// ── Start ───────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (DATA.length === 0) throw new Error("ABACUSAI_BOT_WEB_DATA is required");
  if (DEV_KEY.length > 0) {
    if (LISTEN_HOST !== "127.0.0.1" && LISTEN_HOST !== "localhost")
      throw new Error("ABACUSAI_BOT_WEB_DEV_KEY needs a loopback listener");
    log("development mode: every caller is the one developer user");
  } else if (IDENTITY_URL.length === 0 || SERVICE_TOKEN.length === 0) {
    throw new Error(
      "ABACUSAI_BOT_WEB_IDENTITY_URL and ABACUSAI_BOT_WEB_SERVICE_TOKEN are required"
    );
  } else if (ORIGINS.size === 0) {
    throw new Error("ABACUSAI_BOT_WEB_ORIGINS is required");
  }
  if (!existsSync(join(STATIC, "web.html")))
    log(`warning: no web build at ${STATIC}`);
  mkdirSync(dirname(join(RUN, "x")), { recursive: true, mode: 0o700 });

  const server = createServer(serveStatic);
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://gateway");
    const route =
      url.pathname === `${BASE}/rpc`
        ? onTab(request, socket, head)
        : url.pathname === `${BASE}/runner`
          ? onRunner(request, socket, head)
          : url.pathname === `${BASE}/runner/data`
            ? onRunnerData(request, socket, head, url)
            : url.pathname === `${BASE}/runner-rpc`
              ? onTabToRunner(request, socket, head)
              : null;
    if (route == null) {
      refuse(socket, 404, "Not Found");
      return;
    }
    route.catch((error: unknown) => {
      log("upgrade failed", error);
      refuse(socket, 500, "Internal Server Error");
    });
  });

  setInterval(() => void reapIdleHosts(), 60_000).unref();
  setInterval(() => void recheckTabs(), RECHECK_MS).unref();

  await new Promise<void>((resolveListen) =>
    server.listen(Number(LISTEN_PORT), LISTEN_HOST, resolveListen)
  );
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT}${BASE}/`);

  const shutdown = (): void => {
    log("shutting down");
    for (const entry of hosts.values()) entry.child.kill("SIGTERM");
    server.close();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

void main().catch((error: unknown) => {
  console.error("[web-gateway] failed to start", error);
  process.exit(1);
});
