import path from "node:path";

import type { DesktopEvent } from "@abacus-ai/contract/agent-types";
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { SUCCESS_PITCH_GAP_MS } from "@abacus-ai/contract/success-pitch";
import { describe, expect, it, vi } from "vitest";

import type { TurnRecord } from "../session/turn-ledger";
import { SuccessPitchWatch, type SuccessPitchDeps } from "./success-pitch";

const KEY = "org-1:user-1";
const FREE: AbacusAccountInfo = {
  user_id: "user-1",
  organization_id: "org-1",
  subscription_tier: "free",
  credits_used: 200,
  credits_granted: 2000,
} as AbacusAccountInfo;

const LONG_REPLY =
  "Done. The page is open in the preview: a hero with your photo, the menu with prices, opening hours and a button for orders. It needs no build step and opens straight away.";

const event = (value: object): DesktopEvent =>
  ({ type: "event", event: value }) as DesktopEvent;

const text = (content: string) => event({ type: "text_delta", content });

const tool = (
  name: string,
  input: Record<string, unknown>,
  content = "",
  rejected = false
) =>
  event({
    type: "tool_execution_complete",
    tool: { id: `t-${name}`, name, type: "tool", input },
    result: { content, ...(rejected ? { rejected: true } : {}) },
  });

const presentSite = tool(
  "agent-tools_present_deliverable",
  { items: [{ path: "http://127.0.0.1:5173" }] },
  "[artifact] http://127.0.0.1:5173"
);
const presentFile = tool(
  "agent-tools_present_deliverable",
  { items: [{ path: "/home/me/report.pdf" }] },
  "[artifact] /home/me/report.pdf"
);

