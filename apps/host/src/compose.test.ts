import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, expect, it, vi } from "vitest";
const fixture = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "host-compose-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_HOST_MODE = "1";
  delete process.env.ABACUS_API_KEY;
  mkdirSync(join(home, "host-userdata"));
  const config = '{"apiKeys":{"ABACUS_API_KEY":"sentinel"}}\n';
  writeFileSync(join(home, "config.json"), config);
  writeFileSync(
    join(home, "host-userdata/config.json"),
    JSON.stringify({
      localCode: {
        workspaces: [
          { id: "legacy", name: "Legacy", path: home, description: home },
        ],
        agentSessions: [],
        activeWorkspaceId: "legacy",
      },
    })
  );
  return { home, config };
});
import { connectInProcess } from "#main/rpc/testing";

import { composeNodeHost } from "./compose";
import Store from "./store";
import { HostUnsupportedError } from "./unsupported";

// A real service composition and a memory transport isolate only the machine and network.
it("initializes and starts under the shim; migrates workspace stores without touching bot config", async () => {
  // The sentinel is a filesystem assertion, not a credential for network work.
  const configPath = join(fixture.home, "config.json");
  const original = readFileSync(configPath, "utf8");
  const host = await composeNodeHost();
  const transport = connectInProcess(host.deps, {
    platform: "web-host",
    webContentsId: null,
    windowKind: "web",
  });
  try {
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const migrated = JSON.parse(
      readFileSync(join(fixture.home, "local-code.json"), "utf8")
    );
    expect(migrated.localCode.workspaces[0].id).toBe("legacy");
    expect(migrated.migrated_from_default_v1).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(fixture.home, "host-userdata/config.json"), "utf8")
      ).localCode
    ).toEqual({});
    expect(await transport.client.system.info()).toMatchObject({
      platform: "linux",
    });
    expect(await transport.client.account.state()).toHaveProperty("onboarded");
    expect(await transport.client.update.status()).toMatchObject({
      checking: false,
    });
    await transport.client.system.activity();
    expect(host.lease.lastActivityAt).toBeGreaterThan(0);
    for (const service of ["render_document", "render_deck", "render_design"])
      await expect(
        host.serviceHost.runAgentHostService(service, {})
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    for (const service of [
      "document_templates",
      "design_catalog",
      "deck_templates",
    ])
      await expect(
        host.serviceHost.runAgentHostService(service, {})
      ).resolves.toBeDefined();
    await expect(
      host.serviceHost.runAgentHostService("deck_slots", {
        template: "nonexistent",
      })
    ).rejects.not.toBeInstanceOf(HostUnsupportedError);
    await expect(
      host.serviceHost.mcpOAuthSignIn({ mode: "code", name: "x" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      host.serviceHost.importMcpServers({ mode: "code", source: "file" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      host.serviceHost.skillsService.openFile({ path: "/tmp/x" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(host.serviceHost.clearBrowserData()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(() => host.serviceHost.listBrowserProfiles()).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED" })
    );
    vi.stubGlobal(
      "fetch",
      async () => new Response("offline", { status: 403 })
    );
    await expect(
      transport.client.auth.abacus.signOut({ keepOtherApiKeys: true })
    ).resolves.toMatchObject({ removedProviders: [] });
    expect(
      JSON.parse(readFileSync(configPath, "utf8")).apiKeys.ABACUS_API_KEY
    ).toBeUndefined();
  } finally {
    transport.closeClient();
    transport.closeServer();
    await host.dispose();
    vi.unstubAllGlobals();
  }
}, 20_000);
it("conf preserves dotted keys, defaults, deletion and a separate userData default store", () => {
  const store = new Store<Record<string, unknown>>({
    name: "store-test",
    defaults: { enabled: true },
    clearInvalidConfig: true,
  });
  expect(store.get("enabled")).toBe(true);
  store.set("nested.key", "value");
  expect(store.get("nested.key")).toBe("value");
  store.delete("nested.key");
  expect(store.get("nested.key", "fallback")).toBe("fallback");
  expect(store.path).toBe(join(fixture.home, "host-userdata/store-test.json"));
});
afterAll(() => {
  rmSync(fixture.home, { recursive: true, force: true });
});
