import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { handOffOf } from "../handed-off-message";
import { routeRowOf, userView } from "../message";
import { handedOffSessionId, handOffState } from "./handoff";

describe("handedOffSessionId", () => {
  it("reads the new chat's id from hand_off_session's result, as main writes it", () => {
    expect(
      handedOffSessionId(
        "Started a new chat (session: 5f0c1d2e-aa11-4b2c-9d3e-0123456789ab) on “Fix session: x”. It runs on its own."
      )
    ).toBe("5f0c1d2e-aa11-4b2c-9d3e-0123456789ab");
    expect(handedOffSessionId("This chat cannot hand work off.")).toBeNull();
  });
});

describe("handOffState", () => {
  const at = "2026-11-26T00:00:00.000Z";
  const row = (
    over: Partial<{
      turn: {
        phase: "idle" | "streaming" | "waiting_permission" | "error";
        isBusy: boolean;
        updatedAt: string;
      } | null;
      status: string;
      handOffEnd: "done" | "failed" | "stopped";
    }>
  ) => ({ turn: null, status: "stopped", ...over }) as never;

  it.each([
    ["no result yet", null, undefined, true, "starting"],
    ["its row not loaded yet", "c", undefined, false, "starting"],
    ["deleted", "c", undefined, true, "deleted"],
    ["sent, never busy yet", "c", row({}), true, "starting"],
    [
      "running",
      "c",
      row({ turn: { phase: "streaming", isBusy: true, updatedAt: at } }),
      true,
      "running",
    ],
    [
      "waiting on an approval",
      "c",
      row({
        turn: { phase: "waiting_permission", isBusy: true, updatedAt: at },
      }),
      true,
      "needs-you",
    ],
    [
      "finished with a reply",
      "c",
      row({
        turn: { phase: "idle", isBusy: false, updatedAt: at },
        handOffEnd: "done",
      }),
      true,
      "done",
    ],
    [
      "stopped by the user",
      "c",
      row({
        turn: { phase: "idle", isBusy: false, updatedAt: at },
        handOffEnd: "stopped",
      }),
      true,
      "stopped",
    ],
    [
      "failed",
      "c",
      row({
        turn: { phase: "idle", isBusy: false, updatedAt: at },
        handOffEnd: "failed",
      }),
      true,
      "error",
    ],
    [
      "idle with no ending stamped is not Done",
      "c",
      row({ turn: { phase: "idle", isBusy: false, updatedAt: at } }),
      true,
      "starting",
    ],
  ] as const)("%s", (_case, id, value, loaded, state) => {
    expect(handOffState(id, value, loaded)).toBe(state);
  });
});

describe("a handed-off chat's first message", () => {
  const message = {
    id: "m1",
    role: "user",
    parts: [
      {
        type: "text",
        content:
          '[handed off] The user\'s chat "Ship 1.2" handed this task off to you.\n\nWrite the notes',
      },
    ],
    metadata: {
      abacus: {
        userText: {
          operator: {
            kind: "handoff",
            handoff: { fromSessionId: "src", brief: "Write the notes" },
          },
        },
      },
    },
  } as unknown as UIMessage;

  it("is the app's, never shown as the user's bubble, and kept for its own row", () => {
    expect(userView(message)).toMatchObject({ hidden: true, body: "" });
    expect(routeRowOf(message)).toBe("handoff");
    expect(handOffOf(message)).toEqual({
      fromSessionId: "src",
      brief: "Write the notes",
    });
  });
});
