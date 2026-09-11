/**
 * The `abacus-connectors` MCP server row said "3 tools" and nothing else,
 * and a user who had attached nothing in this app asked what the three
 * were. They are the account's Abacus connectors; this names them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count != null ? `${key}:${opts.count}` : key,
  }),
}));

// The hook's module pulls in the messaging connectors page; the query
// options are all this component uses.
vi.mock("../../hooks/use-connected-connectors", () => ({
  abacusConnectorsQueryOptions: {
    queryKey: ["settings", "connectors", "connectors"],
    queryFn: async () => {
      const snapshot = await window.api?.agent?.listAbacusConnectors?.();
      if (snapshot?.ok !== true)
        return { connected: new Set(), available: null };
      return {
        connected: new Set(Object.keys(snapshot.connected)),
        available: new Set(
          snapshot.available.map((item: { service: string }) => item.service)
        ),
        names: Object.fromEntries(
          snapshot.available.map((item: { service: string; name: string }) => [
            item.service,
            item.name,
          ])
        ),
        accounts: snapshot.accounts,
      };
    },
  },
}));

const { AbacusConnectorsSummary, connectedRows } =
  await import("./abacus-connectors-summary");

const mount = (snapshot: unknown): ReturnType<typeof render> => {
  (window as unknown as { api: unknown }).api = {
    agent: { listAbacusConnectors: async () => snapshot },
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
  it("names each attached connector, catalog ones with their card name", async () => {
    mount({
      ok: true,
      available: [
        { service: "gmailuser", name: "GMAIL" },
        { service: "patreon", name: "Patreon" },
      ],
      connected: { gmailuser: "c1", patreon: "c2" },
      accounts: { gmailuser: "Gmail - ada@example.com" },
    });
    await waitFor(() => expect(byId("mcp-abacus-connectors")).not.toBeNull());
    expect(byId("mcp-abacus-connectors")?.textContent).toContain(
      "mcpManagement.abacusConnectors.title:2"
    );
    // The catalog's name, not the platform's shouting one.
    expect(byId("mcp-abacus-connector-gmailuser")?.textContent).toBe("Gmail");
    expect(byId("mcp-abacus-connector-gmailuser")?.title).toBe(
      "Gmail - ada@example.com"
    );
    // Attached from ChatLLM, unknown to the catalog: the platform's name.
    expect(byId("mcp-abacus-connector-patreon")?.textContent).toBe("Patreon");
  });

  it("says none are attached when the listing is real and empty", async () => {
    mount({ ok: true, available: [], connected: {}, accounts: {} });
    await waitFor(() =>
      expect(byId("mcp-abacus-connectors-none")).not.toBeNull()
    );
  });

  it("does not call an unreadable listing empty", async () => {
    mount({
      ok: false,
      error: "not-signed-in",
      available: [],
      connected: {},
      accounts: {},
    });
    await waitFor(() =>
      expect(byId("mcp-abacus-connectors-unavailable")).not.toBeNull()
    );
    expect(byId("mcp-abacus-connectors-none")).toBeNull();
  });
});

describe("connectedRows", () => {
  it("keeps the catalog order, then the unknown ones by name", () => {
    const rows = connectedRows(new Set(["zzz", "slack", "gmailuser"]), {
      zzz: "Zed",
    });
    expect(rows.map((row) => row.service)).toEqual([
      "gmailuser",
      "slack",
      "zzz",
    ]);
    expect(rows.at(-1)?.name).toBe("Zed");
    expect(rows.at(-1)?.connector).toBeNull();
  });
});
