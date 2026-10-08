import type { IncomingMessage } from "node:http";

import { expect, it } from "vitest";

import { authenticate } from "./auth";
import { downloadFailure, downloadTicket } from "./downloads";

it("binds a download to its file, owner, origin and expiry without granting RPC access", () => {
  const identity = {
    owner: "owner",
    org: "org",
    secret: "secret",
    origins: new Set(["https://app.test"]),
  };
  const now = 100_000;
  const ticket = downloadTicket(
    identity,
    "Résumé notes.txt",
    "/home/demo",
    now
  );
  const request = {
    headers: {
      origin: "https://app.test",
      "x-abacus-user-id": "owner",
      "x-abacus-org-id": "org",
    },
  } as unknown as IncomingMessage;
  const url = new URL(
    `https://host.test/files?${new URLSearchParams({ path: "Résumé notes.txt", hostRoot: "/home/demo", ticket })}`
  );
  expect(downloadFailure(request, identity, url, now)).toBeNull();
  expect(downloadFailure(request, identity, url, now + 60_000)).toBe(
    "ticket-expiry"
  );
  for (const [key, value] of [
    ["path", "other"],
    ["hostRoot", "/tmp"],
    ["whisperUrl", "https://model.test"],
  ]) {
    const changed = new URL(url);
    changed.searchParams.set(key!, value!);
    expect(downloadFailure(request, identity, changed, now)).toBe(
      "ticket-path"
    );
  }
  for (const [key, value] of [
    ["origin", "https://other.test"],
    ["x-abacus-user-id", "other"],
    ["x-abacus-org-id", "other"],
  ]) {
    const changed = {
      headers: { ...request.headers, [key!]: value },
    } as unknown as IncomingMessage;
    expect(downloadFailure(changed, identity, url, now)).not.toBeNull();
  }
  const tampered = new URL(url);
  tampered.searchParams.set(
    "ticket",
    ticket.slice(0, -1) + (ticket.endsWith("0") ? "1" : "0")
  );
  expect(downloadFailure(request, identity, tampered, now)).toBe("ticket");
  expect(
    authenticate(
      {
        headers: { ...request.headers, authorization: `Bearer ${ticket}` },
      } as IncomingMessage,
      identity
    )
  ).toBe("signature");
});
