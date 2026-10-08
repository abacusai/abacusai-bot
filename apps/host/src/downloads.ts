import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { authenticateProxyRequest, type HostIdentity } from "./auth";

export const downloadTicket = (
  identity: HostIdentity,
  path: string,
  root: string,
  now: number
): string => {
  const payload = Buffer.from(
    JSON.stringify({ path, root, expiry: now + 60_000 })
  ).toString("base64url");
  const signature = createHmac("sha256", identity.secret)
    .update(`download\n${payload}`)
    .digest("hex");
  return `${payload}.${signature}`;
};
export const downloadFailure = (
  request: IncomingMessage,
  identity: HostIdentity,
  url: URL,
  now: number
): string | null => {
  const proxy = authenticateProxyRequest(request, identity);
  if (proxy) return proxy;
  const ticket = url.searchParams.get("ticket") ?? "";
  if (ticket.length > 16_384 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket))
    return "ticket";
  const [payload, signature] = ticket.split(".");
  const expected = createHmac("sha256", identity.secret)
    .update(`download\n${payload}`)
    .digest();
  if (!timingSafeEqual(Buffer.from(signature!, "hex"), expected))
    return "ticket";
  try {
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString("utf8")
    ) as { path?: unknown; root?: unknown; expiry?: unknown };
    if (
      typeof claims.expiry !== "number" ||
      claims.expiry <= now ||
      claims.expiry > now + 60_000
    )
      return "ticket-expiry";
    if (
      claims.path !== url.searchParams.get("path") ||
      claims.root !== url.searchParams.get("hostRoot") ||
      url.searchParams.has("whisperUrl")
    )
      return "ticket-path";
  } catch {
    return "ticket";
  }
  return null;
};
