import fs from "fs";
import os from "os";
import path from "path";

import {
  AgentStatus,
  type DesktopEvent,
  type UserTextTags,
} from "@abacus-ai/contract/agent-types";
import { isFunnelStep } from "@abacus-ai/contract/funnel";
import { PROVIDER_ENV_VARS } from "@abacus-ai/contract/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ current: "" }));
const settings = vi.hoisted(() => ({
  current: {} as {
    serverDebugSync?: boolean;
    apiKeys?: Record<string, string>;
  },
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "9.9.9", isPackaged: true },
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => home.current }));
vi.mock("../../profile-home", () => ({ profileBaseDir: () => home.current }));
vi.mock("../config/settings", () => ({
  readSettings: () => settings.current,
}));
vi.mock("../providers/abacus-host", () => ({
  abacusAppHost: () => "https://apps.example.test",
  abacusUserAgent: () => "test-agent",
  abacusRoutellmV1: () => "https://routellm.example.test/v1",
}));

import {
  type TurnChannel,
  TurnLedger,
  turnOpenerOf,
} from "../session/turn-ledger";
import {
  reportFunnelStep,
  reportFunnelStepOnce,
  resetFunnelOnceForTests,
} from "./funnel-beacon";
import { createUsageReporter } from "./usage-report";

const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));

beforeEach(() => {
  home.current = fs.mkdtempSync(path.join(os.tmpdir(), "funnel-"));
  settings.current = {};
  fetchMock.mockClear();
  resetFunnelOnceForTests();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(home.current, { recursive: true, force: true });
});

const requested = (): URL => {
  const [url] = fetchMock.mock.calls[0] as unknown as [URL];
  return url;
};

describe("reportFunnelStep", () => {
  it("sends the step, a code, the install id and the build facts, nothing else", () => {
    reportFunnelStep("signin_result", "http_403");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = requested();
    expect(url.origin + url.pathname).toBe(
      "https://apps.example.test/api/v1/_abacusaibotFunnelStep"
    );
    expect(url.searchParams.get("step")).toBe("signin_result");
    expect(url.searchParams.get("detail")).toBe("http_403");
    expect(url.searchParams.get("install")).toBe(
      fs.readFileSync(path.join(home.current, "device-id"), "utf-8")
    );
    expect(url.searchParams.get("v")).toBe("9.9.9");
    expect(url.searchParams.get("build")).toBe("packaged");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "arch",
      "build",
      "detail",
      "install",
      "os",
      "step",
      "v",
    ]);
  });

  it("reduces a detail to a short code", () => {
    reportFunnelStep("app_opened", "signed in: bob@example.com <script>");

    expect(requested().searchParams.get("detail")).toBe(
      "signedinbobexamplecomscript"
    );
  });

  it("stays home when diagnostics are off", () => {
    settings.current = { serverDebugSync: false };

    reportFunnelStep("app_opened");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a failed request", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    expect(() => reportFunnelStep("app_opened")).not.toThrow();
    await Promise.resolve();
  });
});

describe("the credit milestone card's steps", () => {
  it("are on the fixed list, and each is sent as itself", () => {
    const steps = [50, 80].flatMap((threshold) =>
      ["shown", "upgrade", "continue"].map(
        (choice) => `credit_card_${threshold}_${choice}`
      )
    );
    for (const step of steps) expect(isFunnelStep(step)).toBe(true);
    reportFunnelStep("credit_card_80_continue");
    expect(requested().searchParams.get("step")).toBe(
      "credit_card_80_continue"
    );
  });
});

describe("reportFunnelStepOnce", () => {
  it("reports a milestone once per install", () => {
    reportFunnelStepOnce("first_message");
    reportFunnelStepOnce("first_message");
    reportFunnelStepOnce("tour_done");

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A new run reads the file back rather than reporting again.
    resetFunnelOnceForTests();
    reportFunnelStepOnce("first_message");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(home.current, "funnel-once.json"), "utf-8")
      )
    ).toEqual({ first_message: true, tour_done: true });
  });
});

