/**
 * The spawned-process check of spec §7.2: `dist/main.js with the AG-UI default and explicit flag,
 * against frozen NDJSON compat baselines. fd 3 is a real Node-created pipe, as
 * main passes it; closing it before spawn exercises the inline fallback.
 * Masked: the pi session id and file only (as in the in-process goldens).
 */
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  lines,
  maskVolatile,
  prepare,
  readGolden,
  stopProvider,
} from "./__tests__/harness.js";
import { violations } from "./__tests__/invariants.js";
import { INLINE_COMPAT_PREFIX } from "./channel.js";
import type { AguiEvent } from "./wire.js";

const AGENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "main.js"
);

interface Spawned {
  stdout: string;
  fd3: string;
  code: number | null;
}

async function runAgent(
  args: string[],
  cwd: string,
  withFd3: boolean
): Promise<Spawned> {
  const child = spawn(process.execPath, [AGENT, ...args], {
    cwd,
    env: process.env,
    stdio: withFd3
      ? ["pipe", "pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let fd3 = "";
  let sent = false;
  let closed = false;

  child.stderr?.on("data", () => undefined);
  (child.stdio[3] as Readable | undefined)?.on("data", (chunk: Buffer) => {
    fd3 += chunk.toString();
  });

  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const compat = withFd3 ? fd3 : stdout;

    if (!sent && compat.includes('"type":"mcp_servers"')) {
      sent = true;
      child.stdin!.write(
        `${JSON.stringify({ type: "send", message: "hi" })}\n`
      );
    }
  });
  (child.stdio[3] as Readable | undefined)?.on("data", () => {
    if (!sent && fd3.includes('"type":"mcp_servers"')) {
      sent = true;
      child.stdin!.write(
        `${JSON.stringify({ type: "send", message: "hi" })}\n`
      );
    }
  });

  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const compat = withFd3 ? fd3 : stdout;

    if (
      sent &&
      (compat.match(/"status":"idle"/g) ?? []).length >= 2 &&
      !closed
    ) {
      closed = true;
      child.stdin!.end();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const code = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve)
  );

  return { stdout, fd3, code };
}

afterAll(async () => {
  await stopProvider();
});

describe("dist/main.js", () => {
  it("refuses --wire ndjson with structured stderr and exit 64", () => {
    const result = spawnSync(process.execPath, [AGENT, "--wire", "ndjson"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toEqual({
      type: "error",
      code: "wire_unsupported",
    });
  });
  it("the default wire is AG-UI and fd 3 preserves frozen compat bytes", async () => {
    const { context, provider, restore } = await prepare({
      name: "spawn-fd",
      reply: () => ({ say: "Hello there." }),
      steps: [],
    });

    try {
      const run = await runAgent(
        ["--thread-id", "t-1", "--compat-fd", "3"],
        context.cwd,
        true
      );
      const out = lines(run.stdout).map(
        (line) => JSON.parse(line) as AguiEvent
      );
      const hello = out[0] as {
        name: string;
        value: { compat: string; incarnation: string };
      };

      expect(run.code).toBe(0);
      expect(hello.name).toBe("wire.hello");
      expect(hello.value.compat).toBe("fd");

      const [preamble, ...rest] = run.fd3.split("\n");

      expect(JSON.parse(preamble!)).toEqual({
        type: "compat.hello",
        incarnation: hello.value.incarnation,
      });
      expect(maskVolatile(rest.join("\n"), provider.port)).toBe(
        readGolden("plain-text.ndjson")
      );
      expect(violations(out.slice(1))).toEqual([]);
      expect(out.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    } finally {
      restore();
    }
  });

  it("falls back to inline compat when fd 3 is not open, byte-identical once the RS is stripped", async () => {
    const { context, provider, restore } = await prepare({
      name: "spawn-inline",
      reply: () => ({ say: "Hello there." }),
      steps: [],
    });

    try {
      const run = await runAgent(
        ["--wire", "agui", "--thread-id", "t-1", "--compat-fd", "3"],
        context.cwd,
        false
      );
      const all = lines(run.stdout);
      const hello = JSON.parse(all[0]!) as { value: { compat: string } };
      const compat = all
        .filter((line) => line.startsWith(INLINE_COMPAT_PREFIX))
        .map((line) => `${line.slice(1)}\n`)
        .join("");
      const agui = all
        .filter((line) => !line.startsWith(INLINE_COMPAT_PREFIX))
        .map((line) => JSON.parse(line) as AguiEvent);

      expect(run.code).toBe(0);
      expect(hello.value.compat).toBe("inline");
      expect(maskVolatile(compat, provider.port)).toBe(
        readGolden("plain-text.ndjson")
      );
      expect(violations(agui.slice(1))).toEqual([]);
    } finally {
      restore();
    }
  });

  it("on fd-3 loss under stdout backpressure, exits 75 only after its last lines are out", async () => {
    // ~400 KB of reply text: far past a pipe's buffer, so while the parent
    // is not reading stdout the child holds most of it in-process.
    const big = "backpressure ".repeat(32_000);
    const { context, restore } = await prepare({
      name: "spawn-loss",
      reply: () => ({ stall: { say: big } }),
      steps: [],
    });

    try {
      const child = spawn(
        process.execPath,
        [AGENT, "--wire", "agui", "--thread-id", "t-1", "--compat-fd", "3"],
        {
          cwd: context.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        }
      );
      const fd3Stream = child.stdio[3] as Readable;
      let fd3 = "";
      let stdout = "";
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", resolve)
      );
      const waitUntil = async (check: () => boolean, label: string) => {
        const deadline = Date.now() + 20_000;

        while (!check()) {
          if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      child.stderr!.on("data", () => undefined);
      fd3Stream.on("data", (chunk: Buffer) => {
        fd3 += chunk.toString();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      await waitUntil(() => fd3.includes('"type":"mcp_servers"'), "startup");
      // Stop reading stdout: from here the child's AG-UI lines pile up.
      child.stdout!.pause();
      child.stdin!.write(
        `${JSON.stringify({
          type: "run",
          input: {
            threadId: "t-1",
            runId: "r-big",
            messages: [{ id: "u-1", role: "user", content: "talk a lot" }],
            tools: [],
            context: [],
            state: {},
          },
        })}\n`
      );
      // The big delta reached compat (so it also went to stdout, unread).
      await waitUntil(() => fd3.length > big.length, "big text on fd 3");

      // Main's taps go away while the run is open.
      fd3Stream.destroy();
      // Any compat write now fails asynchronously: the loss path.
      child.stdin!.write(`${JSON.stringify({ type: "get_queue" })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Nothing may have been lost while nobody read: drain it all now.
      child.stdout!.resume();
      const code = await exited;

      await new Promise((resolve) => setImmediate(resolve));
      expect(code).toBe(75);

      const out = lines(stdout).map((line) => JSON.parse(line) as AguiEvent);
      const tail = out
        .slice(-3)
        .map((event) => (event.type === "CUSTOM" ? event.name : event.type));

      // The reply's open message is closed before the terminal.
      expect(tail).toEqual([
        "wire.compat_lost",
        "TEXT_MESSAGE_END",
        "RUN_ERROR",
      ]);
      expect((out.at(-1) as { code?: string }).code).toBe("compat_lost");
      // The unread reply text is intact before them.
      expect(
        out
          .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
          .map((event) => (event as { delta: string }).delta)
          .join("")
      ).toContain(big);
    } finally {
      restore();
    }
  });
});
