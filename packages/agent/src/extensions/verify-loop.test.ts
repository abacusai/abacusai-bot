/**
 * The retry cap on the verify loop.
 *
 * The loop re-runs the project's tests after a run that touched code, and feeds
 * failures back as a follow-up. The cap is what stops that from being a cycle,
 * so the way it reads its own configuration is worth pinning: it used to become
 * NaN for any malformed value, and `retriesUsed >= NaN` is false for every
 * number: a cap that never caps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { setCurrentMode } from "../current-mode.js";
import { AgentMode } from "../protocol.js";
import { resolveMaxRetries, VerifyLoop } from "./verify-loop.js";

describe("how many follow-ups the loop may send", () => {
  it("defaults to one when nothing is set", () => {
    expect(resolveMaxRetries(undefined)).toBe(1);
  });

  it("honours a number that was set deliberately", () => {
    expect(resolveMaxRetries("3")).toBe(3);
    expect(resolveMaxRetries("0")).toBe(0);
  });

  it("treats an empty-but-set variable as unset, not as zero", () => {
    // Number('') is 0, which would switch verification off entirely for anyone
    // who exported the variable without a value. That is the same trap the docs warn
    // about for API keys.
    expect(resolveMaxRetries("")).toBe(1);
    expect(resolveMaxRetries("   ")).toBe(1);
  });

  it("falls back to the default for a value that is not a number", () => {
    // The bug: Number('two') is NaN, and every `retriesUsed >= NaN` comparison
    // is false, so the guard let every settled run start another verification.
    expect(resolveMaxRetries("two")).toBe(1);
    expect(resolveMaxRetries("NaN")).toBe(1);
    expect(resolveMaxRetries("Infinity")).toBe(1);
  });

  it("never yields a value that makes the guard vacuous", () => {
    for (const raw of [
      undefined,
      "",
      "  ",
      "1",
      "3",
      "two",
      "NaN",
      "Infinity",
      "-1",
    ]) {
      const max = resolveMaxRetries(raw);

      // The guard is `retriesUsed >= MAX_RETRIES`. It has to be answerable.
      expect(Number.isFinite(max)).toBe(true);
      expect(typeof (0 >= max)).toBe("boolean");
    }
  });
});

describe("what starts a new budget", () => {
  type Handler = (event: object, ctx: object) => unknown;

  /** The loop's handlers, and a project whose suite always has a new failure. */
  const loop = (): {
    verify: VerifyLoop;
    emit: (name: string, event: object) => void;
    wrote: () => void;
  } => {
    const handlers = new Map<string, Handler>();
    const verify = new VerifyLoop({
      beginUnasked() {},
      endUnasked: () => false,
    });

    verify.extension({
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);

    const emit = (name: string, event: object): void => {
      handlers.get(name)?.(event, { cwd: "/nowhere" });
    };

    return {
      verify,
      emit,
      wrote: () => emit("tool_result", { toolName: "write", isError: false }),
    };
  };

  const due = (verify: VerifyLoop): boolean =>
    (verify as unknown as { due(): boolean }).due();

  it.each([
    ["the user's message", { source: "interactive" }, true],
    ["a message from the app's host", { source: "rpc" }, true],
    ["the loop's own or another extension's", { source: "extension" }, false],
    [
      "a message joining the run under way",
      { source: "interactive", streamingBehavior: "steer" },
      false,
    ],
  ])("%s", (_name, input, resets) => {
    setCurrentMode(AgentMode.Yolo);
    const { verify, emit, wrote } = loop();

    wrote();
    (verify as unknown as { retriesUsed: number }).retriesUsed = 1;
    expect(due(verify)).toBe(false);
    emit("input", { type: "input", text: "x", ...input });
    wrote();

    expect(due(verify)).toBe(resets);
  });
});