describe("usage report: the turn's opening message decides its kind", () => {
  const SESSION = "s-1";
  const idle = {
    type: "event",
    event: { type: "status_changed", status: AgentStatus.Idle },
  } as DesktopEvent;
  const relay = (owner: boolean): TurnChannel => ({
    platform: "whatsapp",
    chatId: "chat-1",
    owner,
    userName: owner ? null : "Ana",
  });
  const intro = "[auto-reply] You answer for the owner.\n\n";

  /** One turn through a real ledger; the kind POSTed, or null for none. */
  const reported = (turn: {
    message: string;
    tags?: UserTextTags;
    channel?: TurnChannel;
    lane?: string;
    routineSession?: boolean;
    /** The AG-UI relay hears the message once its run has started. */
    notedAfterSend?: boolean;
  }): string | null => {
    settings.current = { apiKeys: { [PROVIDER_ENV_VARS.abacus]: "test-key" } };
    fetchMock.mockClear();
    const ledger = new TurnLedger();
    ledger.onClose(
      createUsageReporter(
        "desktop",
        {
          laneOf: () => turn.lane ?? null,
          isRoutineSession: () => turn.routineSession === true,
        },
        fetchMock as unknown as typeof fetch
      )
    );
    const opener = turnOpenerOf(turn.message, turn.tags);
    if (turn.channel != null) ledger.annotate(SESSION, turn.channel);
    if (turn.notedAfterSend !== true) ledger.noteOpener(SESSION, opener);
    ledger.begin(SESSION);
    if (turn.notedAfterSend === true) ledger.noteOpener(SESSION, opener);
    ledger.observe(SESSION, idle);
    if (fetchMock.mock.calls.length === 0) return null;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://routellm.example.test/v1/abacusaibot_usage");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["kind", "surface", "turn_id"]);
    return body.kind;
  };

  it.each([
    ["typed in a plain chat", { message: "Build me a site" }, "user"],
    [
      "typed in the in-app bot chat (its relay hears it after the run starts)",
      { message: "Find me flights", notedAfterSend: true },
      "user",
    ],
    [
      "the bot's first-run kickstart",
      {
        message: "[first run] Introduce yourself.",
        tags: { operator: { kind: "kickstart" } },
      },
      null,
    ],
    [
      "a routine fired into the bot chat",
      {
        message: '[routine] "Morning news" Summarize the news.',
        tags: { routineFire: true },
      },
      "routine",
    ],
    [
      "a routine's own run session",
      { message: "Summarize the news.", routineSession: true },
      "routine",
    ],
    [
      "the owner's own chat-app message, relayed",
      { message: "What is on today?", channel: relay(true) },
      "channel",
    ],
    [
      "someone else writing to the user's bot",
      {
        message: `${intro}Is the shop open?`,
        tags: {
          operator: { kind: "auto-reply-intro", visibleFrom: intro.length },
        },
        channel: relay(false),
      },
      "channel",
    ],
    [
      "a hidden note the app relays to a chat",
      {
        message: "The connector is ready.",
        tags: {
          systemReminder: true,
          operator: { kind: "environment-notice" },
        },
        channel: relay(true),
      },
      null,
    ],
    [
      "a task one bot passed to another",
      {
        message: "[task from the user, passed on by Scout] Do it.",
        tags: {
          operator: {
            kind: "bot-task",
            task: {
              askId: "a1",
              passerId: "b1",
              passer: "Scout",
              task: "Do it.",
              userWords: "Do it.",
            },
          },
        },
      },
      null,
    ],
    ["the phone lane", { message: "Hello", lane: "phone" }, null],
  ] as const)("%s", (_name, turn, kind) => {
    expect(reported(turn)).toBe(kind);
  });

  it("a message joining a turn the app opened does not make it the user's", () => {
    settings.current = { apiKeys: { [PROVIDER_ENV_VARS.abacus]: "test-key" } };
    const ledger = new TurnLedger();
    ledger.onClose(
      createUsageReporter(
        "desktop",
        { laneOf: () => null, isRoutineSession: () => false },
        fetchMock as unknown as typeof fetch
      )
    );
    ledger.noteOpener(
      SESSION,
      turnOpenerOf("[first run] Introduce yourself.", {
        operator: { kind: "kickstart" },
      })
    );
    ledger.begin(SESSION);
    ledger.noteOpener(SESSION, turnOpenerOf("hi there"));
    ledger.begin(SESSION);
    ledger.observe(SESSION, idle);
    // A turn that never started is not a turn either.
    ledger.noteOpener(SESSION, turnOpenerOf("Build me a site"));
    ledger.begin(SESSION);
    ledger.end(SESSION, "not_started");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
