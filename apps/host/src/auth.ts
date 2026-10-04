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
  if (!/^[a-f0-9]{64}$/.test(secret))
    throw new Error(
      "Host secret must be 64 lowercase hex characters without a newline"
    );
  return { owner, org, secret, origins };
};
export const authenticate = (
  request: IncomingMessage,
  identity: HostIdentity
): string | null => {
  const origin = request.headers.origin;
  if (!origin || !identity.origins.has(origin)) return "origin";
  if (request.headers["x-abacus-user-id"] !== identity.owner) return "owner";
  if (
    request.headers["x-abacus-org-id"] !== undefined &&
    request.headers["x-abacus-org-id"] !== identity.org
  )
    return "org";
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((x) => x.trim());
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const token =
    bearer ?? protocols.find((p) => p.startsWith("abacus-token."))?.slice(13);
  if (!token || token.length > 4096) return "token";
  const segments = token.split(".");
  const [payload, signature] = segments;
  if (
    segments.length !== 2 ||
    !payload ||
    !signature ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return "signature";
  if (Buffer.from(payload, "base64url").toString("base64url") !== payload)
    return "claims";
  const expected = createHmac("sha256", identity.secret)
    .update(payload)
    .digest();
  if (!timingSafeEqual(Buffer.from(signature, "hex"), expected))
    return "signature";
  try {
    const expirySources = new WeakMap<object, string>();
    const claims = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(payload, "base64url")
      ),
      function (
        this: object,
        key: string,
        value: unknown,
        context?: { source?: string }
      ) {
        if (key === "e") expirySources.set(this, context?.source ?? "");
        return value;
      }
    );
    if (
      !claims ||
      Array.isArray(claims) ||
      typeof claims !== "object" ||
      claims.o !== identity.owner ||
      claims.g !== identity.org
    )
      return "claims";
    if (
      typeof claims.e !== "number" ||
      !/^-?(0|[1-9][0-9]*)$/.test(expirySources.get(claims) ?? "") ||
      claims.e <= Date.now() / 1000
    )
      return "expiry";
  } catch {
    return "claims";
  }
  return null;
};
