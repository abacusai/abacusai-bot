/**
 * The `abacus-connectors` MCP server row said "3 tools" and nothing else,
 * and a user who had attached nothing in this app asked what the three
 * were. They are the account's platform connectors; this names them, from
 * the registry — a service attached elsewhere that this app does not take is
 * not behind this server and is not listed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ConnectorStatuses } from "#shared/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count != null ? `${key}:${opts.count}` : key,
  }),
}));

const { AbacusConnectorsSummary, connectedRows } =
  await import("./abacus-connectors-summary");

const mount = (statuses: ConnectorStatuses): ReturnType<typeof render> => {
  (window as unknown as { api: unknown }).api = {
    agent: {
      listConnectorStatuses: async () => statuses,
      onEvent: () => () => undefined,
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = (): JSX.Element => (
    <QueryClientProvider client={client}>
      <AbacusConnectorsSummary />
    </QueryClientProvider>
  );
  return render(<Wrapper />);
};

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

describe("what is behind the abacus-connectors server", () => {
  it("names each attached platform connector with its card name and account", async () => {
    mount({
      "abacus-gmailuser": {
        state: "connected",
        account: "Gmail - ada@example.com",
      },
      "abacus-slack": { state: "connected" },
      "abacus-jira": { state: "available" },
      github: { state: "connected" },
    });
    await waitFor(() => expect(byId("mcp-abacus-connectors")).not.toBeNull());
    expect(byId("mcp-abacus-connectors")?.textContent).toContain(
      "mcpManagement.abacusConnectors.title:2"
    );
    expect(byId("mcp-abacus-connector-gmailuser")?.textContent).toBe("Gmail");
    expect(byId("mcp-abacus-connector-gmailuser")?.title).toBe(
      "Gmail - ada@example.com"
    );
    // A token card is not behind this server.
    expect(byId("mcp-abacus-connector-github")).toBeNull();
  });

  it("says none are attached when the listing is real and empty", async () => {
    mount({
      "abacus-gmailuser": { state: "available" },
      "abacus-slack": { state: "unavailable", reason: "not-offered" },
    });
    await waitFor(() =>
      expect(byId("mcp-abacus-connectors-none")).not.toBeNull()
    );
  });

  it("does not call an unreadable listing empty", async () => {
    mount({
      "abacus-gmailuser": { state: "unavailable", reason: "not-signed-in" },
      "abacus-slack": { state: "unavailable", reason: "not-signed-in" },
    });
    await waitFor(() =>
      expect(byId("mcp-abacus-connectors-unavailable")).not.toBeNull()
    );
    expect(byId("mcp-abacus-connectors-none")).toBeNull();
  });
});

describe("connectedRows", () => {
  it("keeps the registry order and only platform connectors", () => {
    const rows = connectedRows({
      "abacus-slack": { state: "connected" },
      "abacus-gmailuser": { state: "connected" },
      github: { state: "connected" },
      "messaging-whatsapp": { state: "connected" },
    });
    expect(rows.map((row) => row.service)).toEqual(["gmailuser", "slack"]);
  });
});
