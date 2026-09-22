/**
 * One llama.cpp server process, serving one model on a loopback port. Started
 * by the proxy when a request for its model arrives and stopped when the
 * machine has been quiet for a while — the model is gigabytes of memory, and
 * an app idling in the dock should not hold them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { LOCAL_MODEL_CONTEXT } from "#shared/local-models";

import { resourcePath } from "../../resources";

/** The upstream build tag, as vendored by scripts/download-llama-server.js. */
export const LLAMA_CPP_VERSION = "b11102";

const EXE = process.platform === "win32" ? "llama-server.exe" : "llama-server";

/** The bundled server, wherever this build of the app keeps its resources. */
export const llamaServerBinary = (): string =>
  resourcePath("vendor", "llama", EXE);

/** Whether this build carries the server at all. */
export const llamaServerAvailable = (): boolean => {
  try {
    fs.accessSync(llamaServerBinary(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The command line for a model, in one place so the tests can read it. */
export const llamaServerArgs = (
  modelFile: string,
  alias: string,
  port: number
): string[] => [
  "--model",
  modelFile,
  "--alias",
  alias,
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--ctx-size",
  String(LOCAL_MODEL_CONTEXT),
  // Everything on the GPU that will fit; the backend falls back on its own.
  "--n-gpu-layers",
  "999",
  // One request at a time: the agent is one conversation, and a second slot
  // would halve the context each gets.
  "--parallel",
  "1",
  // The model's own chat template, which is what carries its tool-call format.
  "--jinja",
  // Thinking off: on this hardware the answer is what the user waits for.
  "--chat-template-kwargs",
  '{"enable_thinking":false}',
  "--reasoning-format",
  "none",
  "--no-webui",
  "--log-disable",
];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** How long a model gets to load before the start is called a failure. */
const START_TIMEOUT_MS = 180_000;

export class LlamaServer {
  private child: ChildProcess | null = null;
  private port = 0;
  private stderrTail: string[] = [];

  constructor(
    readonly modelId: string,
    private readonly modelFile: string,
    private readonly log: (line: string) => void = (line) =>
      console.warn(`[llama-server] ${line}`)
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.child != null && this.child.exitCode == null;
  }

  /** Spawn and wait until /health answers ok, or throw with the stderr tail. */
  async start(): Promise<void> {
    if (this.running) return;
    const binary = llamaServerBinary();
    this.port = await freePort();
    this.stderrTail = [];
    this.log(
      `starting ${LLAMA_CPP_VERSION} for ${this.modelId} on port ${this.port}`
    );
    const child = spawn(
      binary,
      llamaServerArgs(this.modelFile, this.modelId, this.port),
      {
        cwd: path.dirname(binary),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      }
    );
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim().length === 0) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.log(`exited (${code ?? signal}) for ${this.modelId}`);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.running) break;
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await sleep(250);
    }
    const tail = this.stderrTail.slice(-5).join("\n");
    this.stop();
    throw new Error(
      this.running
        ? `the model did not finish loading in time`
        : `the server stopped while loading${tail ? `:\n${tail}` : ""}`
    );
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child == null || child.exitCode != null) return;
    child.kill();
    // Bounded: a server wedged in a driver call is not left to hold the model.
    const killer = setTimeout(() => {
      if (child.exitCode == null) child.kill("SIGKILL");
    }, 5_000);
    killer.unref();
  }
}
