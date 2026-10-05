/**
 * A-T12: the port handshake in a real Electron (spec 00 A.4.4, A.4.6).
 *
 * Bundles a main process (rpc-handshake.e2e-main.ts: the real router over
 * fake services, the real MessagePort transport, the real RendererHost), a
 * preload that runs the real handshake, and a page that uses the real
 * renderer Transport, then runs them in Electron twice:
 *
 * - normal: one live port after the first load, after each of 5 reloads and
 *   after a renderer swap under the `subscriptions` barrier, with exactly one
 *   live iterator each time (the old document's ended with its port);
 * - delayed (ABACUS_TEST_HANDSHAKE_DELAY_MS=6000): the page gives up at 5 s,
 *   closes the port that arrives at 6 s, and main is left with none.
 *
 * Spawns Electron the way the browser-snapshot harness does, so it runs in
 * the serial project and skips on a Linux host with no display.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { harnessAvailability } from "../../services/browser/browser-snapshot-harness";

const DESKTOP = resolve(import.meta.dirname, "../../../..");
const SRC = join(DESKTOP, "src");
const availability = harnessAvailability();

let dir = "";

const bundle = async (options: {
  input: string;
  file: string;
  platform: "node" | "browser";
  format: "cjs" | "iife";
}): Promise<void> => {
  const { build } = await import("rolldown");
  await build({
    input: options.input,
    platform: options.platform,
    external: ["electron"],
    transform: {
      define: { __ABACUS_PLATFORM__: '"electron"', "import.meta.env": "{}" },
    },
    resolve: {
      alias: {
        "#platform/transport": resolve(
          DESKTOP,
          "../web/src/platform/transport.electron.ts"
        ),
        "@abacus-ai/contract": join(SRC, "../../../packages/contract/src"),
        "#renderer": resolve(DESKTOP, "../web/src"),
        "#main": join(SRC, "main"),
        "#preload": join(SRC, "preload"),
      },
    },
    logLevel: "silent",
    output: { file: options.file, format: options.format },
    write: true,
  });
};

const runElectron = (mode: "normal" | "delayed"): Record<string, unknown> => {
  const resultFile = join(dir, `${mode}.json`);
  const electron = createRequire(import.meta.url)("electron") as string;
  const args = [join(dir, "main.cjs"), "--no-sandbox", "--disable-gpu"];
  const command = availability.wrapper?.command ?? electron;
  try {
    execFileSync(
      command,
      availability.wrapper == null
        ? args
        : [...availability.wrapper.args, electron, ...args],
      {
        timeout: 90_000,
        killSignal: "SIGKILL",
        stdio: "pipe",
        encoding: "utf8",
        env: {
          ...process.env,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
          ELECTRON_ENABLE_LOGGING: "",
          RPC_E2E_MODE: mode,
          RPC_E2E_RESULT: resultFile,
          RPC_E2E_PAGE: join(dir, "page.html"),
          RPC_E2E_PRELOAD: join(dir, "preload.cjs"),
          ...(mode === "delayed"
            ? { ABACUS_TEST_HANDSHAKE_DELAY_MS: "6000" }
            : {}),
        },
      }
    );
  } catch (error) {
    // Electron can exit non-zero on the way out (a crash while tearing the
    // window down); the result file, written before, is what counts.
    if (!existsSync(resultFile)) {
      const { stderr, stdout } = error as { stderr?: string; stdout?: string };
      throw new Error(
        `Electron failed (${mode}):\n${String(stderr ?? "").slice(-4000)}\n${String(stdout ?? "").slice(-2000)}`
      );
    }
  }
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as Record<
    string,
    unknown
  >;
  if (typeof result.error === "string") throw new Error(result.error);
  return result;
};

describe.skipIf(!availability.usable)(
  "the port handshake in Electron (A-T12)",
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "abacusai-bot-rpc-e2e-"));

      writeFileSync(
        join(dir, "preload-entry.ts"),
        [
          'import { ipcRenderer } from "electron";',
          `import { handshakeDelayFromEnv, installRpcPortHandshake } from ${JSON.stringify(join(SRC, "preload/rpc-port.ts"))};`,
          'installRpcPortHandshake(ipcRenderer, window as never, "main", {',
          "  delayMs: handshakeDelayFromEnv(process.env),",
          "});",
        ].join("\n")
      );
      writeFileSync(
        join(dir, "page-entry.ts"),
        [
          `import { createTransport, getTransport } from ${JSON.stringify(resolve(DESKTOP, "../web/src/data/transport/index.ts"))};`,
          "(window as any).__captureUiContinuity = () => ({ capturedAt: Date.now() });",
          "(window as any).__restoreUiContinuity = async (snapshot: any) => { await new Promise(r => setTimeout(r, 100)); (window as any).__restored = { ...snapshot, restoredAt: Date.now(), stage1At: (window as any).__stage1At }; };",
          "const report = (value: unknown) => { (window as any).__rpc = value; };",
          "(async () => {",
          "  try {",
          "    const transport = await getTransport();",
          "    const info = await transport.client.system.info();",
          "    const events = await transport.client.bots.events();",
          "    void (async () => { try { for await (const _ of events) {} } catch {} })();",
          "    await new Promise(r => setTimeout(r, 100)); (window as any).__stage1At = Date.now();",
          '    await transport.client.window.ready({ barrier: "subscriptions" });',
          // Chromium fires `close` only at the other end of a channel: a
          // transport closed locally must still settle its pending calls.
          "    const local = new MessageChannel();",
          '    const orphan = createTransport(local.port1, { kind: "memory", flowControl: false });',
          '    const pending = orphan.client.system.info().then(() => "resolved", () => "rejected");',
          "    await new Promise((r) => setTimeout(r, 20));",
          "    orphan.close();",
          '    const closeOutcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r("hung"), 1000))]);',
          "    report({ ok: true, appVersion: info.appVersion, contractVersion: info.contractVersion, closeOutcome });",
          "  } catch (error: any) {",
          "    report({ ok: false, name: error?.name, reason: error?.reason, message: String(error?.message ?? error) });",
          "  }",
          "})();",
        ].join("\n")
      );
      writeFileSync(
        join(dir, "page.html"),
        '<!doctype html><html><head><meta charset="utf-8"></head><body><script>addEventListener("error", event => { window.__rpc = { ok: false, message: event.message }; });</script><script src="page.js"></script></body></html>'
      );

      await bundle({
        input: join(SRC, "main/rpc/transports/rpc-handshake.e2e-main.ts"),
        file: join(dir, "main.cjs"),
        platform: "node",
        format: "cjs",
      });
      await bundle({
        input: join(dir, "preload-entry.ts"),
        file: join(dir, "preload.cjs"),
        platform: "node",
        format: "cjs",
      });
      await bundle({
        input: join(dir, "page-entry.ts"),
        file: join(dir, "page.js"),
        platform: "browser",
        format: "iife",
      });
    }, 60_000);

    afterAll(() => {
      if (dir !== "") rmSync(dir, { recursive: true, force: true });
    });

    it("keeps exactly one live port across loads, reloads and a swap", () => {
      const result = runElectron("normal") as {
        firstLoad: {
          page: Record<string, unknown>;
          ports: number;
          iterators: number;
        };
        reloads: Array<{
          page: Record<string, unknown>;
          ports: number;
          iterators: number;
        }>;
        afterSwap: {
          swapped: boolean;
          flippedAt: number;
          continuity: {
            stage1At: number;
            capturedAt: number;
            restoredAt: number;
          };
          replaced: boolean;
          oldDestroyed: boolean;
          page: Record<string, unknown>;
          ports: number;
          iterators: number;
        };
      };

      expect(result.firstLoad).toMatchObject({
        page: {
          ok: true,
          appVersion: "e2e",
          contractVersion: 1,
          closeOutcome: "rejected",
        },
        ports: 1,
        iterators: 1,
      });
      expect(result.reloads).toHaveLength(5);
      for (const reload of result.reloads)
        expect(reload).toMatchObject({
          page: { ok: true },
          ports: 1,
          iterators: 1,
        });
      expect(result.afterSwap.continuity.capturedAt).toBeGreaterThanOrEqual(
        result.afterSwap.continuity.stage1At
      );
      expect(result.afterSwap.continuity.restoredAt).toBeGreaterThanOrEqual(
        result.afterSwap.continuity.capturedAt + 90
      );
      expect(result.afterSwap.flippedAt).toBeGreaterThanOrEqual(
        result.afterSwap.continuity.restoredAt
      );
      expect(result.afterSwap).toMatchObject({
        swapped: true,
        replaced: true,
        oldDestroyed: true,
        page: { ok: true },
        ports: 1,
        iterators: 1,
      });
    });

    it("closes a port that arrives after the page gave up", () => {
      const result = runElectron("delayed") as {
        whileWaiting: { ports: number };
        page: Record<string, unknown>;
        afterLatePort: { ports: number; iterators: number };
      };

      // Main's half arrives at once; the page's is held back past its timeout.
      expect(result.whileWaiting.ports).toBe(1);
      expect(result.page).toMatchObject({
        ok: false,
        name: "TransportUnavailableError",
        reason: "timeout",
      });
      expect(result.afterLatePort).toEqual({ ports: 0, iterators: 0 });
    });
  }
);
