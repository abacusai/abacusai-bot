/**
 * The credential deny-list: which paths are hidden, which are read back, and
 * how the two backends express it. The confinement itself is checked against
 * the real kernel in sandbox.test.ts.
 */
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { SandboxApprovals } from "./approvals.js";
import {
  isWithin,
  mentionedSecretPaths,
  namedSecretPaths,
  readableExemptions,
  resolveSecretPaths,
  secretEntries,
} from "./secrets.js";

const home = "/home/dev";

/** A fake filesystem: directories map to their entries, files to null. */
function fakeFs(tree: Record<string, string[] | null>) {
  const exists = (candidate: string): boolean => candidate in tree;
  const isDirectory = (candidate: string): boolean =>
    Array.isArray(tree[candidate]);
  const list = (dir: string): string[] => tree[dir] ?? [];

  return { exists, isDirectory, list };
}

function resolve(
  tree: Record<string, string[] | null>,
  overrides: Partial<Parameters<typeof resolveSecretPaths>[0]> = {}
) {
  return resolveSecretPaths({
    home,
    workspaceRoot: "/home/dev/project",
    exemptions: [],
    platform: "linux",
    env: {},
    ...fakeFs(tree),
    ...overrides,
  });
}

describe("the deny-list", () => {
  it("names only paths that exist on this machine", () => {
    const result = resolve({
      "/home/dev/.netrc": null,
      "/home/dev/.aws/credentials": null,
    });
    expect(result.denied).toEqual([
      "/home/dev/.aws/credentials",
      "/home/dev/.netrc",
    ]);
    expect(result.allowed).toEqual([]);
  });

  it("hides ~/.ssh but reads config, known hosts and public keys back", () => {
    const result = resolve({
      "/home/dev/.ssh": [
        "config",
        "id_ed25519",
        "id_ed25519.pub",
        "known_hosts",
        "known_hosts.old",
        "sockets",
      ],
      "/home/dev/.ssh/config": null,
      "/home/dev/.ssh/id_ed25519": null,
      "/home/dev/.ssh/id_ed25519.pub": null,
      "/home/dev/.ssh/known_hosts": null,
      "/home/dev/.ssh/known_hosts.old": null,
      "/home/dev/.ssh/sockets": [],
    });
    expect(result.denied).toEqual(["/home/dev/.ssh"]);
    expect(result.allowed).toEqual([
      "/home/dev/.ssh/config",
      "/home/dev/.ssh/id_ed25519.pub",
      "/home/dev/.ssh/known_hosts",
      "/home/dev/.ssh/known_hosts.old",
    ]);
  });

  it("does not read a directory back even when its name matches", () => {
    // A directory called config would be bound back whole otherwise.
    const result = resolve({
      "/home/dev/.ssh": ["config"],
      "/home/dev/.ssh/config": [],
    });
    expect(result.allowed).toEqual([]);
  });

  it("skips a denied path that contains the workspace", () => {
    const result = resolve(
      { "/home/dev/.ssh": ["id_rsa"], "/home/dev/.ssh/id_rsa": null },
      { workspaceRoot: "/home/dev/.ssh" }
    );
    expect(result.denied).toEqual([]);
  });

  it("reads an exempted file back from inside a hidden directory", () => {
    const result = resolve(
      {
        "/home/dev/.ssh": ["id_rsa", "id_dsa"],
        "/home/dev/.ssh/id_rsa": null,
        "/home/dev/.ssh/id_dsa": null,
      },
      { exemptions: ["/home/dev/.ssh/id_rsa"] }
    );
    expect(result.denied).toEqual(["/home/dev/.ssh"]);
    expect(result.allowed).toEqual(["/home/dev/.ssh/id_rsa"]);
  });

  it("skips anything under an exemption", () => {
    const result = resolve(
      {
        "/home/dev/.ssh": [],
        "/home/dev/.aws/credentials": null,
        "/home/dev/.aws/sso/cache": [],
      },
      { exemptions: ["/home/dev/.aws"] }
    );
    expect(result.denied).toEqual(["/home/dev/.ssh"]);
  });

  it("hides this app's own settings wherever ABACUSAI_BOT_HOME points", () => {
    const result = resolve(
      { "/srv/bot/config.json": null, "/srv/bot/electron": [] },
      { env: { ABACUSAI_BOT_HOME: "/srv/bot" } }
    );
    expect(result.denied).toEqual([
      "/srv/bot/config.json",
      "/srv/bot/electron",
    ]);
  });

  it("lists macOS keychain and browser stores only on macOS", () => {
    const mac = secretEntries(home, "darwin", {}).map((entry) => entry.path);
    const linux = secretEntries(home, "linux", {}).map((entry) => entry.path);
    expect(mac).toContain(path.join(home, "Library", "Keychains"));
    expect(linux).not.toContain(path.join(home, "Library", "Keychains"));
    expect(linux).toContain(path.join(home, ".mozilla"));
  });

  it("never denies a configuration file next to a credential", () => {
    const paths = secretEntries(home, "linux", {}).map((entry) => entry.path);
    expect(paths).not.toContain(path.join(home, ".aws", "config"));
    expect(paths).not.toContain(path.join(home, ".gnupg"));
    expect(paths).not.toContain(path.join(home, ".config", "gcloud"));
  });
});

