import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import * as v from "valibot";
export type ConnectStage = "starting" | "installing" | "connecting";
export class ConnectError extends Error {
  constructor(
    readonly kind: "signin" | "tier" | "version" | "connection",
    message: string
  ) {
    super(message);
  }
}
const Host = v.object({
  deploymentConversationId: v.string(),
  previewHost: v.string(),
});
const Bootstrap = v.variant("status", [
  v.object({
    status: v.literal("starting"),
    token: v.nullable(v.pipe(v.string(), v.minLength(1))),
    version: v.nullable(v.string()),
    previewHost: v.string(),
    detail: v.nullable(v.string()),
  }),
  v.object({
    status: v.literal("ready"),
    previewHost: v.string(),
    token: v.pipe(v.string(), v.minLength(1)),
    version: v.nullable(v.string()),
    detail: v.nullable(v.string()),
  }),
]);
const Health = v.object({
  ok: v.boolean(),
  owner: v.string(),
  contractVersion: v.number(),
});
const parse = <T>(schema: v.GenericSchema<unknown, T>, value: unknown): T => {
  try {
    return v.parse(schema, value);
  } catch {
    throw new ConnectError("connection", "Invalid connection service response");
  }
};
export const callApps = async (
  service: string,
  input: unknown
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(`/api/_${service}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "REAI-UI": "1" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ConnectError(
      "connection",
      "Connection service unavailable. Please retry."
    );
  }
  const body = (await response.json().catch(() => null)) as {
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
  if (
    response.status === 401 ||
    /not.?logged.?in/i.test(`${body?.errorType ?? ""} ${message}`)
  )
    throw new ConnectError("signin", message);
  if (!response.ok || body?.success !== true)
    throw new ConnectError("connection", message);
  return body.result;
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface BrowserConnection {
  url: string;
  token: string;
  tokenIssuedAt: number;
  deploymentConversationId: string;
  origin: string;
  local?: boolean;
}
let connection: BrowserConnection | undefined;
export const browserConnection = (): BrowserConnection => {
  if (!connection) throw new Error("Browser host is not connected");
  return connection;
};
const bootstrap = async (
  deploymentConversationId: string,
  forceRestart = false
) => {
  const deadline = Date.now() + 7 * 60_000;
  for (;;) {
    const boot = parse(
      Bootstrap,
      await callApps("bootstrapAbacusBotHost", {
        deploymentConversationId,
        ...(forceRestart ? { forceRestart: true } : {}),
      })
    );
    // Restart only once; subsequent polls must not restart a healthy host.
    forceRestart = false;
    if (boot.status === "ready") return boot;
    if (Date.now() >= deadline)
      throw new ConnectError(
        "connection",
        boot.detail ?? "Computer start timed out"
      );
    await delay(3000);
  }
};
let refreshing: Promise<BrowserConnection> | undefined;
export const refreshUploadToken = (
  force = false
): Promise<BrowserConnection> => {
  const host = browserConnection();
  if (host.local) return Promise.resolve(host);
  if (!force && Date.now() - host.tokenIssuedAt < 8 * 60_000)
    return Promise.resolve(host);
  refreshing ??= bootstrap(host.deploymentConversationId)
    .then((boot) => {
      if (`https://${boot.previewHost}` !== host.origin)
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
export const resolveBrowserHost = async (
  stage: (value: ConnectStage) => void,
  forceRestart = false
): Promise<BrowserConnection> => {
  stage("starting");
  if (import.meta.env.DEV && import.meta.env.VITE_WEB_HOST_URL) {
    const url = new URL(import.meta.env.VITE_WEB_HOST_URL);
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
      origin: url.origin.replace(/^ws/, "http"),
      token,
      tokenIssuedAt: Date.now(),
      deploymentConversationId: "local",
      local: true,
    };
    stage("connecting");
    return connection;
  }
  const host = parse(Host, await callApps("getOrCreateAbacusBotHost", {}));
  const boot = await bootstrap(host.deploymentConversationId, forceRestart);
  const tokenIssuedAt = Date.now();
  stage("installing");
  const origin = `https://${boot.previewHost}`;
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
  const installDeadline = Date.now() + 5 * 60_000;
  let denialDeadline: number | undefined;
  for (;;) {
    let response: Response | undefined;
    try {
      response = await fetch(`${origin}/healthz`, { credentials: "include" });
    } catch {
      /* Proxy may still be starting. */
    }
    if (response?.ok) {
      const health = parse(Health, await response.json().catch(() => null));
      if (!health.ok || health.owner !== owner)
        throw new ConnectError("connection", "Host identity mismatch");
      if (health.contractVersion !== CONTRACT_VERSION)
        throw new ConnectError("version", "Restart your computer to update it");
      break;
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
    await delay(3000);
  }
  stage("connecting");
  connection = {
    origin,
    url: origin.replace(/^https:/, "wss:") + "/rpc",
    token: boot.token,
    tokenIssuedAt,
    deploymentConversationId: host.deploymentConversationId,
  };
  return connection;
};
