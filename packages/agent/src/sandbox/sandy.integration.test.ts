import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backendOperations } from "../backends.js";
import { currentMode, setCurrentMode } from "../current-mode.js";
import { AgentMode } from "../protocol.js";
import { SandboxApprovals } from "./approvals.js";
import { runnerPath } from "./sandy.js";

describe.skipIf(process.platform !== "win32" || runnerPath() == null)(
  "Sandy through the app's shell backend",
  () => {
    let root: string;
    let cwd: string;
    let env: NodeJS.ProcessEnv;
    let previousMode: AgentMode;
    let approvals: SandboxApprovals;
    beforeEach(() => {
      previousMode = currentMode();
      setCurrentMode(AgentMode.Auto);
      vi.stubEnv("ABACUSAI_BOT_SANDBOX", "strict");
      vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "local");
      root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "sandy-live-"))
      );
      cwd = path.join(root, "workspace");
      fs.mkdirSync(cwd);
      const gitconfig = path.join(root, "gitconfig");
      fs.writeFileSync(
        gitconfig,
        "[user]\nname = Sandbox Test\nemail = test@example.com\n[init]\ndefaultBranch = main\n"
      );
      env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig };
      approvals = new SandboxApprovals();
    });
    afterEach(() => {
      setCurrentMode(previousMode);
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const run = async (
      command: string,
      extra: { signal?: AbortSignal; timeout?: number } = {}
    ) => {
      let output = "";
      const result = await backendOperations(approvals)!.exec(command, cwd, {
        env,
        timeout: 20,
        ...extra,
        onData: (data) => {
          output += data.toString();
        },
      });
      return { ...result, output };
    };
    const quote = (target: string) =>
      `'${target.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

    it("runs POSIX text tools, pipelines, loops and file operations", async () => {
      const result = await run(
        "mkdir texts && for word in beta alpha alpha; do printf '%s\\n' \"$word\"; done > texts/input && sed 's/alpha/apple/g' texts/input | grep apple | sort | uniq > texts/output && test \"$(cat texts/output)\" = apple && awk '{ n++ } END { print n }' texts/input > count && cp texts/output copy && mv copy moved && find texts -type f | wc -l && rm moved"
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(fs.readFileSync(path.join(cwd, "count"), "utf8").trim()).toBe("3");
    });

    it.each([
      "cmd.exe /d /c exit 7",
      "exec cmd.exe /d /c exit 7",
      "cmd.exe /d /c exit 7; status=$?; echo native-status=$status; exit $status",
    ])("preserves native exit codes: %s", async (command) => {
      const result = await run(command);
      expect(result.exitCode, result.output).toBe(7);
    });

    it("launches a native PowerShell script through BusyBox pipes", async () => {
      fs.writeFileSync(
        path.join(cwd, "probe.ps1"),
        "$ErrorActionPreference = 'Stop'\nSet-Content -LiteralPath 'powershell.txt' -Value 'powershell-ok'\nGet-Content -LiteralPath 'powershell.txt'\n"
      );
      const result = await run(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./probe.ps1 | grep powershell-ok"
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(
        fs.readFileSync(path.join(cwd, "powershell.txt"), "utf8").trim()
      ).toBe("powershell-ok");
      fs.writeFileSync(
        path.join(cwd, "outside.ps1"),
        `Set-Content -LiteralPath '${path.join(root, "forbidden.txt").replaceAll("'", "''")}' -Value 'forbidden' -ErrorAction Stop`
      );
      const denied = await run(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./outside.ps1"
      );
      expect(denied.exitCode, denied.output).not.toBe(0);
      expect(fs.existsSync(path.join(root, "forbidden.txt"))).toBe(false);
    });

    it("follows workspace junctions without granting their outside targets", async () => {
      const inside = path.join(cwd, "inside");
      const outside = path.join(root, "outside");
      fs.mkdirSync(inside);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(inside, "file.txt"), "inside");
      fs.writeFileSync(path.join(outside, "file.txt"), "outside");
      fs.symlinkSync(inside, path.join(cwd, "inside-link"), "junction");
      fs.symlinkSync(outside, path.join(cwd, "outside-link"), "junction");
      const allowed = await run("cat inside-link/file.txt");
      expect(allowed.exitCode, allowed.output).toBe(0);
      const denied = await run("echo overwritten > outside-link/file.txt");
      expect(denied.exitCode, denied.output).not.toBe(0);
      expect(fs.readFileSync(path.join(outside, "file.txt"), "utf8")).toBe(
        "outside"
      );
    });

    it("reads existing symlinks without exposing an outside target", async (context) => {
      const target = path.join(cwd, "target.txt");
      const privateFile = path.join(root, "private.txt");
      fs.writeFileSync(target, "inside");
      fs.writeFileSync(privateFile, "private");
      try {
        fs.symlinkSync(target, path.join(cwd, "inside-symlink"));
        fs.symlinkSync(privateFile, path.join(cwd, "outside-symlink"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          context.skip("host cannot create the symlink fixture");
          return;
        }
        throw error;
      }
      const allowed = await run("cat inside-symlink");
      expect(allowed.exitCode, allowed.output).toBe(0);
      expect(allowed.output.trim()).toBe("inside");
      const denied = await run("cat outside-symlink");
      expect(denied.exitCode, denied.output).not.toBe(0);
      expect(denied.output).not.toBe("private");
    });

    it("keeps AppContainer's restriction on creating symlinks", async () => {
      fs.writeFileSync(path.join(cwd, "target.txt"), "target");
      const result = await run("ln -s target.txt link.txt");
      expect(result.exitCode, result.output).not.toBe(0);
      expect(fs.existsSync(path.join(cwd, "link.txt"))).toBe(false);
    });

    it.for(["node", "bun", "python"])(
      "runs a user-owned %s installation with files, temp files and children",
      async (runtime, context) => {
        // Keep the reproducer runnable; passing Bun/Python checks must not imply
        // Node compatibility. See https://github.com/libuv/libuv/issues/5178.
        if (
          runtime === "node" &&
          process.env.ABACUSAI_TEST_SANDY_NODE !== "1"
        ) {
          context.skip(
            "Node is blocked by its libuv AppContainer incompatibility; set ABACUSAI_TEST_SANDY_NODE=1 to reproduce"
          );
          return;
        }
        const available = spawnSync(runtime, ["--version"], {
          encoding: "utf8",
          timeout: 10000,
        });
        if (available.error?.message.includes("ENOENT")) {
          context.skip(`${runtime} is not installed`);
          return;
        }
        expect(available.status, available.stderr).toBe(0);
        // This host can have administrator-owned runtimes on another drive.
        // Copy a portable installation to test the no-admin, user-owned case.
        const installation = path.join(root, "tools", runtime);
        fs.mkdirSync(installation, { recursive: true });
        if (runtime === "python") {
          const location = spawnSync(
            runtime,
            ["-c", "import sys; print(sys.prefix)"],
            { encoding: "utf8" }
          );
          expect(location.status, location.stderr).toBe(0);
          fs.cpSync(location.stdout.trim(), installation, {
            recursive: true,
            dereference: true,
          });
        } else {
          const location = spawnSync(
            path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "where.exe"
            ),
            [runtime],
            { encoding: "utf8" }
          );
          expect(location.status, location.stderr).toBe(0);
          const source =
            runtime === "node" && process.env.ABACUSAI_TEST_NODE_BINARY != null
              ? process.env.ABACUSAI_TEST_NODE_BINARY
              : location.stdout.trim().split(/\r?\n/)[0]!;
          fs.copyFileSync(
            fs.realpathSync.native(source),
            path.join(installation, `${runtime}.exe`)
          );
        }
        env.PATH = `${installation};${env.PATH ?? env.Path ?? ""}`;
        delete env.Path;
        if (runtime === "node") {
          const version = await run("node --version", { timeout: 5 });
          expect(version.exitCode, `version: ${version.output}`).toBe(0);
          const simple = await run("node -e 'console.log(123)'", {
            timeout: 5,
          });
          expect(simple.exitCode, `simple: ${simple.output}`).toBe(0);
        }
        const script = runtime === "python" ? "probe.py" : "probe.cjs";
        fs.writeFileSync(
          path.join(cwd, script),
          runtime === "python"
            ? "import pathlib, tempfile, subprocess\npathlib.Path('result.txt').write_text('runtime-ok')\nwith tempfile.TemporaryFile() as f: f.write(b'temp-ok')\nassert subprocess.check_output(['sh', '-c', 'printf child-ok']).decode() == 'child-ok'\nprint(pathlib.Path('result.txt').read_text())\n"
            : "const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const cp = require('node:child_process'); fs.writeFileSync('result.txt', 'runtime-ok'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-')); fs.writeFileSync(path.join(tmp, 'file'), 'temp-ok'); if (cp.execFileSync('sh', ['-c', 'printf child-ok'], {encoding:'utf8'}) !== 'child-ok') throw Error('child failed'); console.log(fs.readFileSync('result.txt', 'utf8'));\n"
        );
        const result = await run(`${runtime} ${script}`);
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).toContain("runtime-ok");
      }
    );

    it("runs pipelines and Git writes using an accessible global config", async () => {
      const result = await run(
        "echo content | cat > file.txt && git init -q && git add file.txt && git commit -qm test && git status --porcelain && git log -1 --format=%an"
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("Sandbox Test");
      expect(fs.readFileSync(path.join(cwd, "file.txt"), "utf8").trim()).toBe(
        "content"
      );
      const head = spawnSync(
        "git",
        ["-C", cwd, "rev-parse", "--verify", "HEAD"],
        { encoding: "utf8" }
      );
      expect(head.status, head.stderr).toBe(0);
    });

    it("keeps Plan read-only, including files created by previous commands", async () => {
      expect((await run("echo original > existing.txt")).exitCode).toBe(0);
      setCurrentMode(AgentMode.PlanMode);
      const result = await run("echo replaced > existing.txt");
      expect(result.exitCode, result.output).not.toBe(0);
      expect(
        fs.readFileSync(path.join(cwd, "existing.txt"), "utf8").trim()
      ).toBe("original");
    });

    it("asks for the actual parent grant, retries confined, and expires allow-once", async () => {
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      const target = path.join(outside, "new file.txt");
      const command = `echo approved > ${quote(target)}`;
      const ask = vi.fn<NonNullable<SandboxApprovals["askDenials"]>>(
        async (_command, denials) => ({ once: denials, session: [] })
      );
      approvals.askDenials = ask;
      const result = await run(command);
      expect(result.exitCode, result.output).toBe(0);
      expect(ask).toHaveBeenCalledWith(
        command,
        [{ kind: "write", path: outside }],
        null
      );
      expect(fs.readFileSync(target, "utf8").trim()).toBe("approved");
      approvals.askDenials = async () => null;
      expect((await run(command)).exitCode).not.toBe(0);
    });

    it("honors session read approvals without carrying them into a new session", async () => {
      const target = path.join(root, "private.txt");
      fs.writeFileSync(target, "read-approved");
      approvals.askDenials = async (_command, denials) => ({
        once: [],
        session: denials,
      });
      const command = `cat ${quote(target)}`;
      const first = await run(command);
      expect(first.exitCode, first.output).toBe(0);
      approvals.askDenials = async () => {
        throw new Error("session grant should already apply");
      };
      expect((await run(command)).output.trim()).toBe("read-approved");
      approvals = new SandboxApprovals();
      const unapproved = await run(command);
      expect(unapproved.exitCode, unapproved.output).not.toBe(0);
    });

    it("removes its drive mapping after timeout and cancellation", async () => {
      const subst = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "subst.exe"
      );
      const mappings = () => spawnSync(subst, [], { encoding: "utf8" }).stdout;
      const before = mappings();
      const timed = await run(
        "sh -c 'sleep 3; echo orphan > orphan.txt' & wait",
        { timeout: 1 }
      );
      expect(timed.exitCode, timed.output).not.toBe(0);
      expect(mappings()).toBe(before);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      try {
        const cancelled = await run("sleep 30", { signal: controller.signal });
        expect(cancelled.exitCode, cancelled.output).not.toBe(0);
        expect(mappings()).toBe(before);
      } finally {
        clearTimeout(timer);
      }
      expect((await run("sleep 2; echo recovered > after.txt")).exitCode).toBe(
        0
      );
      expect(fs.existsSync(path.join(cwd, "orphan.txt"))).toBe(false);
    });

    it("keeps overlapping commands' grants separate during cleanup", async () => {
      const target = path.join(root, "private.txt");
      fs.writeFileSync(target, "private-content");
      const command = `sleep 2; cat ${quote(target)}`;
      approvals.reads.approveOnce(command, [target]);
      const allowed = run(command);
      approvals = new SandboxApprovals();
      const denied = run(`cat ${quote(target)}`);
      const [first, second] = await Promise.all([allowed, denied]);
      expect(first.exitCode, first.output).toBe(0);
      expect(first.output).toContain("private-content");
      expect(second.exitCode, second.output).not.toBe(0);
      expect(second.output).not.toContain("private-content");
    });
  }
);
