/**
 * The MCP config files hold the only credential their servers have.
 *
 * The built-in browser, device and agent-tools servers listen on loopback with
 * no authentication of their own. `localMcpServerToken` exists because
 * `tools/call` was otherwise reachable by anything on the machine. The token it
 * mints is written into the runtime config, so that file is the credential. A
 * user config additionally holds whatever a connector needs: a personal access
 * token in a header, an OAuth client secret, API keys in `env`.
 *
 * Written with the default mode they were world-readable, which hands the
 * token to any other account on the box and reopens exactly what it closed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-perms-"));

vi.mock("../../paths", () => ({ abacusBotHome: () => home }));

const { McpConfigService } = await import("./mcp-config-service");

const service = new McpConfigService();

/** The mode bits, as the four digits a human would check. */
const modeOf = (filePath: string): string =>
  (fs.statSync(filePath).mode & 0o777).toString(8).padStart(4, "0");

const configFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) out.push(full);
    }
  };
  walk(home);
  return out;
};

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")(
  "files this service writes",
  () => {
    it("keeps a user server config to the owner", () => {
      // This is where a connector's personal access token lives.
      service.addUserServer("code", "github", {
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_secret_token_value" },
      });

      const written = configFiles();
      expect(written.length).toBeGreaterThan(0);
      for (const file of written) expect(modeOf(file)).toBe("0600");
    });

    it("keeps the desktop state to the owner", () => {
      service.writeState({ builtinBrowserApproval: "always" } as never);

      for (const file of configFiles()) expect(modeOf(file)).toBe("0600");
    });

    it("does not leave a readable temp file behind", () => {
      service.addUserServer("code", "x", { url: "https://x.test/mcp" });

      // The rename carries the temp file's mode, so a temp written 0644 would
      // land 0644 however the target was created.
      expect(configFiles().every((file) => !file.endsWith(".tmp"))).toBe(true);
    });

    it("tightens a file an older build left world-readable", () => {
      // The mode survives a rename onto an existing file, so writing over one is
      // not enough on its own.
      service.addUserServer("code", "first", { url: "https://a.test/mcp" });
      const target = configFiles()[0]!;
      fs.chmodSync(target, 0o644);

      service.addUserServer("code", "second", { url: "https://b.test/mcp" });

      expect(modeOf(target)).toBe("0600");
    });
  }
);