const setup = (
  options: {
    account?: AbacusAccountInfo | null;
    pitchable?: boolean;
    turnOpen?: boolean;
    told?: boolean;
    prefs?: Partial<PrefsRow>;
    deps?: Partial<SuccessPitchDeps>;
  } = {}
) => {
  let row = {
    successPitch: {},
    dismissals: { successPitchCards: {} },
    ...options.prefs,
  } as unknown as PrefsRow;
  let now = 100 * SUCCESS_PITCH_GAP_MS;
  const funnel = vi.fn();
  const tellInChat = vi.fn(async () => options.told ?? true);
  const deps: SuccessPitchDeps = {
    prefs: () => ({
      get: () => row,
      update: (patch: PrefsPatch) => {
        row = { ...row, ...patch } as PrefsRow;
      },
    }),
    account: () => (options.account === undefined ? FREE : options.account),
    pitchable: () => options.pitchable ?? true,
    workspacePath: () => "/home/me",
    turnOpen: () => options.turnOpen ?? false,
    tellInChat,
    funnel,
    nextStep: () => false,
    now: () => now,
    ...options.deps,
  };
  const watch = new SuccessPitchWatch(deps);
  let turn = 0;
  /** One turn: the user's message, the agent's events, its close. */
  const run = async (
    message: string,
    events: DesktopEvent[],
    ending: Partial<TurnRecord> = {}
  ) => {
    turn += 1;
    watch.userSaid("s1", message);
    for (const payload of events) watch.observe("s1", payload);
    await watch.turnClosed({
      turnId: `turn-${turn}`,
      sessionId: "s1",
      kind: "reply",
      startedAt: now,
      endedAt: now,
      ...ending,
    });
  };
  return {
    watch,
    run,
    funnel,
    tellInChat,
    mark: () => row.successPitch?.[KEY],
    sites: () => row.siteReady,
    offer: () => row.successPitch?.[KEY]?.offer ?? null,
    setCard: (card: object) => {
      row = {
        ...row,
        dismissals: { ...row.dismissals, successPitchCards: { [KEY]: card } },
      } as PrefsRow;
    },
    setKeepCard: (card: object) => {
      row = {
        ...row,
        dismissals: { ...row.dismissals, keepRunningCards: { [KEY]: card } },
      } as PrefsRow;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const card = (shown: number, lastShownAt: number | null, notNow = 0) => ({
  shown,
  lastShownAt,
  notNow,
  shownOffer: null,
  answered: null,
});

const CHAT = {
  channel: {
    platform: "telegram",
    chatId: "c1",
    owner: true,
    userName: null,
  },
};

describe("SuccessPitchWatch: a deliverable on a clean turn", () => {
  it("offers the card for a served site, leading with apps", async () => {
    const t = setup();
    await t.run("Build a one-page site for my bakery", [
      presentSite,
      text(LONG_REPLY),
    ]);
    expect(t.offer()).toMatchObject({
      id: "turn-1",
      sessionId: "s1",
      trigger: "deliverable",
      moment: "site",
      lead: "apps",
    });
    expect(t.mark()?.appTurns).toBe(1);
  });

  it("offers it for a file, and for a started server", async () => {
    const file = setup();
    await file.run("Write the report", [presentFile, text(LONG_REPLY)]);
    expect(file.offer()).toMatchObject({ moment: "file", lead: null });

    const served = setup();
    await served.run("Show me the site", [
      tool("serve", { action: "start", directory: "/home/me/site" }),
      text(LONG_REPLY),
    ]);
    expect(served.offer()).toMatchObject({ moment: "site" });
  });

  it("leads with personal agents after inbox work, and with media after image work", async () => {
    const inbox = setup();
    await inbox.run("Summarise my inbox into a doc", [
      tool("abacus-connectors_Gmail_Tool", { action: "list" }),
      presentFile,
      text(LONG_REPLY),
    ]);
    expect(inbox.offer()?.lead).toBe("agents");

    const image = setup();
    await image.run("Make a poster", [
      tool(
        "agent-tools_image_generate",
        { prompt: "poster" },
        "[artifact] /home/me/poster.png"
      ),
      text(LONG_REPLY),
    ]);
    expect(image.offer()).toMatchObject({ moment: "file", lead: "media" });
  });

  it("never on a turn with an error, a failed tool, another card or the free lane", async () => {
    for (const trouble of [
      event({ type: "error", error: { message: "boom" } }),
      event({ type: "notification", message: "x", severity: "error" }),
      tool("bash", { command: "npm run build" }, "failed", true),
      tool("agent-tools_paid_feature", { feature: "image_generation" }),
      tool("agent-tools_offer_session", {}),
      // The free models chosen at the credit wall.
      event({
        type: "turn_complete",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          requests: 1,
          model: null,
          lane: "free",
        },
      }),
    ]) {
      const t = setup();
      await t.run("Build it", [presentSite, trouble, text(LONG_REPLY)]);
      expect(t.offer()).toBeNull();
    }
  });

  it("offers it when the reply is short or ends by offering more", async () => {
    for (const reply of [
      "Your todo app is live. Want me to add due dates, or multiple lists?",
      "Done.",
    ]) {
      const t = setup();
      await t.run("Create a todo webapp", [
        tool("write", { file_path: "/home/me/todo/index.html" }),
        tool("serve", { action: "start", directory: "/home/me/todo" }),
        presentSite,
        text(reply),
      ]);
      expect(t.offer()).toMatchObject({ moment: "site" });
    }
  });

  it("never on a reply that says it failed", async () => {
    const t = setup();
    await t.run("Build it", [
      presentSite,
      text(`I couldn't publish it. ${LONG_REPLY}`),
    ]);
    expect(t.offer()).toBeNull();
  });

  it("reads the reply a suggest_tasks call closed, which is the last thing the turn did", async () => {
    const buttons = (): DesktopEvent[] => [
      event({
        type: "tool_call_start",
        toolCallId: "t",
        toolName: "suggest_tasks",
      }),
      tool("suggest_tasks", {}),
    ];
    const failed = setup();
    await failed.run("Build it", [
      presentSite,
      text(`I couldn't publish it. ${LONG_REPLY}`),
      ...buttons(),
    ]);
    expect(failed.offer()).toBeNull();

    const worked = setup();
    await worked.run("Build it", [presentSite, text(LONG_REPLY), ...buttons()]);
    expect(worked.offer()).toMatchObject({ moment: "site" });
  });

  it("never on a failed or stopped turn, a file edit, or plain browsing", async () => {
    const failed = setup();
    await failed.run("Build it", [presentSite, text(LONG_REPLY)], {
      kind: "failed",
    });
    expect(failed.offer()).toBeNull();
    const edits = setup();
    await edits.run("Fix the bug", [
      tool("edit", { file_path: "/home/me/src/app.ts" }),
      tool("web_fetch", { url: "https://example.com" }),
      text(LONG_REPLY),
    ]);
    expect(edits.offer()).toBeNull();
  });

  it("never on a routine or a host lane, nor a turn the app opened (a bot's first run)", async () => {
    const routine = setup({ pitchable: false });
    await routine.run("Make the weekly report", [
      presentFile,
      text(LONG_REPLY),
    ]);
    expect(routine.offer()).toBeNull();
    const starter = setup();
    await starter.run(
      "[first run] Introduce yourself and start your mission.",
      [presentFile, text(LONG_REPLY)]
    );
    expect(starter.offer()).toBeNull();
  });

  it("never on a paid or unread plan, or past half the free credits", async () => {
    for (const account of [
      { ...FREE, subscription_tier: "basic" } as AbacusAccountInfo,
      { ...FREE, subscription_tier: "pro" } as AbacusAccountInfo,
      null,
      { ...FREE, credits_used: 1000 } as AbacusAccountInfo,
    ]) {
      const t = setup({ account });
      await t.run("Build it", [presentSite, text(LONG_REPLY)]);
      expect(t.offer()).toBeNull();
    }
  });
});

describe("SuccessPitchWatch: a positive reaction", () => {
  it("offers the card after praise for a clean result", async () => {
    const t = setup();
    await t.run("Make a calculator on my desktop", [
      tool("write", { file_path: "/home/me/calc.py" }),
      text(LONG_REPLY),
    ]);
    expect(t.offer()).toBeNull();
    await t.run("harika olmuş, çok teşekkürler!", [
      text("Rica ederim! İstersen geçmiş ekranı da ekleyebilirim."),
    ]);
    expect(t.offer()).toMatchObject({
      id: "turn-2",
      trigger: "positive_reaction",
      moment: "reaction",
    });
  });

  it("never after praise that carries a complaint, or for a reply that did nothing", async () => {
    const t = setup();
    await t.run("Build it", [
      tool("write", { file_path: "/a.py" }),
      text(LONG_REPLY),
    ]);
    await t.run("thanks but it's broken", [text("Let me look.")]);
    expect(t.offer()).toBeNull();

    const chat = setup();
    await chat.run("Tell me a joke", [text(LONG_REPLY)]);
    await chat.run("thanks!", [text("Anytime!")]);
    expect(chat.offer()).toBeNull();
  });

  it("a thumbs-up counts on a result that ends by offering more", async () => {
    const t = setup();
    await t.run("Build it", [
      tool("write", { file_path: "/a.py" }),
      text("Done. Want me to add tests too?"),
    ]);
    await t.watch.reacted("s1");
    expect(t.offer()).toMatchObject({ trigger: "positive_reaction" });
  });

  it("never on a reply with no tools, such as a clarifying question", async () => {
    const t = setup();
    await t.run("Create a todo webapp", [
      text("Sure! Should it save the todos in the browser or in a file?"),
    ]);
    await t.watch.reacted("s1");
    expect(t.offer()).toBeNull();
    await t.run("thanks!", [text("Anytime!")]);
    expect(t.offer()).toBeNull();
  });

  it("a thumbs-up on the latest reply counts, between turns only", async () => {
    const t = setup();
    await t.run("Build it", [
      tool("write", { file_path: "/a.py" }),
      text(LONG_REPLY),
    ]);
    await t.watch.reacted("s1");
    expect(t.offer()).toMatchObject({
      id: "turn-1:reaction",
      trigger: "positive_reaction",
    });

    const busy = setup({ turnOpen: true });
    await busy.run("Build it", [
      tool("write", { file_path: "/a.py" }),
      text(LONG_REPLY),
    ]);
    await busy.watch.reacted("s1");
    expect(busy.offer()).toBeNull();
  });
});

describe("SuccessPitchWatch: the offer and its limits", () => {
  it("the next message ends the offer, and a complaint is logged as withdrawn", async () => {
    const t = setup();
    await t.run("Write it", [presentFile, text(LONG_REPLY)]);
    expect(t.offer()).not.toBeNull();
    t.watch.userSaid("s1", "the button doesn't work");
    expect(t.offer()).toBeNull();
    expect(t.funnel).toHaveBeenCalledWith(
      "success_pitch_withdrawn",
      "deliverable"
    );

    const moved = setup();
    await moved.run("Write it", [presentFile, text(LONG_REPLY)]);
    moved.watch.userSaid("s1", "now add a contact form");
    expect(moved.offer()).toBeNull();
    expect(moved.funnel).not.toHaveBeenCalledWith(
      "success_pitch_withdrawn",
      "deliverable"
    );
  });

  it("one every three days, three ever, none after two Not nows", async () => {
    const t = setup();
    t.setCard(card(1, 100 * SUCCESS_PITCH_GAP_MS - 60_000));
    await t.run("Write it", [presentFile, text(LONG_REPLY)]);
    expect(t.offer()).toBeNull();
    t.advance(SUCCESS_PITCH_GAP_MS);
    await t.run("Write another", [presentFile, text(LONG_REPLY)]);
    expect(t.offer()).not.toBeNull();

    const capped = setup();
    capped.setCard(card(3, 0));
    await capped.run("Write it", [presentFile, text(LONG_REPLY)]);
    expect(capped.offer()).toBeNull();

    const declined = setup();
    declined.setCard(card(2, 0, 2));
    await declined.run("Write it", [presentFile, text(LONG_REPLY)]);
    expect(declined.offer()).toBeNull();
  });
});

const writes = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) =>
    tool("write", { path: `app/file-${from + index}.ts` })
  );
