import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0", userAgentFallback: "" },
}));
vi.mock("../config/settings", () => ({
  readSettings: () => ({ apiKeys: { ABACUS_API_KEY: "abacus-key" } }),
  storedKeyProviders: () => [],
}));
vi.mock("../diagnostics/client-environment", () => ({
  clientEnvironment: () => ({ os_name: "macOS" }),
  safely: <T>(read: () => T) => read(),
}));
vi.mock("./device-id", () => ({ deviceId: () => "device" }));

const { DiagnosticsSyncService } = await import("./diagnostics-sync-service");

describe("the diagnostics snapshot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not carry a token an MCP server quoted in its error", async () => {
    const token = `gh${"p_"}${"a1B2c3D4".repeat(5)}`;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("{}")
    );
    const service = new DiagnosticsSyncService({
      mcpServers: () => [],
      mcpRuntime: () => [
        {
          id: "github",
          status: "failed",
          toolCount: 0,
          error: `401 from https://api.example/x?auth=${token}`,
        },
      ],
      connectors: () => [],
      fetchImpl: fetchImpl as typeof fetch,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(9_000);
    service.stop();

    const body = String(fetchImpl.mock.calls[0]?.[1]?.body);

    expect(body).toContain("mcp_runtime");
    expect(body).not.toContain(token);
  });
});