describe("exemptions", () => {
  it("are empty when the variable is unset", () => {
    expect(readableExemptions({}, home)).toEqual([]);
  });

  it("split on the platform delimiter and expand ~", () => {
    const value = ["~/.ssh", "/opt/creds", " ", "~"].join(path.delimiter);
    expect(
      readableExemptions({ ABACUSAI_BOT_SANDBOX_READABLE: value }, home)
    ).toEqual([path.join(home, ".ssh"), path.resolve("/opt/creds"), home]);
  });
});

describe("isWithin", () => {
  it("treats a path as within itself and its ancestors only", () => {
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(isWithin("/a", "/a/b")).toBe(false);
  });
});

describe("stores a command names", () => {
  const promptable = ["/home/dev/.ssh", "/home/dev/.netrc"];
  const named = (command: string, cwd = "/home/dev/project"): string[] =>
    namedSecretPaths(command, { cwd, promptable, home: "/home/dev" });

  it("finds a store spelled with ~, absolutely, or relative to cwd", () => {
    expect(named("cat ~/.ssh/id_ed25519")).toEqual([
      "/home/dev/.ssh/id_ed25519",
    ]);
    expect(named("cat /home/dev/.netrc")).toEqual(["/home/dev/.netrc"]);
    expect(named("cat .ssh/id_rsa", "/home/dev")).toEqual([
      "/home/dev/.ssh/id_rsa",
    ]);
  });

  it("treats a glob as naming the directory it lives in", () => {
    expect(named("cat ~/.ssh/*")).toEqual(["/home/dev/.ssh"]);
  });

  it("sees through quotes and key=value flags", () => {
    expect(named(`cat "~/.ssh/id_ed25519"`)).toEqual([
      "/home/dev/.ssh/id_ed25519",
    ]);
    expect(named("scp -i ~/.ssh/id_rsa a b")).toEqual([
      "/home/dev/.ssh/id_rsa",
    ]);
    expect(named("ssh --identity=~/.ssh/id_rsa host")).toEqual([
      "/home/dev/.ssh/id_rsa",
    ]);
  });

  it("ignores paths beside a store and files read back from it", () => {
    // The gate asks only about the hidden part; config is readable anyway.
    expect(named("cat ~/.ssh/config")).toEqual(["/home/dev/.ssh/config"]);
    expect(named("cat ~/.sshx/key ~/.bashrc /etc/hosts")).toEqual([]);
  });

  it("does not name a store a command reaches without naming it", () => {
    // Left to the kernel, and the failure note, on purpose.
    expect(named("tar czf out.tgz ~")).toEqual([]);
    expect(named("cat $HOME/.netrc")).toEqual([]);
  });

  it("is empty when nothing is hidden", () => {
    expect(
      namedSecretPaths("cat ~/.netrc", { cwd: "/", promptable: [] })
    ).toEqual([]);
  });
});