const busy = (count: number) =>
  Array.from({ length: count }, () => tool("read", { path: "app/a.ts" }));

describe("SuccessPitchWatch: a big build", () => {
  it("offers it once the chat has written fifteen distinct files, once per chat", async () => {
    const t = setup();
    await t.run("Build my shop", [...writes(0, 10), text(LONG_REPLY)]);
    expect(t.offer()).toBeNull();
    // The same files again are not new ones.
    await t.run("Fix it", [...writes(0, 10), text(LONG_REPLY)]);
    expect(t.offer()).toBeNull();
    await t.run("Add the cart", [...writes(10, 5), text(LONG_REPLY)]);
    expect(t.offer()).toMatchObject({
      id: "turn-3",
      trigger: "big_task",
      moment: "big_task",
      lead: "apps",
      detail: "15",
    });
    expect(t.mark()?.bigTaskChats).toEqual(["s1"]);
    t.advance(SUCCESS_PITCH_GAP_MS);
    await t.run("Add checkout", [...writes(15, 4), text(LONG_REPLY)]);
    expect(t.offer()).toBeNull();
  });

  it("a long turn alone is not a big build, and a tool that failed along the way does not hold it back", async () => {
    const long = setup();
    await long.run("Build it", [...busy(150), text(LONG_REPLY)]);
    expect(long.offer()).toBeNull();

    const bumpy = setup();
    await bumpy.run("Build it", [
      ...writes(0, 15),
      tool("bash", { command: "npm test" }, "1 failed", true),
      text(LONG_REPLY),
    ]);
    expect(bumpy.offer()).toMatchObject({ trigger: "big_task" });
  });

  it("never on a troubled turn, in a chat app, on a paid plan, past half the grant, or over the pitch's caps", async () => {
    const troubled = setup();
    await troubled.run("Build it", [
      ...writes(0, 15),
      event({ type: "error" }),
      text(LONG_REPLY),
    ]);
    expect(troubled.offer()).toBeNull();

    const chat = setup();
    await chat.run("Build it", [...writes(0, 15), text(LONG_REPLY)], CHAT);
    expect(chat.offer()).toBeNull();

    for (const account of [
      { ...FREE, subscription_tier: "pro" },
      { ...FREE, credits_used: 1200 },
    ] as AbacusAccountInfo[]) {
      const t = setup({ account });
      await t.run("Build it", [...writes(0, 15), text(LONG_REPLY)]);
      expect(t.offer()).toBeNull();
    }

    const capped = setup();
    capped.setCard(card(3, 0));
    await capped.run("Build it", [...writes(0, 15), text(LONG_REPLY)]);
    expect(capped.offer()).toBeNull();
  });

  it("a complaint after it is logged as withdrawn, with its file count", async () => {
    const t = setup();
    await t.run("Build it", [...writes(0, 15), text(LONG_REPLY)]);
    t.watch.userSaid("s1", "it's broken");
    expect(t.offer()).toBeNull();
    expect(t.funnel).toHaveBeenCalledWith("big_task_withdrawn", "15");
  });
});

