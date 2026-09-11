/**
 * Pre-activation gate: spawn the candidate agent bundle exactly as sessions
 * are spawned (Electron's binary in pure-Node mode) and require the NDJSON
 * `ready` line. Native imports resolve at load through the candidate's linked
 * `node_modules`, so ready also proves this foundation satisfies its
 * dependencies. Runs against a throwaway ABACUSAI_BOT_HOME.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const READY_TIMEOUT = 120_000;

const HEALTH_ENV_NAMES = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
];

export const checkAgentBundle = async (
  candidateRoot: string
): Promise<void> => {
  const entry = path.join(candidateRoot, "agent", "main.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "abacus-health-"));
  const env: Record<string, string> = {
    ABACUSAI_BOT_CLIENT_KIND: "desktop_code_mode",
    ABACUSAI_BOT_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
    HOME: home,
  };

  for (const name of HEALTH_ENV_NAMES) {
    const value = process.env[name];

    if (value !== undefined) env[name] = value;
  }

  const child = spawn(process.execPath, [entry], {
    cwd: home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The candidate agent never reported ready"));
      }, READY_TIMEOUT);

      timer.unref();

      const lines = readline.createInterface({ input: child.stdout });

      lines.on("line", (line) => {
        try {
          const parsed: unknown = JSON.parse(line);

          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { type?: unknown }).type === "ready"
          ) {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          // Not a protocol line; keep reading.
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`The candidate agent exited with ${code} before ready`)
        );
      });
    });
  } finally {
    child.removeAllListeners("exit");
    child.kill();
    await fs.rm(home, { force: true, recursive: true }).catch(() => undefined);
  }
};
