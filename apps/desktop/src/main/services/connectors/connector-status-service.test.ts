import type { MessagingSnapshot } from "@abacus-ai/contract/messaging";
/**
 * One status per registry connector, each kind from its own truth. What used
 * to be four separate "is it connected?" computations across the panel, the
 * onboarding step, the environment notice and the tool is one table here.
 */
import { describe, expect, it } from "vitest";

import {
  buildConnectorStatuses,
  connectorsInState,
  ConnectorStatusService,
  type StatusInputs,
} from "./connector-status-service";

const platform = (
  id: string,
  overrides: Partial<MessagingSnapshot["platforms"][number]> = {}
): MessagingSnapshot["platforms"][number] =>
  ({
    id,
    nameKey: id,
    docsUrl: "",
    enabled: false,
    configured: false,
    state: "disabled",
    errorMessage: null,
    fields: [],
    pendingCount: 0,
    ...overrides,
  }) as MessagingSnapshot["platforms"][number];

const inputs = (overrides: Partial<StatusInputs> = {}): StatusInputs => ({
  platform: {
    available: new Set(["gmailuser", "slack"]),
    connected: new Set(["gmailuser"]),
    accounts: { gmailuser: "Gmail - ada@example.com" },
  },
  messaging: null,
  mcpServers: [],
  mcpTokens: new Map(),
  ...overrides,
});

describe("platform connectors", () => {
  it("are connected, with the account, when the platform lists them attached", () => {
    const statuses = buildConnectorStatuses(inputs());

    expect(statuses["abacus-gmailuser"]).toEqual({
      state: "connected",
      account: "Gmail - ada@example.com",
    });
  });

  it("are available when offered but not attached, unavailable when the account does not offer them", () => {
    const statuses = buildConnectorStatuses(inputs());

    expect(statuses["abacus-slack"]).toEqual({ state: "available" });
    expect(statuses["abacus-jira"]).toEqual({
      state: "unavailable",
      reason: "not-offered",
    });
  });

  it("are unavailable, and say why, when there is no listing at all", () => {
    expect(
      buildConnectorStatuses(inputs({ platform: null }))["abacus-gmailuser"]
    ).toEqual({ state: "unavailable", reason: "unavailable" });
    expect(
      buildConnectorStatuses(
        inputs({
          platform: {
            available: new Set(),
            connected: new Set(),
            accounts: {},
            reason: "not-signed-in",
          },
        })
      )["abacus-gmailuser"]
    ).toEqual({ state: "unavailable", reason: "not-signed-in" });
  });
});

describe("messaging connectors", () => {
  const snapshot = (
    platforms: MessagingSnapshot["platforms"]
  ): MessagingSnapshot =>
    ({
      platforms,
      pending: [],
      approved: [],
      gatewayEnabled: true,
      autoApproveTools: false,
      workspaceId: null,
    }) as unknown as MessagingSnapshot;

  it("are connected only when the gateway has them live", () => {
    const live = snapshot([
      platform("whatsapp", {
        enabled: true,
        configured: true,
        state: "connected",
      }),
    ]);
    expect(
      buildConnectorStatuses(inputs({ messaging: live }))["messaging-whatsapp"]
    ).toEqual({ state: "connected" });
  });

  it("are pending when enabled and configured but not live, since a broken link is not a connection", () => {
    const stale = snapshot([
      platform("whatsapp", {
        enabled: true,
        configured: true,
        state: "needs_login",
      }),
    ]);
    expect(
      buildConnectorStatuses(inputs({ messaging: stale }))["messaging-whatsapp"]
    ).toEqual({ state: "pending", reason: "not-live" });
  });

  it("are available when nothing is set up, or the gateway snapshot is unknown", () => {
    expect(buildConnectorStatuses(inputs())["messaging-telegram"]).toEqual({
      state: "available",
    });
  });
});

describe("mcp connectors", () => {
  const notion = {
    id: "notion",
    name: "notion",
    config: { url: "https://mcp.notion.com/mcp" },
    isBuiltin: false,
  };
  const huggingface = {
    id: "huggingface",
    name: "huggingface",
    config: { url: "https://huggingface.co/mcp" },
    isBuiltin: false,
  };

  it("are available until their server is in the config", () => {
    expect(buildConnectorStatuses(inputs()).notion).toEqual({
      state: "available",
    });
  });

  it("an OAuth server is connected only with a valid token, and pending when it is expired or absent", () => {
    const statusFor = (state?: "valid" | "expired" | "absent") =>
      buildConnectorStatuses(
        inputs({
          mcpServers: [notion],
          mcpTokens: new Map(state != null ? [["notion", state]] : []),
        })
      ).notion;
    expect(statusFor("valid")).toEqual({ state: "connected" });
    for (const state of ["expired", "absent", undefined] as const)
      expect(statusFor(state)).toEqual({
        state: "pending",
        reason: "sign-in-required",
      });
  });

  it("a server that needs no sign-in is connected unless its sign-in was refused", () => {
    const statusFor = (state: "valid" | "expired" | "absent") =>
      buildConnectorStatuses(
        inputs({
          mcpServers: [huggingface],
          mcpTokens: new Map([["huggingface", state]]),
        })
      ).huggingface;
    expect(statusFor("absent")).toEqual({ state: "connected" });
    expect(statusFor("expired")).toEqual({
      state: "pending",
      reason: "sign-in-required",
    });
  });
});

describe("the service", () => {
  it("reads every source and survives the platform listing failing", async () => {
    const service = new ConnectorStatusService({
      platform: async () => {
        throw new Error("network");
      },
      messaging: () => null,
      mcpServers: () => [
        {
          id: "notion",
          name: "notion",
          config: { url: "https://mcp.notion.com/mcp" },
          isBuiltin: false,
        },
      ],
      mcpTokens: () => new Map([["notion", "valid"]]),
    });
    const statuses = await service.list();

    expect(statuses.notion).toEqual({ state: "connected" });
    expect(statuses["abacus-gmailuser"]?.state).toBe("unavailable");
    expect(connectorsInState(statuses, "connected").map((c) => c.id)).toEqual([
      "notion",
    ]);
  });
});
