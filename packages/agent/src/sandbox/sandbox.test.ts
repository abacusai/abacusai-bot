/**
 * The sandbox, at two levels.
 *
 * The pure parts — mode mapping, the decision table — are tested everywhere.
 * The confinement itself is tested against the real kernel through the
 * sandbox runtime, and only where it can run: a test that quietly passes on
 * the wrong platform is worse than one that skips, so a machine with no
 * usable backend skips the live sections rather than inventing a verdict.
 *
 * The live section includes the escape a security review found in the first
 * version of this code — an app bundle written into the writable workspace and
 * started through LaunchServices, which runs outside the sandbox entirely.
 * That is here as a regression test: a sandbox with no test that tries to
 * break out is a sandbox that quietly stops working.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AgentMode } from "../protocol.js";
import { backendName, decide, unavailableBackendMessage } from "./index.js";
import { classifyCommand } from "./intent.js";
import {
  canonicalize,
  modeToSandboxMode,
  resolvePolicy,
  sandboxEnforcement,
  type SandboxPolicy,
} from "./policy.js";
import { setHostDecider } from "./runtime.js";
import { resolveSecretPaths } from "./secrets.js";

const onMac = process.platform === "darwin";
const onRuntime = backendName() === "sandbox-runtime";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    mode: "workspace-write",
    enforcement: "auto",
    workspaceRoot: "/tmp/ws",
    writableTemp: ["/private/tmp"],
    toolHomes: [],
    secrets: { denied: [], allowed: [], promptable: [] },
    approvedWrites: [],
    network: { kind: "filtered" },
    ...overrides,
  };
}

/**
 * Exit code of `argv`, run asynchronously: the runtime's proxies live in this
 * process's event loop, and a synchronous spawn would starve them.
 */
function exitCode(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd, timeout: 60_000, env }, (error) =>
      resolve(error == null ? 0 : ((error as { code?: number }).code ?? 1))
    );
  });
}

describe("mode mapping", () => {
  it("follows the permission mode rather than adding a second control", () => {
    expect(modeToSandboxMode(AgentMode.PlanMode)).toBe("read-only");
    expect(modeToSandboxMode(AgentMode.Normal)).toBe("workspace-write");
    expect(modeToSandboxMode(AgentMode.AcceptEdits)).toBe("workspace-write");
    // Auto turns the asking off, not the kernel: it is where the bounds
    // matter most.
    expect(modeToSandboxMode(AgentMode.Auto)).toBe("workspace-write");
  });

  it("switches the sandbox off for Full access, and only for Full access", () => {
    for (const mode of [
      AgentMode.Normal,
      AgentMode.AcceptEdits,
      AgentMode.PlanMode,
      AgentMode.Auto,
    ]) {
      expect(resolvePolicy(mode, "/tmp").enforcement, mode).toBe("auto");
    }
    expect(resolvePolicy(AgentMode.Yolo, "/tmp").enforcement).toBe("off");
  });

  it("canonicalizes the workspace, because the kernel matches resolved paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-canon-"));
    try {
      const resolved = canonicalize(dir);
      expect(path.isAbsolute(resolved)).toBe(true);
      // On macOS /tmp IS /private/tmp; a profile naming the symlink grants
      // nothing.
      if (onMac) expect(resolved.startsWith("/private/")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still produces a policy for a path that does not exist yet", () => {
    // `mkdir && cd` patterns would break if an unresolvable path threw.
    const resolved = resolvePolicy(
      AgentMode.Normal,
      "/tmp/does-not-exist-yet-12345"
    );
    expect(resolved.workspaceRoot).toContain("does-not-exist-yet-12345");
  });

  it("filters the network only when the backend can", () => {
    expect(resolvePolicy(AgentMode.Normal, "/tmp").network).toEqual({
      kind: "open",
    });
    expect(
      resolvePolicy(AgentMode.Normal, "/tmp", { filteredNetwork: true }).network
    ).toEqual({ kind: "filtered" });
  });
});

