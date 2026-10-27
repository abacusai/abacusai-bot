import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { zapierConnectUrl } from "./008-zapier-connect-url";

const OLD_URL = "https://mcp.zapier.com/api/mcp/mcp";
const NEW_URL = "https://mcp.zapier.com/api/v1/connect";

it("moves Zapier servers and their token to the connect URL, once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zapier-connect-url-"));
  try {
    const other = { url: "https://example.com/mcp", oauth: false };
    fs.writeFileSync(
      path.join(root, "mcp-code.json"),
      JSON.stringify({ mcpServers: { zapier: { url: OLD_URL }, other } })
    );
    const token = {
      tokenEndpoint: "https://t",
      clientId: "c",
      accessToken: "a",
    };
    fs.writeFileSync(
      path.join(root, "mcp-auth.json"),
      JSON.stringify({ servers: { [OLD_URL]: token }, clients: { i: {} } })
    );
    const ctx = {
      home: root,
      userData: root,
      appVersion: "test",
      staging: path.join(root, "staging"),
      progress: () => {},
      log: () => {},
    };
    const plan = await zapierConnectUrl().plan(ctx);
    expect(plan.writes.map((w) => path.basename(w.dest)).sort()).toEqual([
      "mcp-auth.json",
      "mcp-code.json",
    ]);
    for (const write of plan.writes) {
      expect(write.kind).toBe("replace-user");
      fs.copyFileSync(write.staged, write.dest);
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(root, "mcp-code.json"), "utf8")
    );
    expect(config.mcpServers).toEqual({ zapier: { url: NEW_URL }, other });
    const auth = JSON.parse(
      fs.readFileSync(path.join(root, "mcp-auth.json"), "utf8")
    );
    expect(auth).toEqual({ servers: { [NEW_URL]: token }, clients: { i: {} } });
    expect((await zapierConnectUrl().plan(ctx)).writes).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a token already signed in at the connect URL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zapier-connect-url-"));
  try {
    const newer = {
      tokenEndpoint: "https://t",
      clientId: "c",
      accessToken: "n",
    };
    fs.writeFileSync(
      path.join(root, "mcp-auth.json"),
      JSON.stringify({
        servers: {
          [OLD_URL]: { ...newer, accessToken: "o" },
          [NEW_URL]: newer,
        },
      })
    );
    const ctx = {
      home: root,
      userData: root,
      appVersion: "test",
      staging: path.join(root, "staging"),
      progress: () => {},
      log: () => {},
    };
    const [write] = (await zapierConnectUrl().plan(ctx)).writes;
    expect(JSON.parse(fs.readFileSync(write!.staged, "utf8"))).toEqual({
      servers: { [NEW_URL]: newer },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
