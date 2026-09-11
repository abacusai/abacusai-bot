import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sandbox: string;
const originalBase = process.env.ABACUSAI_BOT_BASE;
const originalHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "account-profiles-"));
  process.env.ABACUSAI_BOT_BASE = sandbox;
  process.env.ABACUSAI_BOT_HOME = sandbox;
  vi.resetModules();
});

afterEach(() => {
  if (originalBase == null) delete process.env.ABACUSAI_BOT_BASE;
  else process.env.ABACUSAI_BOT_BASE = originalBase;
  if (originalHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("account profile ownership", () => {
  it("prefers stable user and organization ids", async () => {
    const { profileKeyFor } = await import("./profile-home");

    expect(
      profileKeyFor({
        user_id: "User/42",
        organization_id: "Org 9",
        email: "changeable@example.com",
      })
    ).toBe("user-user-42_org-org-9");
  });

  it("falls back to email and organization on older account responses", async () => {
    const { profileKeyFor } = await import("./profile-home");

    expect(
      profileKeyFor({ email: " Ada@Example.com ", organization: "Acme Inc." })
    ).toBe("ada@example.com_acme-inc");
  });

  it("keeps the first account in place and isolates the next account", async () => {
    const { activateProfile } = await import("./profile-home");

    expect(activateProfile("account-a", "key-a")).toBe(false);
    expect(activateProfile("account-b", "key-b")).toBe(true);

    const registry = JSON.parse(
      fs.readFileSync(path.join(sandbox, "profiles.json"), "utf8")
    ) as { active: string; profiles: Record<string, string> };
    expect(registry.profiles).toEqual({
      "account-a": ".",
      "account-b": path.join("profiles", "account-b"),
    });
    const config = JSON.parse(
      fs.readFileSync(
        path.join(sandbox, "profiles", "account-b", "config.json"),
        "utf8"
      )
    ) as { apiKeys: { ABACUS_API_KEY: string } };
    expect(config.apiKeys.ABACUS_API_KEY).toBe("key-b");
  });

  it("restores each account's own chats after switches and relaunches", async () => {
    const { activateProfile, initProfileHome } = await import("./profile-home");
    activateProfile("account-a", "key-a");
    fs.writeFileSync(path.join(sandbox, "sessions.json"), "account-a-chat");

    expect(activateProfile("account-b", "key-b")).toBe(true);
    initProfileHome();
    const accountBHome = path.join(sandbox, "profiles", "account-b");
    expect(process.env.ABACUSAI_BOT_HOME).toBe(accountBHome);
    expect(fs.existsSync(path.join(accountBHome, "sessions.json"))).toBe(false);
    fs.writeFileSync(
      path.join(accountBHome, "sessions.json"),
      "account-b-chat"
    );

    expect(activateProfile("account-a", "key-a-next-login")).toBe(true);
    initProfileHome();
    expect(process.env.ABACUSAI_BOT_HOME).toBe(sandbox);
    expect(fs.readFileSync(path.join(sandbox, "sessions.json"), "utf8")).toBe(
      "account-a-chat"
    );
    expect(
      fs.readFileSync(path.join(accountBHome, "sessions.json"), "utf8")
    ).toBe("account-b-chat");
  });

  it("adopts an email-keyed profile when stable ids appear later", async () => {
    fs.writeFileSync(
      path.join(sandbox, "profiles.json"),
      JSON.stringify({
        active: "ada@example.com_acme",
        profiles: { "ada@example.com_acme": "." },
      })
    );
    const { activateProfile } = await import("./profile-home");

    expect(
      activateProfile("user-42_org-9", "new-key", ["ada@example.com_acme"])
    ).toBe(false);
    const registry = JSON.parse(
      fs.readFileSync(path.join(sandbox, "profiles.json"), "utf8")
    ) as { profiles: Record<string, string> };
    expect(registry.profiles["user-42_org-9"]).toBe(".");
  });

  it("ignores a corrupt registry path outside the app directory", async () => {
    fs.writeFileSync(
      path.join(sandbox, "profiles.json"),
      JSON.stringify({
        active: "bad",
        profiles: { bad: "../../somewhere-else" },
      })
    );
    const { initProfileHome } = await import("./profile-home");

    initProfileHome();

    expect(process.env.ABACUSAI_BOT_HOME).toBe(sandbox);
  });
});
