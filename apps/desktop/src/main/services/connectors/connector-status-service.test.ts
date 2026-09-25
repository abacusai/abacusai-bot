/**
 * One status per registry connector, each kind from its own truth. What used
 * to be four separate "is it connected?" computations across the panel, the
 * onboarding step, the environment notice and the tool is one table here.
 */
import { describe, expect, it } from "vitest";

import type { MessagingSnapshot } from "#shared/messaging";

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
  storedProviders: new Set(),
  messaging: null,
  mcpServers: [],
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

describe("credential connectors", () => {
  it("are connected exactly when the provider's key is stored", () => {
    expect(buildConnectorStatuses(inputs()).github).toEqual({
      state: "available",
    });
    expect(
      buildConnectorStatuses(inputs({ storedProviders: new Set(["github"]) }))
        .github
    ).toEqual({ state: "connected" });
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
  it("are connected when their server is in the config, pending when it awaits a sign-in", () => {
    const withNotion = inputs({
      mcpServers: [
        {
          id: "notion",
          name: "notion",
          config: { url: "https://mcp.notion.com/mcp" },
          isBuiltin: false,
        },
      ],
    });
    expect(buildConnectorStatuses(withNotion).notion).toEqual({
      state: "connected",
    });
    expect(
      buildConnectorStatuses({
        ...withNotion,
        mcpAuthRequired: new Set(["notion"]),
      }).notion
    ).toEqual({ state: "pending", reason: "sign-in-required" });
    expect(buildConnectorStatuses(inputs()).notion).toEqual({
      state: "available",
    });
  });
});

describe("the service", () => {
  it("reads every source and survives the platform listing failing", async () => {
    const service = new ConnectorStatusService({
      platform: async () => {
        throw new Error("network");
      },
      storedProviders: () => new Set(["github"]),
      messaging: () => null,
      mcpServers: () => [],
    });
    const statuses = await service.list();

    expect(statuses.github).toEqual({ state: "connected" });
    expect(statuses["abacus-gmailuser"]?.state).toBe("unavailable");
    expect(connectorsInState(statuses, "connected").map((c) => c.id)).toEqual([
      "github",
    ]);
  });
});