const background = (command: string, content = "Started in the background.") =>
  tool("bash", { command, background: true }, content);
const createRoutine = (
  input: Record<string, unknown>,
  content = "Created. ..."
) => tool("agent-tools_cronjob", { action: "create", ...input }, content);

describe("SuccessPitchWatch: keep it running", () => {
  it("offers it for a server started in the background, named by its folder, once per thing", async () => {
    const t = setup();
    await t.run("Make my price bot", [
      background("cd btc-bot && python bot.py"),
      text(LONG_REPLY),
    ]);
    expect(t.offer()).toMatchObject({
      trigger: "keep_running",
      moment: "server",
      lead: "agents",
      name: "btc-bot",
    });
    expect(t.sites()?.s1).toMatchObject({
      kind: "server",
      siteDir: path.resolve("/home/me", "btc-bot"),
      name: "btc-bot",
    });
    t.watch.userSaid("s1", "now log to a file");
    t.advance(2 * SUCCESS_PITCH_GAP_MS);
    await t.run("Restart it", [
      background("cd btc-bot && python bot.py"),
      text(LONG_REPLY),
    ]);
    expect(t.offer()).toBeNull();
  });

  it("never for a served site, which is mostly a preview: that stays the deploy steps' mark", async () => {
    const t = setup({ deps: { nextStep: () => true } });
    await t.run("Build my bakery site", [
      tool("serve", { action: "start", directory: "bakery" }),
      text(LONG_REPLY),
    ]);
    expect(t.offer()).toBeNull();
    expect(t.sites()?.s1).toMatchObject({ kind: "site", name: "bakery" });
  });

  it("never for one-off work set aside: an install, a build, tests", async () => {
    for (const command of [
      "npm install",
      "cd app && npm run build",
      "pytest -q",
      "sleep 30",
    ]) {
      const t = setup();
      await t.run("Do it", [background(command), text(LONG_REPLY)]);
      expect(t.offer()).toBeNull();
      expect(t.sites()?.s1).toBeUndefined();
    }
  });

  it("offers it for a routine it created, by its name or its prompt's opening", async () => {
    const named = setup();
    await named.run("Every morning, send me BTC news", [
      createRoutine({
        name: "BTC morning news",
        prompt: "x",
        schedule: "0 9 * * *",
      }),
      text(LONG_REPLY),
    ]);
    expect(named.offer()).toMatchObject({
      moment: "routine",
      name: "BTC morning news",
    });
    expect(named.sites()?.s1).toMatchObject({ kind: "routine", siteDir: null });

    const unnamed = setup();
    await unnamed.run("Remind me", [
      createRoutine({
        prompt: "Check the weather in Lisbon and tell me if it rains",
      }),
      text(LONG_REPLY),
    ]);
    expect(unnamed.offer()?.name).toBe("Check the weather in Lisbon and");

    const refused = setup();
    await refused.run("Remind me", [
      createRoutine({ prompt: "x" }, "A routine needs a schedule."),
      text(LONG_REPLY),
    ]);
    expect(refused.offer()).toBeNull();
  });

  it("comes ahead of a big build, on a budget of its own", async () => {
    const both = setup();
    await both.run("Build and run it", [
      ...writes(0, 15),
      background("node server.js"),
      text(LONG_REPLY),
    ]);
    expect(both.offer()).toMatchObject({ trigger: "keep_running" });

    // The pitch's caps spent: keep it running still comes.
    const pitched = setup();
    pitched.setCard(card(3, 0));
    await pitched.run("Run it", [
      background("node server.js"),
      text(LONG_REPLY),
    ]);
    expect(pitched.offer()).toMatchObject({ trigger: "keep_running" });

    // Its own spent (one a day, three ever, two Not nows): the big build comes instead.
    for (const spent of [
      card(1, 100 * SUCCESS_PITCH_GAP_MS - 60_000),
      card(3, 0),
      card(2, 0, 2),
    ]) {
      const t = setup();
      t.setKeepCard(spent);
      await t.run("Build and run it", [
        ...writes(0, 15),
        background("node server.js"),
        text(LONG_REPLY),
      ]);
      expect(t.offer()).toMatchObject({ trigger: "big_task" });
    }
  });

  it("a paid plan gets no offer, only the mark for its deploy steps", async () => {
    const t = setup({
      account: { ...FREE, subscription_tier: "pro" } as AbacusAccountInfo,
    });
    await t.run("Run my bot", [
      background("cd bot && npm start"),
      text(LONG_REPLY),
    ]);
    expect(t.offer()).toBeNull();
    expect(t.sites()?.s1).toMatchObject({ kind: "server", name: "bot" });
  });

  it("says whether a routine's card will come, so its create skips the 24/7 line", () => {
    expect(setup().watch.keepCardFor("s1")).toBe(true);
    const spent = setup();
    spent.setKeepCard(card(3, 0));
    expect(spent.watch.keepCardFor("s1")).toBe(false);
    expect(setup({ pitchable: false }).watch.keepCardFor("s1")).toBe(false);
    expect(
      setup({
        account: { ...FREE, subscription_tier: "pro" } as AbacusAccountInfo,
      }).watch.keepCardFor("s1")
    ).toBe(true);
    expect(setup({ account: null }).watch.keepCardFor("s1")).toBe(false);
  });
});

