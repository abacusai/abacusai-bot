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
const Bootstrap = v.object({
  token: v.string(),
  previewHost: v.string(),
  version: v.string(),
});
const Health = v.object({
  ok: v.boolean(),
  owner: v.string(),
  contractVersion: v.number(),
});
export const appsHost =
  import.meta.env.VITE_ABACUS_ENV === "staging"
    ? "https://staging-apps.abacus.ai"
    : "https://apps.abacus.ai";
export const callApps = async (
  service: string,
  input: unknown
): Promise<unknown> => {
  const response = await fetch(`${appsHost}/api/_${service}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "REAI-UI": "1" },
    body: JSON.stringify(input),
  });
  if (response.status === 401)
    throw new ConnectError("signin", "Sign in to connect");
  if (response.status === 403)
    throw new ConnectError("tier", "A Pro account is required");
  if (!response.ok)
    throw new ConnectError(
      "connection",
      `Connection service failed (${response.status})`
    );
  return response.json();
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface BrowserConnection {
  url: string;
  token: string;
  deploymentConversationId: string;
  origin: string;
}
let connection: BrowserConnection | undefined;
export const browserConnection = (): BrowserConnection => {
  if (!connection) throw new Error("Browser host is not connected");
  return connection;
};
export const resolveBrowserHost = async (
  stage: (value: ConnectStage) => void,
  forceRestart = false
): Promise<BrowserConnection> => {
  stage("starting");
  const host = v.parse(Host, await callApps("getOrCreateAbacusBotHost", {}));
  const deadline = Date.now() + 7 * 60_000;
  for (;;) {
    const computer = (await callApps("getChatLLMComputer", {
      deploymentConversationId: host.deploymentConversationId,
      waitForActiveSeconds: 0,
    })) as { status?: string; lifecycle?: string };
    if (computer.status === "ACTIVE" || computer.lifecycle === "ACTIVE") break;
    if (Date.now() >= deadline)
      throw new ConnectError("connection", "Computer start timed out");
    await delay(3000);
  }
  stage("installing");
  const boot = v.parse(
    Bootstrap,
    await callApps("bootstrapAbacusBotHost", {
      deploymentConversationId: host.deploymentConversationId,
      forceRestart,
    })
  );
  const origin = `https://${boot.previewHost}`;
  const healthDeadline = Date.now() + 65_000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/healthz`, {
        credentials: "include",
      });
      if (response.ok) {
        const health = v.parse(Health, await response.json());
        const payload = JSON.parse(
          atob(
            boot.token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/")
          )
        ) as { o: string };
        if (!health.ok || health.owner !== payload.o)
          throw new ConnectError("connection", "Host identity mismatch");
        if (health.contractVersion !== CONTRACT_VERSION)
          throw new ConnectError(
            "version",
            "Restart your computer to update it"
          );
        break;
      }
      if (
        response.status !== 403 &&
        response.status !== 502 &&
        response.status !== 503
      )
        throw new ConnectError(
          "connection",
          `Host health failed (${response.status})`
        );
    } catch (error) {
      if (error instanceof ConnectError) throw error;
    }
    if (Date.now() >= healthDeadline)
      throw new ConnectError("connection", "Host did not become ready");
    await delay(3000);
  }
  stage("connecting");
  connection = {
    origin,
    url: origin.replace(/^https:/, "wss:") + "/rpc",
    token: boot.token,
    deploymentConversationId: host.deploymentConversationId,
  };
  return connection;
};
