/**
 * Development-only driver for the acceptance run (spec 01 §12, R1-T23): JSON
 * lines on the Electron process's stdin, each `{ "op": …, "input": … }`,
 * call the same ServiceHost methods the legacy IPC handlers call
 * (main/handler.ts), so a change reaches the table feeds through the stores'
 * hooks exactly as an old-renderer action would.
 *
 * `renderer.dropPort` makes main drop renderer's MessagePort the way
 * it does for a real reconnect (R1-T22: the port-loss reload and the
 * second-loss error screen, driven against the live renderer).
 *
 * Installed only when the app is unpackaged **and** ABACUSBOT_DEV_HARNESS=1.
 * Malformed lines and unknown ops are logged and ignored.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";

import type { BotCreateInput, BotUpdateInput } from "#shared/bots";

import { isNotchWindow } from "../notch/registry";

/** The slice of ServiceHost the harness drives. */
export interface HarnessHost {
  createBot(input: BotCreateInput): unknown;
  updateBot(id: string, changes: BotUpdateInput): unknown;
  deleteBot(id: string): unknown;
  createAgentSession(workspaceId: string): unknown;
  updateAgentSessionLabel(
    workspaceId: string,
    sessionId: string,
    label: string
  ): unknown;
  removeAgentSession(workspaceId: string, sessionId: string): unknown;
}

/** What the harness does outside the ServiceHost. */
export interface HarnessExtras {
  /** Main closes renderer's active port; resolves with its id. */
  dropRendererPort(): Promise<unknown>;
  /** The main window enters or leaves full screen (the screenshot probe). */
  setFullScreen(on: boolean): Promise<unknown>;
  /** Bring the app and its window to the front (the OS-level capture). */
  focusWindow?(): Promise<unknown>;
}

const focusMainWindow = async (): Promise<unknown> => {
  const electron = await import("electron");
  electron.app.focus({ steal: true });
  electron.BaseWindow.getAllWindows()
    .find((window) => !isNotchWindow(window))
    ?.focus();
  return { focused: true };
};

const setMainWindowFullScreen = async (on: boolean): Promise<unknown> => {
  const electron = await import("electron");
  const window = electron.BaseWindow.getAllWindows().find(
    (window) => !isNotchWindow(window)
  );
  if (window == null) throw new Error("no window");
  window.setFullScreen(on);
  return { fullScreen: on };
};

const DEFAULT_EXTRAS: HarnessExtras = {
  dropRendererPort: () => dropRendererPortViaReconnect(),
  setFullScreen: setMainWindowFullScreen,
  focusWindow: focusMainWindow,
};

/**
 * The main side of a renderer reconnect (rpc/transports/message-port.ts):
 * a new `rpc:connect` from the renderer's main frame closes its active port.
 * The renderer sees `port-closed`, as when main drops it for real.
 */
export const dropRendererPortViaReconnect = async (): Promise<unknown> => {
  const electron = await import("electron");
  const { RPC_CONNECT_CHANNEL } =
    await import("../rpc/transports/message-port");
  const contents = electron.webContents
    .getAllWebContents()
    .find((candidate) => candidate.getURL().includes("index.html"));
  if (contents == null) throw new Error("no renderer webContents");
  const channel = new electron.MessageChannelMain();
  electron.ipcMain.emit(RPC_CONNECT_CHANNEL, {
    ports: [channel.port1],
    sender: contents,
    senderFrame: contents.mainFrame,
  });
  // The stand-in port has no renderer behind it.
  channel.port2.close();
  return { webContentsId: contents.id };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value === "")
    throw new Error(`input.${key} must be a non-empty string`);
  return value;
};

/** Dispatch one parsed op; throws on a bad shape or an unknown op. */
export const runHarnessOp = async (
  host: HarnessHost,
  line: unknown,
  extras: HarnessExtras = DEFAULT_EXTRAS
): Promise<unknown> => {
  if (!isRecord(line) || typeof line.op !== "string" || !isRecord(line.input))
    throw new Error("expected { op: string, input: object }");
  const input = line.input;
  switch (line.op) {
    case "bots.create":
      return host.createBot(input as unknown as BotCreateInput);
    case "bots.update":
      return host.updateBot(
        str(input, "id"),
        (isRecord(input.changes) ? input.changes : {}) as BotUpdateInput
      );
    case "bots.delete":
      return host.deleteBot(str(input, "id"));
    case "sessions.create":
      return host.createAgentSession(str(input, "workspaceId"));
    case "sessions.rename":
      return host.updateAgentSessionLabel(
        str(input, "workspaceId"),
        str(input, "sessionId"),
        str(input, "label")
      );
    case "sessions.remove":
      return host.removeAgentSession(
        str(input, "workspaceId"),
        str(input, "sessionId")
      );
    case "renderer.dropPort":
      return extras.dropRendererPort();
    case "window.fullScreen":
      return extras.setFullScreen(input.on === true);
    case "window.focus":
      return (extras.focusWindow ?? focusMainWindow)();
    default:
      throw new Error(`unknown op ${line.op}`);
  }
};

export const shouldInstallHarness = (
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): boolean => !isPackaged && env.ABACUSBOT_DEV_HARNESS === "1";

/**
 * Read ops from `input` (the process's stdin) until it ends. Returns a stop
 * function. Each result or error is logged with a `[dev-harness]` prefix.
 */
export const installMutationHarness = (
  host: HarnessHost,
  options: {
    env: NodeJS.ProcessEnv;
    isPackaged: boolean;
    input?: Readable;
    log?: (message: string) => void;
    extras?: HarnessExtras;
  }
): (() => void) | null => {
  if (!shouldInstallHarness(options.env, options.isPackaged)) return null;
  const log = options.log ?? ((message) => console.log(message));
  // Windows GUI executables do not reliably inherit piped stdin. Acceptance
  // runs can append the same JSON lines to a private file instead.
  const file = options.env.ABACUSBOT_DEV_HARNESS_FILE;
  const fileInput = file && options.input == null ? new PassThrough() : null;
  const lines = createInterface({
    input: options.input ?? fileInput ?? process.stdin,
  });
  let offset = 0;
  const timer =
    fileInput == null
      ? null
      : setInterval(() => {
          try {
            const bytes = readFileSync(file!);
            if (bytes.length < offset) offset = 0;
            fileInput.write(bytes.subarray(offset));
            offset = bytes.length;
          } catch (error) {
            // The driver may create the file after Electron starts.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              log(`[dev-harness] input read failed: ${String(error)}`);
          }
        }, 25);
  timer?.unref();
  lines.on("line", (raw) => {
    const text = raw.trim();
    if (text === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log(`[dev-harness] ignored malformed line: ${text.slice(0, 120)}`);
      return;
    }
    runHarnessOp(host, parsed, options.extras).then(
      (result) =>
        log(
          `[dev-harness] ${String((parsed as { op?: unknown }).op)} ok ${JSON.stringify(result ?? null).slice(0, 200)}`
        ),
      (error: unknown) =>
        log(
          `[dev-harness] ignored ${String((parsed as { op?: unknown })?.op)}: ${error instanceof Error ? error.message : String(error)}`
        )
    );
  });
  log(`[dev-harness] reading ops from ${fileInput == null ? "stdin" : "file"}`);
  return () => {
    if (timer != null) clearInterval(timer);
    lines.close();
    fileInput?.destroy();
  };
};
