import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { authenticate, type HostIdentity } from "./auth";
const identity: HostIdentity = {
  owner: "owner",
  org: "org",
  secret: "utf8-secret\n",
  origins: new Set(["https://apps.abacus.ai"]),
};
const token = (
  claims = { o: "owner", g: "org", e: Date.now() / 1000 + 600 }
) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", identity.secret).update(payload).digest("hex")}`;
};
const request = (headers: IncomingMessage["headers"] = {}) =>
  ({
    headers: {
      origin: "https://apps.abacus.ai",
      "x-abacus-user-id": "owner",
      authorization: `Bearer ${token()}`,
      ...headers,
    },
  }) as unknown as IncomingMessage;
describe("connection authentication", () => {
  it("accepts bearer and browser subprotocol tokens signed with the exact secret text", () => {
    expect(authenticate(request(), identity)).toBeNull();
    expect(
      authenticate(
        request({
          authorization: undefined,
          "sec-websocket-protocol": `abacus-rpc, abacus-token.${token()}`,
        }),
        identity
      )
    ).toBeNull();
  });
  it.each([
    [{ origin: "https://apps.abacus.ai.evil.example" }, "origin"],
    [{ origin: undefined }, "origin"],
    [{ "x-abacus-user-id": "another" }, "owner"],
    [{ authorization: undefined }, "token"],
    [
      {
        authorization: `Bearer ${token({ o: "other", g: "org", e: Date.now() / 1000 + 600 })}`,
      },
      "claims",
    ],
    [
      {
        authorization: `Bearer ${token({ o: "owner", g: "other", e: Date.now() / 1000 + 600 })}`,
      },
      "claims",
    ],
    [
      { authorization: `Bearer ${token({ o: "owner", g: "org", e: 1 })}` },
      "expiry",
    ],
    [{ authorization: `Bearer ${token().slice(0, -1)}x` }, "signature"],
  ])("refuses invalid identity headers or claims", (headers, reason) =>
    expect(authenticate(request(headers), identity)).toBe(reason)
  );
});
