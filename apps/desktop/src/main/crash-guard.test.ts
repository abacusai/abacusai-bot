/**
 * The net has to actually be under the process, not just defined.
 *
 * What this pins is narrow and specific: after installing, an uncaught
 * exception in the main process is a logged line rather than Electron's default
 * — a modal error box, which blocks the main process and leaves every window
 * spinning on IPC that will never be answered. That is what a tester saw when a
 * dropped IMAP socket threw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GuardEvent = "uncaughtException" | "unhandledRejection";
type Listener = Parameters<typeof process.on>[1];

let added: Array<{ event: GuardEvent; listener: Listener }>;

/** Listeners present before a test, so only the ones it adds are removed. */
const listenersOf = (event: GuardEvent): Listener[] =>
  process.listeners(event) as Listener[];

beforeEach(() => {
  added = [];
  vi.resetModules();
});

afterEach(() => {
  for (const { event, listener } of added) process.off(event, listener);
  vi.restoreAllMocks();
});

const install = async (): Promise<void> => {
  const before = {
    uncaughtException: new Set(listenersOf("uncaughtException")),
    unhandledRejection: new Set(listenersOf("unhandledRejection")),
  };

  const { installCrashGuard } = await import("./crash-guard");
  installCrashGuard();

  for (const event of [
    "uncaughtException",
    "unhandledRejection",
  ] as GuardEvent[]) {
    for (const listener of listenersOf(event)) {
      if (!before[event].has(listener)) added.push({ event, listener });
    }
  }
};

describe("the main-process crash guard", () => {
  it("turns an uncaught exception into a logged line, not a fatal dialog", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await install();

    // With no listener this is what tears the process down; the assertion is
    // that emitting it here neither throws nor goes unrecorded.
    expect(() =>
      process.emit("uncaughtException", new Error("Socket timeout"))
    ).not.toThrow();

    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.flat().join(" ")).toContain("Socket timeout");
  });

  it("records an unhandled rejection too, with its reason", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await install();

    process.emit(
      "unhandledRejection",
      new Error("ECONNRESET"),
      Promise.resolve()
    );

    expect(logged.mock.calls.flat().join(" ")).toContain("ECONNRESET");
  });

  it("installs once, however many times it is called", async () => {
    await install();
    const afterFirst = listenersOf("uncaughtException").length;

    const { installCrashGuard } = await import("./crash-guard");
    installCrashGuard();
    installCrashGuard();

    expect(listenersOf("uncaughtException")).toHaveLength(afterFirst);
  });
});