describe("SuccessPitchWatch: chat apps", () => {
  const praised = async (t: ReturnType<typeof setup>) => {
    await t.run(
      "Build it",
      [tool("write", { file_path: "/a.py" }), text(LONG_REPLY)],
      CHAT
    );
    await t.run("valeu, perfeito!", [text("De nada!")], CHAT);
  };

  it("a chat-first user hears it once ever in their own chat, after praise", async () => {
    const t = setup();
    await praised(t);
    expect(t.tellInChat).toHaveBeenCalledTimes(1);
    expect(t.mark()?.chatToldAt).not.toBeNull();
    expect(t.funnel).toHaveBeenCalledWith(
      "success_pitch_chat_told",
      "positive_reaction"
    );
    // No in-app card for a chat-app turn.
    expect(t.offer()).toBeNull();
    t.advance(10 * SUCCESS_PITCH_GAP_MS);
    await praised(t);
    expect(t.tellInChat).toHaveBeenCalledTimes(1);
  });

  it("never for a user who mainly works in the app, nor for a deliverable", async () => {
    const appFirst = setup();
    for (let index = 0; index < 3; index += 1)
      await appFirst.run("hi", [text("Hello!")]);
    await praised(appFirst);
    expect(appFirst.tellInChat).not.toHaveBeenCalled();

    const delivered = setup();
    await delivered.run("Build it", [presentSite, text(LONG_REPLY)], CHAT);
    expect(delivered.tellInChat).not.toHaveBeenCalled();
  });

  it("never in a contact's chat", async () => {
    const t = setup();
    const contact = { channel: { ...CHAT.channel, owner: false } };
    await t.run(
      "Build it",
      [tool("write", { file_path: "/a.py" }), text(LONG_REPLY)],
      contact
    );
    await t.run("thanks!", [text("You're welcome")], contact);
    expect(t.tellInChat).not.toHaveBeenCalled();
    expect(t.mark()).toBeUndefined();
  });

  it("a line that could not go is not counted as told", async () => {
    const t = setup({ told: false });
    await praised(t);
    expect(t.mark()?.chatToldAt).toBeNull();
    expect(t.funnel).not.toHaveBeenCalled();
  });
});

