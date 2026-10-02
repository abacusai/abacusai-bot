/** R1-T23: the dev mutation harness's gate and op mapping. */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  installMutationHarness,
  runHarnessOp,
  shouldInstallHarness,
  type HarnessHost,
} from "./mutation-harness";

const fakeHost = (): HarnessHost &
  Record<string, ReturnType<typeof vi.fn>> => ({
  createBot: vi.fn(() => ({ id: "b1" })),
  updateBot: vi.fn(() => ({ id: "b1" })),
  deleteBot: vi.fn(),
  createAgentSession: vi.fn(() => ({ id: "s1" })),
  updateAgentSessionLabel: vi.fn(),
  removeAgentSession: vi.fn(),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("renderer.dropPort", () => {
  it("asks main to drop renderer's port (R1-T22)", async () => {
    const dropRendererPort = vi.fn(async () => ({ webContentsId: 3 }));
    await expect(
      runHarnessOp(
        fakeHost(),
        { op: "renderer.dropPort", input: {} },
        { dropRendererPort, setFullScreen: vi.fn() }
      )
    ).resolves.toEqual({ webContentsId: 3 });
    expect(dropRendererPort).toHaveBeenCalledOnce();
  });

  it("window.fullScreen toggles the main window's full screen", async () => {
    const setFullScreen = vi.fn(async (on: boolean) => ({ fullScreen: on }));
    await runHarnessOp(
      fakeHost(),
      { op: "window.fullScreen", input: { on: true } },
      { dropRendererPort: vi.fn(), setFullScreen }
    );
    expect(setFullScreen).toHaveBeenCalledWith(true);
  });
});

describe("shouldInstallHarness", () => {
  it("needs an unpackaged app and ABACUSBOT_DEV_HARNESS=1", () => {
    expect(shouldInstallHarness({ ABACUSBOT_DEV_HARNESS: "1" }, false)).toBe(
      true
    );
    expect(shouldInstallHarness({ ABACUSBOT_DEV_HARNESS: "1" }, true)).toBe(
      false
    );
    expect(shouldInstallHarness({}, false)).toBe(false);
  });

  it("installs nothing when gated off", () => {
    const host = fakeHost();
    expect(
      installMutationHarness(host, { env: {}, isPackaged: false })
    ).toBeNull();
    expect(
      installMutationHarness(host, {
        env: { ABACUSBOT_DEV_HARNESS: "1" },
        isPackaged: true,
      })
    ).toBeNull();
  });
});

describe("runHarnessOp", () => {
  it("maps each op to the legacy service method", async () => {
    const host = fakeHost();
    await runHarnessOp(host, {
      op: "bots.create",
      input: { name: "Ada", description: "d" },
    });
    expect(host.createBot).toHaveBeenCalledWith({
      name: "Ada",
      description: "d",
    });
    await runHarnessOp(host, {
      op: "bots.update",
      input: { id: "b1", changes: { name: "Bea" } },
    });
    expect(host.updateBot).toHaveBeenCalledWith("b1", { name: "Bea" });
    await runHarnessOp(host, { op: "bots.delete", input: { id: "b1" } });
    expect(host.deleteBot).toHaveBeenCalledWith("b1");
    await runHarnessOp(host, {
      op: "sessions.create",
      input: { workspaceId: "w" },
    });
    expect(host.createAgentSession).toHaveBeenCalledWith("w");
    await runHarnessOp(host, {
      op: "sessions.rename",
      input: { workspaceId: "w", sessionId: "s1", label: "New" },
    });
    expect(host.updateAgentSessionLabel).toHaveBeenCalledWith("w", "s1", "New");
    await runHarnessOp(host, {
      op: "sessions.remove",
      input: { workspaceId: "w", sessionId: "s1" },
    });
    expect(host.removeAgentSession).toHaveBeenCalledWith("w", "s1");
  });

  it("rejects unknown ops and bad shapes", async () => {
    const host = fakeHost();
    await expect(
      runHarnessOp(host, { op: "bots.explode", input: {} })
    ).rejects.toThrow(/unknown op/);
    await expect(runHarnessOp(host, "nope")).rejects.toThrow();
    await expect(
      runHarnessOp(host, { op: "bots.delete", input: { id: "" } })
    ).rejects.toThrow(/id/);
  });
});

describe("installMutationHarness", () => {
  it("reads appended file input once, including fragmented lines, and stops polling on close", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "harness-input-"));
    const file = join(root, "ops.jsonl");
    const host = fakeHost();
    const stop = installMutationHarness(host, {
      env: { ABACUSBOT_DEV_HARNESS: "1", ABACUSBOT_DEV_HARNESS_FILE: file },
      isPackaged: false,
      log: vi.fn(),
    });
    try {
      await vi.advanceTimersByTimeAsync(25);
      const line = JSON.stringify({
        op: "bots.delete",
        input: { id: "file-bot-π" },
      });
      const bytes = Buffer.from(line);
      const split = bytes.indexOf(Buffer.from("π")) + 1;
      writeFileSync(file, bytes.subarray(0, split));
      await vi.advanceTimersByTimeAsync(25);
      expect(host.deleteBot).not.toHaveBeenCalled();
      appendFileSync(file, bytes.subarray(split));
      appendFileSync(file, "\n");
      await vi.advanceTimersByTimeAsync(50);
      expect(host.deleteBot).toHaveBeenCalledExactlyOnceWith("file-bot-π");
      stop?.();
      appendFileSync(file, line + "\n");
      await vi.advanceTimersByTimeAsync(50);
      expect(host.deleteBot).toHaveBeenCalledTimes(1);
    } finally {
      stop?.();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads JSON lines, logs and ignores malformed ones", async () => {
    const host = fakeHost();
    const input = new PassThrough();
    const log = vi.fn();
    const stop = installMutationHarness(host, {
      env: { ABACUSBOT_DEV_HARNESS: "1" },
      isPackaged: false,
      input,
      log,
    });
    input.write("{not json\n");
    input.write(
      `${JSON.stringify({ op: "bots.delete", input: { id: "x" } })}\n`
    );
    input.write(`${JSON.stringify({ op: "nope", input: {} })}\n`);
    await flush();
    expect(host.deleteBot).toHaveBeenCalledWith("x");
    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages.some((m) => m.includes("malformed"))).toBe(true);
    expect(messages.some((m) => m.includes("ignored nope"))).toBe(true);
    stop?.();
  });
});
