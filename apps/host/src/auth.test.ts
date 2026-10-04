import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { authenticate, type HostIdentity } from "./auth";
const identity: HostIdentity = {
  owner: "owner",
  org: "org",
  secret: "utf8-secret\n",
  origins: new Set(["https://apps.abacus.ai"]),
};
const token = (
  claims = { o: "owner", g: "org", e: Math.floor(Date.now() / 1000) + 600 }
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
        authorization: `Bearer ${token({ o: "other", g: "org", e: Math.floor(Date.now() / 1000) + 600 })}`,
      },
      "claims",
    ],
    [
      {
        authorization: `Bearer ${token({ o: "owner", g: "other", e: Math.floor(Date.now() / 1000) + 600 })}`,
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

it("accepts the reference Python minter vector and rejects malformed signed claims", async () => {
  const { readFileSync } = await import("node:fs");
  const vector = JSON.parse(
    readFileSync(
      new URL("./fixtures/python-token.json", import.meta.url),
      "utf8"
    )
  );
  const pythonIdentity = { ...identity, secret: vector.secret };
  expect(
    authenticate(
      request({ authorization: `Bearer ${vector.token}` }),
      pythonIdentity
    )
  ).toBeNull();
  for (const suffix of [".", "..", ".extra"])
    expect(
      authenticate(
        request({ authorization: `Bearer ${vector.token}${suffix}` }),
        pythonIdentity
      )
    ).not.toBeNull();
  expect(
    authenticate(
      request({ authorization: `Bearer x${vector.token.slice(1)}` }),
      pythonIdentity
    )
  ).not.toBeNull();
  expect(
    authenticate(
      request({
        authorization: `Bearer ${token({ o: "owner", g: "org", e: 2000000000.5 })}`,
      }),
      identity
    )
  ).toBe("expiry");
  const padded = vector.token.split(".")[0] + "=";
  const signed = `${padded}.${createHmac("sha256", vector.secret).update(padded).digest("hex")}`;
  expect(
    authenticate(request({ authorization: `Bearer ${signed}` }), pythonIdentity)
  ).not.toBeNull();
});

it("pins Python expiry boundaries and exact JSON claim types", async () => {
  const { readFileSync } = await import("node:fs");
  const vector = JSON.parse(
    readFileSync(
      new URL("./fixtures/python-token.json", import.meta.url),
      "utf8"
    )
  );
  const pythonIdentity = { ...identity, secret: vector.secret };
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(vector.expiry * 1000 - 1);
    expect(
      authenticate(
        request({ authorization: `Bearer ${vector.token}` }),
        pythonIdentity
      )
    ).toBeNull();
    now.mockReturnValue(vector.expiry * 1000);
    expect(
      authenticate(
        request({ authorization: `Bearer ${vector.token}` }),
        pythonIdentity
      )
    ).toBe("expiry");
  } finally {
    now.mockRestore();
  }
  for (const claims of [
    null,
    [],
    { o: "owner", g: "org", e: "2000000000" },
    { o: "owner", g: "org", e: true },
    { o: 1, g: "org", e: 2000000000 },
  ]) {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signed = `${payload}.${createHmac("sha256", identity.secret).update(payload).digest("hex")}`;
    expect(
      authenticate(request({ authorization: `Bearer ${signed}` }), identity)
    ).not.toBeNull();
  }
});

it.each(["2000000000.0", "2e9"])(
  "rejects signed JSON float expiry %s as the Python verifier does",
  (expiry) => {
    const payload = Buffer.from(
      `{"o":"owner","g":"org","e":${expiry}}`
    ).toString("base64url");
    const signed = `${payload}.${createHmac("sha256", identity.secret).update(payload).digest("hex")}`;
    expect(
      authenticate(request({ authorization: `Bearer ${signed}` }), identity)
    ).toBe("expiry");
  }
);