describe("SuccessPitchWatch: the chat's latest site, on any plan", () => {
  const PRO = { ...FREE, subscription_tier: "pro" } as AbacusAccountInfo;

  it("marks a served site with its folder, and a clean result without one clears it", async () => {
    const t = setup({ account: PRO });
    await t.run("Build my bakery site", [
      tool("serve", { action: "start", directory: "bakery" }),
      text(LONG_REPLY),
    ]);
    expect(t.sites()?.s1).toMatchObject({
      turnId: "turn-1",
      siteDir: path.resolve("/home/me", "bakery"),
    });
    // A turn that failed leaves the site as the latest result.
    await t.run("Add a menu page", [event({ type: "error" }), text("x")]);
    expect(t.sites()?.s1?.turnId).toBe("turn-1");
    await t.run("Write the report", [presentFile, text(LONG_REPLY)]);
    expect(t.sites()?.s1).toBeUndefined();
  });

  it("a presented page marks its own folder", async () => {
    const t = setup({ account: PRO });
    await t.run("Build it", [
      tool(
        "agent-tools_present_deliverable",
        { items: [{ path: "/home/me/shop/index.html" }] },
        "[artifact] /home/me/shop/index.html"
      ),
      text(LONG_REPLY),
    ]);
    expect(t.sites()?.s1?.siteDir).toBe("/home/me/shop");
  });
});