describe("the decision table", () => {
  it("does not confine when the sandbox is switched off", async () => {
    expect(
      (await decide(policy({ enforcement: "off" }), "ls", "/tmp/ws")).kind
    ).toBe("unconfined");
  });

  it("under strict, refuses rather than running unconfined when the backend cannot start", async () => {
    if (backendName() === null) return;
    const decision = await decide(
      policy({ enforcement: "strict" }),
      "echo hi",
      "/tmp/ws"
    );
    // A working backend confines; a broken one refuses. Never a bare run.
    expect(decision.kind).not.toBe("unconfined");
  });

  it("under auto, runs unconfined and says why when the backend cannot start", async () => {
    if (backendName() === null) return;
    const decision = await decide(policy(), "echo hi", "/tmp/ws");
    // Whichever this machine is, the answer is one of the two honest ones.
    expect(["confined", "unconfined"]).toContain(decision.kind);
    if (decision.kind === "unconfined")
      expect(decision.reason).toBe("backend-unavailable");
  });

  it("refuses rather than running unconfined when strict has no backend", async () => {
    if (backendName() !== null) return;
    const decision = await decide(
      policy({ enforcement: "strict" }),
      "echo hi",
      "/tmp/ws"
    );
    expect(decision.kind).toBe("refused");
  });

  it("runs unconfined under auto where no backend exists", async () => {
    if (backendName() !== null) return;
    expect((await decide(policy(), "echo hi", "/tmp/ws")).kind).toBe(
      "unconfined"
    );
  });

  it("does not tell the model to give up, since a later attempt may work", () => {
    // A probe that ran out of time is deliberately left uncached so the next
    // command tries again; a refusal saying "do not retry" contradicts that.
    for (const backend of ["sandbox-runtime", "mxc"] as const) {
      const message = unavailableBackendMessage(backend, "bwrap not installed");

      expect(message).not.toContain("do not retry");
      expect(message).toContain("retry is reasonable");
      expect(message).toContain("must not be worked around");
      expect(message).toContain("bwrap not installed");
    }
  });
});

// ---------------------------------------------------------------------------
// Live confinement through the runtime, where it can run at all.
// ---------------------------------------------------------------------------