describe("stores a failure mentions", () => {
  it("returns the stores that appear in the output, in list order", () => {
    expect(
      mentionedSecretPaths("cat: /home/dev/.netrc: Operation not permitted", [
        "/home/dev/.ssh",
        "/home/dev/.netrc",
      ])
    ).toEqual(["/home/dev/.netrc"]);
  });
});

describe("approvals", () => {
  it("hand a one-off grant to the next run of that command only", () => {
    const approvals = new SandboxApprovals().reads;
    approvals.approveOnce("cat ~/.netrc", ["/home/dev/.netrc"]);
    expect(approvals.consume("cat ~/.ssh/id_rsa")).toEqual([]);
    expect(approvals.consume("cat ~/.netrc")).toEqual(["/home/dev/.netrc"]);
    expect(approvals.consume("cat ~/.netrc")).toEqual([]);
  });

  it("keep a session grant for every later command", () => {
    const approvals = new SandboxApprovals().reads;
    approvals.approveForSession(["/home/dev/.netrc"]);
    expect(approvals.consume("anything")).toEqual(["/home/dev/.netrc"]);
    expect(approvals.consume("anything else")).toEqual(["/home/dev/.netrc"]);
    expect(approvals.isApprovedForSession("/home/dev/.netrc")).toBe(true);
    expect(approvals.isApprovedForSession("/home/dev/.ssh/id_rsa")).toBe(false);
  });

  it("merge repeated grants without duplicates", () => {
    const approvals = new SandboxApprovals().reads;
    approvals.approveOnce("x", ["/a"]);
    approvals.approveOnce("x", ["/a", "/b"]);
    approvals.approveForSession(["/b", "/c"]);
    approvals.approveForSession(["/c"]);
    expect(approvals.consume("x")).toEqual(["/a", "/b", "/c"]);
    expect(approvals.sessionPaths).toEqual(["/b", "/c"]);
  });
});

describe("a card's answer", () => {
  it("is applied once for the command and for the session as chosen", () => {
    const approvals = new SandboxApprovals();
    approvals.apply("cp secret out", {
      once: [
        { kind: "read", path: "/home/dev/.netrc" },
        { kind: "host", host: "x.test", port: 443 },
      ],
      session: [{ kind: "write", path: "/home/dev/Desktop/out.txt" }],
    });
    expect(approvals.reads.consume("cp secret out")).toEqual([
      "/home/dev/.netrc",
    ]);
    expect(approvals.reads.consume("cp secret out")).toEqual([]);
    expect(approvals.writes.consume("anything")).toEqual([
      "/home/dev/Desktop/out.txt",
    ]);
  });
});

describe("the policy honours an approved read", () => {
  it("drops the approved store from the deny-list for that run", () => {
    const withGrant = resolve(
      { "/home/dev/.netrc": null, "/home/dev/.aws/credentials": null },
      { exemptions: ["/home/dev/.netrc"] }
    );
    expect(withGrant.denied).toEqual(["/home/dev/.aws/credentials"]);
    expect(withGrant.promptable).toEqual(["/home/dev/.aws/credentials"]);
  });

  it("never marks the app's own settings as promptable", () => {
    const result = resolve(
      { "/srv/bot/config.json": null, "/home/dev/.netrc": null },
      { env: { ABACUSAI_BOT_HOME: "/srv/bot" } }
    );
    expect(result.denied).toContain("/srv/bot/config.json");
    expect(result.promptable).toEqual(["/home/dev/.netrc"]);
  });
});