describe("how a turn ended, for the work-waiting reminder", () => {
  const nextStep = (tasks: object[]) =>
    tool("agent-tools_suggest_tasks", { after_result: true, tasks });

  it("names the first work task the result ended on, never a routine", async () => {
    const turnEnded = vi.fn();
    const { run } = setup({ deps: { turnEnded } });
    await run("Build me a portfolio page", [
      presentSite,
      text(LONG_REPLY),
      nextStep([
        { text: "Every Monday, check my site", routine: true },
        { text: "Put my real name and projects in" },
      ]),
    ]);
    expect(turnEnded).toHaveBeenCalledWith(
      "s1",
      "site",
      "Put my real name and projects in",
      LONG_REPLY
    );
  });

  it("hands a result over with no task when the turn ended without a next step", async () => {
    const turnEnded = vi.fn();
    const { run } = setup({ deps: { turnEnded } });
    await run("Make my CV a PDF", [presentFile, text(LONG_REPLY)]);
    expect(turnEnded).toHaveBeenCalledWith("s1", "file", null, null);
  });

  it("ignores tasks that are not a next step", async () => {
    const turnEnded = vi.fn();
    const { run } = setup({ deps: { turnEnded } });
    await run("Build me a portfolio page", [
      presentSite,
      text(LONG_REPLY),
      tool("agent-tools_suggest_tasks", { tasks: [{ text: "Something" }] }),
    ]);
    expect(turnEnded).toHaveBeenCalledWith("s1", "site", null, null);
  });

  it("tells every chat's ending: a chat app's result, a troubled turn, a question, a plain reply", async () => {
    const turnEnded = vi.fn();
    const { run } = setup({ deps: { turnEnded } });
    await run(
      "Build me a portfolio page",
      [presentSite, text(LONG_REPLY)],
      CHAT
    );
    await run("Build me a portfolio page", [
      presentSite,
      event({ type: "error", error: "boom" }),
      text(LONG_REPLY),
    ]);
    await run("Plan my week", [text("Which days are you free?")]);
    await run("Thanks", [text("Glad it helped.")]);
    expect(turnEnded.mock.calls).toEqual([
      ["s1", "site", null, null],
      ["s1", "unfinished", null, null],
      ["s1", "question", null, null],
      ["s1", "chat", null, null],
    ]);
  });

  it("tells it the user wrote, only for their own words", () => {
    const userWrote = vi.fn();
    const { watch } = setup({ deps: { userWrote } });
    watch.userSaid("s1", "[first run] Introduce yourself", {
      operator: { kind: "kickstart" },
    });
    expect(userWrote).not.toHaveBeenCalled();
    watch.userSaid("s1", "Add a dark mode");
    expect(userWrote).toHaveBeenCalledWith("s1");
  });
});
