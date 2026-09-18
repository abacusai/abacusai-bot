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
      const timed = await run("sleep 30", { timeout: 1 });
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
      expect((await run("echo recovered > after.txt")).exitCode).toBe(0);
    });
  }
);
