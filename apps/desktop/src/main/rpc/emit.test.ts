/**
 * One path for every event (spec 00 A.4.3, A.12): `emitIpcEvent` feeds both
 * the legacy renderer and the bus, so they cannot diverge, and nothing else
 * sends on the `IpcEvent` channel. The spec asks for an oxlint rule; oxlint
 * has no `no-restricted-syntax`, so this scan is that rule.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

const sent: unknown[][] = [];

vi.mock("../renderer-host", () => ({
  sendToRenderer: (...args: unknown[]) => sent.push(args),
}));

import { IpcChannels } from "#shared/channels";
import type { IpcEvent } from "#shared/contracts";

import { emitBusChannel, emitIpcEvent, publishIpcEvent } from "./emit";
import { mainEventBus } from "./event-bus";

const MAIN = join(import.meta.dirname, "..");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });

describe("emitIpcEvent", () => {
  it("sends the legacy event and dispatches it on the bus, once each", () => {
    const received: IpcEvent[] = [];
    const stop = mainEventBus.listen(
      () => true,
      (event) => received.push(event)
    );
    const event = { type: "bots-updated", emittedAt: "t" } as IpcEvent;

    emitIpcEvent(event);
    publishIpcEvent({ type: "cronjobs-updated", emittedAt: "t" } as IpcEvent);
    stop();

    expect(sent).toEqual([[IpcChannels.Event, event]]);
    expect(received.map((e) => e.type)).toEqual([
      "bots-updated",
      "cronjobs-updated",
    ]);
  });

  it("feeds the bus's own channels without a legacy send", () => {
    const statuses: unknown[] = [];
    const stop = mainEventBus.listenChannel("update", (status) =>
      statuses.push(status)
    );
    sent.length = 0;

    emitBusChannel("update", { checking: true } as never);
    stop();

    expect(statuses).toEqual([{ checking: true }]);
    expect(sent).toEqual([]);
  });

  it("is the only sender on the IpcEvent channel", () => {
    const offenders = walk(MAIN)
      .filter((file) => !file.endsWith(join("rpc", "emit.ts")))
      .filter((file) =>
        /sendToRenderer\(\s*IpcChannels\.Event\b|\.send\(\s*IpcChannels\.Event\b/.test(
          readFileSync(file, "utf8")
        )
      )
      .map((file) => relative(MAIN, file));

    // The browser runtime delivers to its own window and publishes to the
    // bus beside it (publishIpcEvent), which the next assertion checks.
    expect(offenders).toEqual(["services/browser/electron-browser-runtime.ts"]);
    expect(
      readFileSync(
        join(MAIN, "services/browser/electron-browser-runtime.ts"),
        "utf8"
      )
    ).toMatch(
      /\.send\(IpcChannels\.Event, event\);\s*publishIpcEvent\(event\);/
    );
  });
});

describe("the bus", () => {
  it("keeps delivering when one listener throws", async () => {
    const { MainEventBus } = await import("./event-bus");
    const bus = new MainEventBus();
    const seen: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    bus.listen(
      () => true,
      () => {
        throw new Error("broken subscriber");
      }
    );
    bus.listen(
      (event) => event.type === "bots-updated",
      (event) => seen.push(event.type)
    );

    bus.dispatch({ type: "bots-updated", emittedAt: "t" } as IpcEvent);
    bus.dispatch({ type: "messaging-updated", emittedAt: "t" } as IpcEvent);

    expect(seen).toEqual(["bots-updated"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