describe.runIf(onRuntime)("confinement against the real kernel", () => {
  let workspace: string;
  let outsideDir: string;
  let outside: string;
  /** False when the runtime cannot start here (no bwrap on a Linux runner). */
  let usable = true;

  beforeAll(async () => {
    setHostDecider(async () => false);
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-live-"))
    );
    outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-out-"))
    );
    outside = path.join(outsideDir, "should-not-exist.txt");
    const decision = await decide(
      policy({ workspaceRoot: workspace }),
      "true",
      workspace
    );
    usable = decision.kind === "confined";
  }, 120_000);

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  /** Exit code under the policy the given mode would produce. */
  async function run(
    command: string,
    mode: SandboxPolicy["mode"] = "workspace-write"
  ): Promise<number> {
    // /tmp only: the workspace and the outside file both live under the OS
    // temp directory, which must therefore stay unwritable here.
    const decision = await decide(
      policy({
        mode,
        workspaceRoot: workspace,
        writableTemp: [canonicalize("/tmp")],
        toolHomes: [],
      }),
      command,
      workspace
    );
    if (decision.kind !== "confined")
      throw new Error(`expected confinement, got ${decision.kind}`);

    return exitCode(decision.argv, workspace);
  }

  it("permits a write inside the workspace", async () => {
    if (!usable) return;
    expect(await run("echo written > inside.txt")).toBe(0);
    expect(fs.existsSync(path.join(workspace, "inside.txt"))).toBe(true);
  });

  it("refuses a write outside it, and leaves no file behind", async () => {
    if (!usable) return;
    fs.rmSync(outside, { force: true });
    expect(await run(`echo pwned > ${JSON.stringify(outside)}`)).not.toBe(0);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("leaves reads alone", async () => {
    if (!usable) return;
    expect(await run("ls / > /dev/null && cat /etc/hosts > /dev/null")).toBe(0);
  });

  it("does not break an ordinary toolchain", async () => {
    if (!usable) return;
    // A sandbox that blocks compilers gets switched off, which protects nobody.
    expect(
      await run(
        "node --version > /dev/null && git --version > /dev/null && git init -q"
      )
    ).toBe(0);
  });

  it("blocks writes to the workspace itself in read-only mode", async () => {
    if (!usable) return;
    expect(await run("echo nope > ro.txt", "read-only")).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, "ro.txt"))).toBe(false);
  });

  it("still allows a write to temp in read-only mode", async () => {
    if (!usable) return;
    // Plan mode is read-only for the workspace but must keep a writable
    // scratch, or ordinary tools that touch a temp file fail outright.
    const target = path.join(
      canonicalize("/tmp"),
      `sbx-ro-${process.pid}-${Date.now()}.txt`
    );
    fs.rmSync(target, { force: true });
    expect(await run(`echo ok > ${JSON.stringify(target)}`, "read-only")).toBe(
      0
    );
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(target, { force: true });
  });

  describe("evasions that defeat pattern matching", () => {
    // Each of these gets past a regex deny-list. None of them gets past the
    // kernel — which is the entire argument for having a sandbox at all.
    it.each([
      [
        "a base64-decoded script",
        (out: string) =>
          `echo ${Buffer.from(`echo pwned > ${out}`).toString("base64")} | base64 -d | bash`,
      ],
      [
        "a heredoc written to a file and run",
        (out: string) =>
          `cat <<'EOS' > s.sh\necho pwned > ${out}\nEOS\nbash s.sh`,
      ],
      ["tee", (out: string) => `echo pwned | tee ${out}`],
      [
        "python",
        (out: string) => `python3 -c "open('${out}','w').write('pwned')"`,
      ],
    ])("cannot write outside via %s", async (_label, build) => {
      if (!usable) return;
      fs.rmSync(outside, { force: true });
      await run(build(outside));
      expect(fs.existsSync(outside)).toBe(false);
    });
  });

  describe.runIf(onMac)("the LaunchServices escape", () => {
    // Regression test for the hole the review found: Seatbelt is inherited
    // across fork and exec, but a process launchd starts on our behalf is not
    // a child and begins with no sandbox at all.
    //
    // The positive control below is what makes this test worth having. An
    // assertion that a file did NOT appear passes for every reason the escape
    // failed to be attempted at all — no Aqua session on a CI runner, a slow
    // machine, LaunchServices declining the bundle. So we first prove the
    // bundle DOES run when nothing is stopping it.
    let launchWorks = false;

    function buildAppBundle(name: string): string {
      const app = path.join(workspace, `${name}.app`);
      fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
      fs.writeFileSync(
        path.join(app, "Contents/Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>esc</string>
<key>CFBundleIdentifier</key><string>com.abacusai.sandboxtest.${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`
      );
      const exe = path.join(app, "Contents/MacOS/esc");
      fs.writeFileSync(exe, `#!/bin/bash\necho ESCAPED > ${outside}\n`);
      fs.chmodSync(exe, 0o755);

      return app;
    }

    /** Wait for the payload, rather than assuming a fixed delay is enough. */
    async function payloadLanded(timeoutMs = 8_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (fs.existsSync(outside)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      return false;
    }

    beforeAll(async () => {
      // The control: launch the bundle with no sandbox at all. If this does
      // not fire, LaunchServices is unavailable here and the confinement
      // assertions below would be vacuous.
      const app = buildAppBundle("Control");
      fs.rmSync(outside, { force: true });
      try {
        execFileSync("/usr/bin/open", ["-g", app], {
          stdio: "ignore",
          timeout: 20_000,
        });
      } catch {
        // Fall through — payloadLanded decides.
      }
      launchWorks = await payloadLanded();
      fs.rmSync(outside, { force: true });
    });

    it("can launch a bundle at all when nothing is stopping it", () => {
      // Not a security assertion. It is the guard that stops the two tests
      // below from passing for the wrong reason.
      expect(
        launchWorks,
        "LaunchServices could not launch a test bundle, so the escape tests below prove nothing here"
      ).toBe(true);
    });

    it("cannot escape by asking launchd to run a bundle from the workspace", async () => {
      if (!launchWorks || !usable) return;
      const app = buildAppBundle("Esc");
      fs.rmSync(outside, { force: true });

      await run(`open -g ${JSON.stringify(app)}`);

      expect(await payloadLanded()).toBe(false);
    });

    it("cannot escape with a copied binary either", async () => {
      // Copying defeats any rule that names /usr/bin/open, so this is the
      // case only the Mach service denial can stop.
      if (!launchWorks || !usable) return;
      const app = buildAppBundle("Copied");
      fs.rmSync(outside, { force: true });

      await run(
        `cp /usr/bin/open ./myopen 2>/dev/null; ./myopen -g ${JSON.stringify(app)}`
      );

      expect(await payloadLanded()).toBe(false);
    });

    afterAll(() => {
      // Leave no bundle registered with LaunchServices. A stale registration
      // means any account that later recreates the path gets a bundle
      // launchable by id.
      const lsregister =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      for (const name of ["Control", "Esc", "Copied"]) {
        try {
          execFileSync(
            lsregister,
            ["-u", path.join(workspace, `${name}.app`)],
            { stdio: "ignore", timeout: 10_000 }
          );
        } catch {
          // Best effort; the bundle directory goes with the temp workspace.
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Live credential hiding. A fake home stands in for the real one so the test
// never touches actual keys.
// ---------------------------------------------------------------------------

describe.runIf(onRuntime)("credential stores against the real kernel", () => {
  let workspace: string;
  let home: string;
  let key: string;
  let config: string;
  let netrc: string;
  let usable = true;

  beforeAll(async () => {
    setHostDecider(async () => false);
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-secret-ws-"))
    );
    home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-secret-home-"))
    );
    fs.mkdirSync(path.join(home, ".ssh"));
    key = path.join(home, ".ssh", "id_ed25519");
    config = path.join(home, ".ssh", "config");
    netrc = path.join(home, ".netrc");
    fs.writeFileSync(key, "PRIVATE\n");
    fs.writeFileSync(config, "Host example\n");
    fs.writeFileSync(netrc, "password hunter2\n");
    usable =
      (await decide(policy({ workspaceRoot: workspace }), "true", workspace))
        .kind === "confined";
  }, 120_000);

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function run(
    command: string,
    approved: string[] = []
  ): Promise<number> {
    const decision = await decide(
      policy({
        workspaceRoot: workspace,
        writableTemp: [canonicalize(os.tmpdir())],
        toolHomes: [],
        secrets: resolveSecretPaths({
          home,
          workspaceRoot: workspace,
          exemptions: approved,
        }),
      }),
      command,
      workspace
    );
    if (decision.kind !== "confined")
      throw new Error(`expected confinement, got ${decision.kind}`);

    return exitCode(decision.argv, workspace);
  }

  it("cannot read a private key", async () => {
    if (!usable) return;
    expect(await run(`grep -q PRIVATE ${JSON.stringify(key)}`)).not.toBe(0);
  });

  it("cannot read a credential file", async () => {
    if (!usable) return;
    expect(await run(`grep -q hunter2 ${JSON.stringify(netrc)}`)).not.toBe(0);
  });

  it("still reads the ssh config beside the key", async () => {
    if (!usable) return;
    expect(await run(`grep -q example ${JSON.stringify(config)}`)).toBe(0);
  });

  it("reads the key once the user approved it on the card", async () => {
    if (!usable) return;
    expect(await run(`grep -q PRIVATE ${JSON.stringify(key)}`, [key])).toBe(0);
  });

  it("cannot get around it by copying into the workspace", async () => {
    if (!usable) return;
    expect(
      await run(
        `cp ${JSON.stringify(key)} ./stolen && grep -q PRIVATE ./stolen`
      )
    ).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Outbound network through the runtime's proxies.
// ---------------------------------------------------------------------------

describe.runIf(onRuntime)("egress against the real kernel", () => {
  let workspace: string;
  let origin: http.Server;
  let originPort: number;
  const asked: string[] = [];
  let usable = true;

  beforeAll(async () => {
    setHostDecider(async (host) => {
      asked.push(host);

      return false;
    });
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-egress-"))
    );
    origin = http.createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", () => resolve())
    );
    originPort = (origin.address() as net.AddressInfo).port;
    usable =
      (await decide(policy({ workspaceRoot: workspace }), "true", workspace))
        .kind === "confined";
  }, 120_000);

  afterAll(() => {
    origin.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function run(command: string): Promise<number> {
    const decision = await decide(
      policy({
        workspaceRoot: workspace,
        writableTemp: [canonicalize(os.tmpdir())],
        toolHomes: [],
      }),
      command,
      workspace
    );
    if (decision.kind !== "confined")
      throw new Error(`expected confinement, got ${decision.kind}`);

    return exitCode(decision.argv, workspace);
  }

  it("cannot reach the network directly, even when told not to use the proxy", async () => {
    if (!usable) return;
    // curl 6 or 7: no resolution, no connection. Refused before any packet
    // leaves, so this needs no internet to be meaningful.
    expect([6, 7]).toContain(
      await run("curl -sf --noproxy '*' --max-time 10 http://example.com/")
    );
  });

  it("asks about a host nobody listed, and refuses when the answer is no", async () => {
    if (!usable) return;
    // curl 22: an HTTP error, the proxy's 403.
    expect(await run("curl -sf --max-time 10 http://example.com/")).toBe(22);
    expect(asked).toContain("example.com");
  });

  it("still reaches a server on loopback", async () => {
    if (!usable) return;
    expect(
      await run(
        `curl -sf --noproxy '*' --max-time 10 http://127.0.0.1:${originPort}/`
      )
    ).toBe(0);
  });
});

/**
 * The default, which nothing pinned before.
 *
 * It is the whole contract of this switch: on unless Full access or the
 * environment says otherwise, so a change of heart about it has to be
 * deliberate rather than a one-word edit that no test notices.
 */
describe("enforcement default", () => {
  const previous = process.env.ABACUSAI_BOT_SANDBOX;

  afterEach(() => {
    if (previous == null) delete process.env.ABACUSAI_BOT_SANDBOX;
    else process.env.ABACUSAI_BOT_SANDBOX = previous;
  });

  it("is on when nothing sets it", () => {
    delete process.env.ABACUSAI_BOT_SANDBOX;
    expect(sandboxEnforcement()).toBe("auto");
  });

  it("stays on for a value it does not recognise, rather than guessing", () => {
    process.env.ABACUSAI_BOT_SANDBOX = "yes please";
    expect(sandboxEnforcement()).toBe("auto");
  });

  it("turns off for the plain spellings of off", () => {
    for (const value of ["off", "0", "false", "OFF"]) {
      process.env.ABACUSAI_BOT_SANDBOX = value;
      expect(sandboxEnforcement()).toBe("off");
    }
  });

  it("still honours strict, which refuses rather than degrades", () => {
    process.env.ABACUSAI_BOT_SANDBOX = "strict";
    expect(sandboxEnforcement()).toBe("strict");
  });

  it("Full access wins over the environment, since the user chose it", () => {
    process.env.ABACUSAI_BOT_SANDBOX = "strict";
    expect(sandboxEnforcement(AgentMode.Yolo)).toBe("off");
  });

  it("an unconfined decision follows from Full access alone", async () => {
    delete process.env.ABACUSAI_BOT_SANDBOX;
    const resolved = resolvePolicy(AgentMode.Yolo, "/tmp");
    expect(await decide(resolved, "echo hi", "/tmp")).toEqual({
      kind: "unconfined",
      reason: "mode",
    });
  });
});

// ---------------------------------------------------------------------------
// The pre-grant, through the real kernel: what the classifier lets through
// must actually work, and what it withholds must actually be refused.
// ---------------------------------------------------------------------------

describe.runIf(onRuntime)("pre-granted writes against the real kernel", () => {
  let workspace: string;
  /** A folder of the user's, made under home so it is not scratch. */
  let userDir: string;
  let usable = true;

  beforeAll(async () => {
    setHostDecider(async () => false);
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-grant-ws-"))
    );
    userDir = fs.mkdtempSync(
      path.join(os.homedir(), "abacusai-bot-grant-test-")
    );
    fs.mkdirSync(path.join(userDir, "Desktop"));
    const decision = await decide(
      policy({ workspaceRoot: workspace }),
      "true",
      workspace
    );
    usable = decision.kind === "confined";
  }, 120_000);

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  /** Run a command with exactly what the classifier granted it. */
  async function runGranted(
    command: string,
    ledger: ReadonlySet<string> = new Set()
  ): Promise<{ code: number; grants: string[] }> {
    const intent = classifyCommand(command, workspace, {
      context: {
        workspaceRoot: workspace,
        writableTemp: [canonicalize("/tmp"), canonicalize(os.tmpdir())],
        toolHomes: [],
      },
      ledger,
    });
    const decision = await decide(
      policy({
        workspaceRoot: workspace,
        writableTemp: [canonicalize("/tmp"), canonicalize(os.tmpdir())],
        toolHomes: [],
        approvedWrites: intent.grants,
      }),
      command,
      workspace
    );
    if (decision.kind !== "confined")
      throw new Error(`expected confinement, got ${decision.kind}`);

    return {
      code: await exitCode(decision.argv, workspace),
      grants: intent.grants,
    };
  }

  it("a new file in the user's folder is made, with no card", async () => {
    if (!usable) return;
    const target = path.join(userDir, "Desktop", "notes.txt");
    const { code, grants } = await runGranted(`echo hello > ${target}`);

    expect(grants).toEqual([canonicalize(target)]);
    expect(code).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("hello\n");
  });

  it("a file that is not the session's is not deleted", async () => {
    if (!usable) return;
    const target = path.join(userDir, "Desktop", "important.txt");
    fs.writeFileSync(target, "keep");
    const { code, grants } = await runGranted(`rm ${target}`);

    expect(grants).toEqual([]);
    expect(code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("a file the session made can be removed again", async () => {
    if (!usable) return;
    const target = path.join(userDir, "Desktop", "own.txt");
    fs.writeFileSync(target, "mine");
    const { code } = await runGranted(
      `rm ${target}`,
      new Set([canonicalize(target)])
    );

    expect(code).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("a benign create beside a delete gets nothing, so the delete is refused", async () => {
    if (!usable) return;
    const keep = path.join(userDir, "Desktop", "keep.txt");
    const fresh = path.join(userDir, "Desktop", "fresh.txt");
    fs.writeFileSync(keep, "keep");
    const { grants } = await runGranted(`touch ${fresh} && rm ${keep}`);

    expect(grants).toEqual([]);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(false);
  });
});
