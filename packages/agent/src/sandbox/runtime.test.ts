/**
 * The mapping from a SandboxPolicy onto the sandbox runtime's config. The
 * runtime itself is exercised against the real kernel in sandbox.test.ts.
 */
import { describe, expect, it } from "vitest";

import type { SandboxPolicy } from "./policy.js";
import {
  agentSockets,
  baseConfig,
  commandConfig,
  configuredHosts,
  DEFAULT_HOSTS,
} from "./runtime.js";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    mode: "workspace-write",
    enforcement: "auto",
    workspaceRoot: "/work/repo",
    writableTemp: ["/private/tmp", "/private/var/folders/x/T"],
    secrets: {
      denied: ["/Users/dev/.ssh", "/Users/dev/.netrc"],
      allowed: ["/Users/dev/.ssh/config"],
      promptable: ["/Users/dev/.ssh", "/Users/dev/.netrc"],
    },
    network: { kind: "filtered" },
    ...overrides,
  };
}

describe("the per-process config", () => {
  it("lists the registries and code hosts, and asks about everything else", () => {
    const config = baseConfig(DEFAULT_HOSTS, []);
    expect(config.network.allowedDomains).toContain("registry.npmjs.org");
    expect(config.network.allowedDomains).toContain("*.githubusercontent.com");
    expect(config.network.deniedDomains).toEqual([]);
    // No strictAllowlist: an unlisted host reaches the ask callback.
    expect(config.network.strictAllowlist).toBeUndefined();
  });

  it("keeps loopback direct so a dev server the command starts answers", () => {
    expect(baseConfig([], []).network.allowLocalBinding).toBe(true);
  });

  it("opens only the agent sockets, never all of them", () => {
    const config = baseConfig([], ["/tmp/agent.sock"]);
    expect(config.network.allowUnixSockets).toEqual(["/tmp/agent.sock"]);
    expect(config.network.allowAllUnixSockets).toBe(false);
  });

  it("finds the ssh and gpg agent sockets that exist", () => {
    const exists = (candidate: string): boolean =>
      candidate === "/run/user/1000/keyring/ssh" ||
      candidate === "/home/dev/.gnupg";
    expect(
      agentSockets(
        {
          SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
        "/home/dev",
        exists
      )
    ).toEqual(["/run/user/1000/keyring/ssh", "/home/dev/.gnupg"]);
    expect(agentSockets({}, "/home/dev", () => false)).toEqual([]);
  });

  it("reads extra hosts from the environment", () => {
    expect(
      configuredHosts({ ABACUSAI_BOT_SANDBOX_HOSTS: " a.test, *.b.test ,, " })
    ).toEqual(["a.test", "*.b.test"]);
    expect(configuredHosts({})).toEqual([]);
  });
});

describe("the per-command config", () => {
  it("hides the stores, reads the exceptions back, writes the workspace and temp", () => {
    expect(commandConfig(policy()).filesystem).toEqual({
      denyRead: ["/Users/dev/.ssh", "/Users/dev/.netrc"],
      allowRead: ["/Users/dev/.ssh/config"],
      allowWrite: ["/work/repo", "/private/tmp", "/private/var/folders/x/T"],
      denyWrite: [],
    });
  });

  it("keeps the workspace read-only in read-only mode, temp still writable", () => {
    expect(
      commandConfig(policy({ mode: "read-only" })).filesystem?.allowWrite
    ).toEqual(["/private/tmp", "/private/var/folders/x/T"]);
  });
});
