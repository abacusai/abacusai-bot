import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
export interface HostIdentity {
  owner: string;
  org: string;
  secret: string;
  origins: Set<string>;
}
export const readHostIdentity = (): HostIdentity => {
  const owner = process.env.ABACUSAI_BOT_HOST_OWNER;
  const org = process.env.ABACUSAI_BOT_HOST_ORG;
  const file = process.env.ABACUSAI_BOT_HOST_SECRET_FILE;
  const origins = new Set(
    (process.env.ABACUSAI_BOT_HOST_ORIGINS ?? "").split(",").filter(Boolean)
  );
  if (!owner || !org || !file || !origins.size)
    throw new Error("Host identity configuration required");
  const secret = readFileSync(file, "utf8");
  if (!secret) throw new Error("Host secret is empty");
  return { owner, org, secret, origins };
};
export const authenticate = (
  request: IncomingMessage,
  identity: HostIdentity
): string | null => {
  const origin = request.headers.origin;
  if (!origin || !identity.origins.has(origin)) return "origin";
  if (request.headers["x-abacus-user-id"] !== identity.owner) return "owner";
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((x) => x.trim());
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const token =
    bearer ?? protocols.find((p) => p.startsWith("abacus-token."))?.slice(13);
  if (!token || token.length > 4096) return "token";
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !/^[a-f0-9]{64}$/.test(signature))
    return "signature";
  const expected = createHmac("sha256", identity.secret)
    .update(payload)
    .digest();
  if (!timingSafeEqual(Buffer.from(signature, "hex"), expected))
    return "signature";
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    if (claims.o !== identity.owner || claims.g !== identity.org)
      return "claims";
    if (!Number.isFinite(claims.e) || claims.e <= Date.now() / 1000)
      return "expiry";
  } catch {
    return "claims";
  }
  return null;
};
