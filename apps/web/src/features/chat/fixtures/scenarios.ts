import type { SuccessPitchOffer } from "@abacus-ai/contract/success-pitch";
import { v1ToUiMessages } from "@abacus-ai/contract/transcript/v1-to-ui-messages";
/**
 * Chat scenarios (spec 02 §11): the agent's recorded goldens replayed as
 * they are, plus builder scenarios for canvas states the goldens do not
 * cover. Each lists the canvas boards it reproduces (`canvas-map` is the
 * coverage table, R2-T29).
 */
import type { StreamChunk, UIMessage } from "@tanstack/ai";

import type { Draft } from "#renderer/lib/continuity/composer-drafts";

import * as b from "./builders";
import { golden } from "./goldens";
import type { RelayEvent } from "./relay";

export interface Scenario {
  id: string;
  canvas: string[];
  skin: "bot" | "session";
  /** The log main holds when the view opens. */
  events: () => RelayEvent[];
  /** A migrated (v1) transcript before the first event. */
  history?: () => UIMessage[];
  /** Composer and view overrides the gallery applies. */
  view?: {
    placeholder?: string;
    readOnly?: string;
    busyTurn?: boolean;
    model?: string;
    preStart?: boolean;
    banner?: string;
    draft?: Draft;
    dictating?: boolean;
    openPicker?: "mode" | "model";
    /** The success pitch offered under the latest reply. */
    successPitch?: Pick<
      SuccessPitchOffer,
      "trigger" | "moment" | "lead" | "name" | "detail"
    >;
    /** The deliverable offer judged without its caps. */
    deliverableOffer?: boolean;
    /** The retry offer on this model, without its caps. */
    retryOffer?: { label: string; plan: string };
    /** The composer's top-model hint on a paying plan, without its caps. */
    topModels?: boolean;
    /** The turns' files on the deliverables card, as the sessions route shows them. */
    deliverables?: boolean;
    /** The shell's upgrade dialog, for a line or card in the chat that opens it. */
    upgradeDialog?: boolean;
  };
  /** Canned answer to a send in the gallery (echo + reply). */
  reply?: string;
}

const seqd = (events: readonly StreamChunk[]): RelayEvent[] =>
  events.map((event, index) => ({ seq: index + 1, event }));

const at = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000;

const userTurn = (
  runId: string,
  id: string,
  text: string,
  when?: number
): StreamChunk[] => [
  b.runStarted(runId, when != null ? { timestamp: when } : {}),
  ...b.text(id, "user", text),
];

// ─── bots ───────────────────────────────────────────────────────────────

const botChat = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "What needs me before noon?", at(30)),
    ...b.text("a1", "assistant", "On it."),
    ...b.text(
      "a2",
      "assistant",
      "Two things. The design review moved to **11:30**, and the contract from legal needs your signature today."
    ),
    b.runFinished("r1", "success", { timestamp: at(29) }),
    ...userTurn(
      "r2",
      "u2",
      "Reply to legal that I will sign after lunch.\n\n@/Users/me/Documents/contract-v3.pdf",
      at(5)
    ),
    b.textStart("a3"),
    ...b.toolCall("c1", "gmail_draft", "a3", {
      to: "legal@northwind.example",
      subject: "Contract",
    }),
    b.toolResult("c1", { text: "Draft saved" }),
    b.textDelta("a3", "Drafted it. Want me to send it from Gmail?"),
    b.textEnd("a3"),
    b.runFinished("r2", "success", { timestamp: at(4) }),
  ]);

const botTyping = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "What's new in the news today?", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "browser_navigate", "a1", {
      url: "https://news.example.com",
    }),
  ]);

const botApproval = (): RelayEvent[] => {
  const d = b.descriptor(
    {
      type: "generic",
      toolName: "gmail_send",
      inputSummary:
        "To legal@northwind.example: Thanks for the updated contract. I will sign it after lunch today.",
      tool: { id: "c1", name: "gmail_send", type: "other", input: {} },
      displayName: "Send email",
    } as never,
    { id: "p1", toolCallId: "c1", runId: "r1" }
  );
  return seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn(
      "r1",
      "u1",
      "Reply to legal that I will sign after lunch.",
      at(2)
    ),
    b.textStart("a1"),
    ...b.toolCall("c1", "gmail_send", "a1", { to: "legal@northwind.example" }),
    ...b.permissionEvents([d], d),
  ]);
};

const botQueue = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Draft the weekly update for finance.", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "read", "a1", { path: "notes/week.md" }),
    b.custom("queue.updated", {
      messages: [
        {
          id: "q-1",
          message: "Also copy the finance team",
          waitingFor: "turn",
        },
      ],
      dequeued: null,
    }),
  ]);

/** The verify loop's line, as the agent writes it: a tagged user-role message. */
const appLine = (
  id: string,
  kind: "test-repair" | "test-repair-limit",
  text: string
): StreamChunk[] =>
  b.text(id, "user", text, {
    metadata: { abacus: { userText: { operator: { kind } } } },
  });

const testRepair = (limit: boolean): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Make add() take a third argument.", at(2)),
    ...b.text(
      "a1",
      "assistant",
      "Done: `add` now takes a third argument, defaulting to 0."
    ),
    ...appLine(
      "l1",
      "test-repair",
      "Tests failed after my change, fixing them."
    ),
    ...b.text(
      "a2",
      "assistant",
      limit
        ? "I couldn't finish the fix: `test_add_negative` still fails. The change to `add` is in `calc.py`."
        : "My change broke `test_add_negative`: the default swallowed the sign. Fixed in `calc.py`, and the tests pass."
    ),
    ...(limit
      ? appLine(
          "l2",
          "test-repair-limit",
          "I stopped fixing the tests: this automatic repair reached its limit. Nothing else runs until you send a message."
        )
      : []),
    b.runFinished("r1"),
  ]);

const botBanners = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    b.custom("agent.notification", {
      severity: "warning",
      message: "You have 120 credits left this month.",
      notificationKey: "credits-low",
    }),
    ...userTurn("r1", "u1", "Summarise my inbox", at(10)),
    ...b.text(
      "a1",
      "assistant",
      "Nothing urgent. Three newsletters and a calendar invite."
    ),
    b.runFinished("r1"),
  ]);

const botUnread = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...Array.from({ length: 14 }, (_, index) => [
      ...userTurn(
        `r${index}`,
        `u${index}`,
        `Check item ${index + 1}`,
        at(300 - index * 10)
      ),
      ...b.text(
        `a${index}`,
        "assistant",
        `Item ${index + 1} is fine. Nothing to do.`
      ),
      b.runFinished(`r${index}`),
    ]).flat(),
  ]);

// ─── sessions ──────────────────────────────────────────────────────────

const sessionRunning = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    b.custom("skills.loaded", {
      skills: [
        {
          id: "review",
          name: "review",
          description: "Review a diff",
          location: "",
        },
      ],
    }),
    ...userTurn(
      "r1",
      "u1",
      "Reopening the sidebar closes the side panel when it is at full width. Find out why and fix it.",
      at(3)
    ),
    b.textStart("a1"),
    b.textDelta(
      "a1",
      "The restore takes all of its width from the centre column. With the side panel at its maximum the centre has nothing left to give, so the layout cannot be honoured."
    ),
    ...b.toolCall("c1", "read", "a1", {
      path: "src/components/layout/workspace-view.tsx",
      offset: 168,
      limit: 100,
    }),
    b.toolResult("c1", { text: "…", display: { lineCount: 101 } }),
    ...b.toolCall("c2", "grep", "a1", { pattern: "setShellPanelVisible" }),
    b.toolResult("c2", {
      text: "Found 4 matches\nsrc/a.ts:1\nsrc/b.ts:2\nsrc/c.ts:3\nsrc/d.ts:4",
    }),
    ...b.toolCall("c3", "edit", "a1", {
      path: "src/components/layout/workspace-view.tsx",
    }),
    b.custom("tool.display", {
      toolCallId: "c3",
      data: {
        originalContent: "mainArea: centerSize - restoredSize,",
        newContent:
          "mainArea: centerSize - fromCenter,\n[oppositeId]: oppositeSize - fromOpposite,",
        additions: 24,
        deletions: 5,
      },
    }),
    b.toolResult("c3", { text: "Edited" }),
    ...b.toolCall("c4", "bash", "a1", {
      command: "pnpm exec vitest run src/components/layout",
    }),
    b.custom("tool.output", {
      toolCallId: "c4",
      output: " RUN  v4.1.11\n ✓ layout.test.ts (12 tests)\n",
    }),
    b.custom("agent.status", { status: "executing-tool" }),
    b.stateSnapshot({
      mode: "DEFAULT",
      modeSource: "startup",
      model: "route-llm",
      incarnation: "inc-1",
      plan: [
        {
          content: "Take the width from the centre first",
          status: "completed",
        },
        {
          content: "Take the rest from the opposite panel",
          status: "completed",
        },
        {
          content: "Add a test for the full-width case",
          status: "in_progress",
        },
        { content: "Run the suite", status: "pending" },
      ],
    }),
    b.custom("queue.updated", {
      messages: [
        {
          id: "q-1",
          message: "Also add a test for the full-width case",
          waitingFor: "step",
        },
      ],
      dequeued: null,
    }),
  ]);

const sessionReview = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "ACCEPTEDITS"),
    ...userTurn(
      "r1",
      "u1",
      "Rename `useShellState` to `useShell` everywhere.",
      at(8)
    ),
    b.textStart("a1"),
    ...b.toolCall("c1", "grep", "a1", { pattern: "useShellState" }),
    b.toolResult("c1", { text: "Found 7 matches" }),
    ...b.toolCall("c2", "edit", "a1", { path: "src/shell.ts" }),
    b.toolResult("c2", {
      text: "Edited",
      display: {
        originalContent: "export const useShellState",
        newContent: "export const useShell",
        additions: 1,
        deletions: 1,
      },
    }),
    b.textDelta(
      "a1",
      "Done. Seven call sites renamed; the type check passes.\n\n```ts\nexport const useShell = () => useStore(shellStore);\n```\n\nThe rename is mechanical, so $O(n)$ in files touched:\n\n$$\\sum_{i=1}^{n} f_i = 7$$"
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(7) }),
  ]);

const sessionFailedRateLimit = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn("r1", "u1", "Write the migration for the new tables.", at(2)),
    b.runError("r1", {
      message: "Claude is rate limited right now.",
      code: "turn_failed",
      detail: "429: Too many requests. Retry in 41s.",
      actions: [
        { type: "switch-model", model: "abacus/route-llm", label: "Abacus.AI" },
        { type: "retry" },
      ],
    }),
  ]);

/**
 * How a turn ends when an account, not the request, said no: the user's own
 * key out of quota (with Abacus credits left, and with them used up too),
 * Abacus's credit wall (spent, expired) and its billing gate (a payment not
 * confirmed, a subscription that lapsed). The errors as presentFailure
 * (packages/agent turn-outcome.ts) words them.
 */
const OWN_KEY_DETAIL =
  "429: You exceeded your current quota, please check your plan and billing details.";
const OWN_KEY_LINE =
  "Your Google Gemini key hit its quota. Switch to a different model, or check the key's plan.";
const OWN_KEY_GONE = {
  type: "own-key-unavailable",
  provider: "nvidia",
  cause: "gone",
  model: "nvidia/moonshotai/kimi-k3",
  label: "Kimi K3",
  free: true,
};
const OUTCOME_ERRORS: Record<
  string,
  {
    message: string;
    cause: string;
    detail: string;
    actions: Array<Record<string, unknown>>;
  }
> = {
  "own-key-quota": {
    message: OWN_KEY_LINE,
    cause: "own_key_quota",
    detail: OWN_KEY_DETAIL,
    actions: [
      { type: "fix-key", provider: "gemini" },
      { type: "switch-to-abacus" },
    ],
  },
  "own-key-quota-abacus-out": {
    message: OWN_KEY_LINE,
    cause: "own_key_quota",
    detail: OWN_KEY_DETAIL,
    actions: [
      { type: "fix-key", provider: "gemini" },
      { type: "upgrade-abacus", cause: "exhausted" },
    ],
  },
  // Another provider's free model gone (NVIDIA's 410), credits left and not.
  "own-key-gone": {
    message:
      "The model provider had a problem (410). Try again, or switch to a different model.",
    cause: "model_unavailable",
    detail: "410 status code (no body)",
    actions: [OWN_KEY_GONE, { type: "switch-to-abacus" }],
  },
  "own-key-gone-abacus-out": {
    message:
      "The model provider had a problem (410). Try again, or switch to a different model.",
    cause: "model_unavailable",
    detail: "410 status code (no body)",
    actions: [OWN_KEY_GONE],
  },
  "credits-exhausted": {
    message:
      "You're out of credits (429). Upgrade your plan to keep going, or switch to a model with its own key.",
    cause: "credits_exhausted",
    detail: "429: You have no remaining credits to use the LLM apis.",
    actions: [{ type: "upgrade-abacus", cause: "exhausted" }],
  },
  "credits-expired": {
    message:
      "Your free credits have expired (429). Upgrade your plan to keep going.",
    cause: "credits_expired",
    detail:
      "429: Your free AbacusAI credits have expired. You have no remaining credits to use the LLM apis.",
    actions: [{ type: "upgrade-abacus", cause: "expired" }],
  },
  "payment-unconfirmed": {
    message:
      "We couldn't confirm your last payment. If your subscription is active, contact support@abacus.ai. Please don't purchase again.",
    cause: "payment_required",
    detail:
      '402 "We could not confirm the last payment on this subscription. If your subscription is active, please contact support@abacus.ai - do not purchase again."',
    actions: [
      { type: "payment-required", cause: "unconfirmed" },
      { type: "switch-model" },
    ],
  },
  "payment-lapsed": {
    message:
      "Your Abacus.AI subscription has ended. Renew it to keep going, or switch to a model with its own key.",
    cause: "payment_required",
    detail: '402 "Your subscription has ended. Please renew it to continue."',
    actions: [
      { type: "payment-required", cause: "lapsed" },
      { type: "switch-model" },
    ],
  },
  "verify-phone": {
    message:
      "Verify your phone to unlock 2,000 free credits. Verify it once at https://apps.abacus.ai/bot/link/verify-phone, then send your message again.",
    cause: "phone_verification",
    detail:
      "429: Verify your phone to unlock 2,000 free credits: https://apps.abacus.ai/bot/link/verify-phone",
    actions: [
      {
        type: "verify-phone",
        link: "https://apps.abacus.ai/bot/link/verify-phone",
        credits: "2,000",
      },
    ],
  },
};

// ─── the success pitch ─────────────────────────────────────────────────

const SITE_URL = "http://127.0.0.1:58702";

const retryAfterComplaint = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Fix the login page crash", at(6)),
    b.textStart("a1"),
    ...b.toolCall("c1", "edit", "a1", { file_path: "/Users/me/app/login.js" }),
    b.toolResult("c1", { text: "Edited login.js" }),
    b.textDelta("a1", "Fixed: the empty password case no longer throws."),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(5) }),
    ...userTurn("r2", "u2", "It still doesn't work, same error", at(2)),
    b.textStart("a2"),
    ...b.toolCall("c2", "edit", "a2", { file_path: "/Users/me/app/login.js" }),
    b.toolResult("c2", { text: "Edited login.js" }),
    b.textDelta(
      "a2",
      "I changed how the session is read. Try signing in again."
    ),
    b.textEnd("a2"),
    b.runFinished("r2", "success", { timestamp: at(1) }),
  ]);

const headerAnswered = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Make the header sticky on scroll", at(3)),
    b.textStart("a1"),
    ...b.toolCall("c1", "edit", "a1", {
      file_path: "/Users/me/app/header.css",
    }),
    b.toolResult("c1", { text: "Edited header.css" }),
    b.textDelta(
      "a1",
      "Done: the header now stays at the top while you scroll."
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(2) }),
  ]);

const nextStepStore = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Put my store online", at(3)),
    b.textStart("a1"),
    ...b.toolCall("c1", "write", "a1", {
      file_path: "/Users/me/store/index.html",
    }),
    b.toolResult("c1", { text: "Wrote index.html" }),
    b.textDelta(
      "a1",
      "Your store is live, and orders will arrive in your Gmail. Want a summary of new orders every morning?"
    ),
    ...b.toolCall("c2", "suggest_tasks", "a1", {
      after_result: true,
      tasks: [
        { text: "Every morning at 9, sum up my new orders", routine: true },
        { text: "Add a contact form" },
      ],
    }),
    b.toolResult("c2", { text: "The user sees 2 buttons under your reply." }),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(1) }),
  ]);

const successSite = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Build a one-page site for my bakery", at(3)),
    b.textStart("a1"),
    ...b.toolCall("c1", "write", "a1", {
      file_path: "/Users/me/bakery/index.html",
    }),
    b.toolResult("c1", { text: "Wrote index.html" }),
    ...b.toolCall("c2", "agent-tools_present_deliverable", "a1", {
      items: [{ path: "/Users/me/bakery/index.html" }, { path: SITE_URL }],
    }),
    b.toolResult("c2", {
      text: `[artifact] /Users/me/bakery/index.html\n[artifact] ${SITE_URL}`,
    }),
    b.textDelta(
      "a1",
      "Done. It's open in the preview: a hero with your photo, the menu with prices, opening hours and a WhatsApp button for orders. No build step, it opens straight away."
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(2) }),
  ]);

/** A build that has written fifteen files: the big-build card's moment. */
const successBigTask = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn(
      "r1",
      "u1",
      "Build a snake game with 10 levels, a high-score board and sound effects",
      at(9)
    ),
    b.textStart("a1"),
    ...[
      "index.html",
      "style.css",
      "game.js",
      "board.js",
      "snake.js",
      "food.js",
      "levels.js",
      "level-data.json",
      "scores.js",
      "input.js",
      "sound.js",
      "menu.js",
      "pause.js",
      "assets/eat.wav",
      "assets/crash.wav",
    ].flatMap((file, index) => [
      ...b.toolCall(`w${index}`, "write", "a1", {
        path: `/Users/me/snake/${file}`,
      }),
      b.toolResult(`w${index}`, { text: `Wrote ${file}` }),
    ]),
    b.textDelta(
      "a1",
      "Levels 1 and 2 are playable in the preview: movement, food, walls, speed-up, and the high-score board. Next come levels 3 to 10, the sound effects and a pause menu."
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(2) }),
  ]);

/** A bot started in the background: "keep it running" for a server. */
const successKeepServer = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn(
      "r1",
      "u1",
      "Make a Telegram bot that posts the Bitcoin price to my channel every hour",
      at(7)
    ),
    b.textStart("a1"),
    ...b.toolCall("c1", "write", "a1", { path: "/Users/me/btc-bot/bot.py" }),
    b.toolResult("c1", { text: "Wrote bot.py" }),
    ...b.toolCall("c2", "bash", "a1", {
      command: "cd btc-bot && python bot.py",
      background: true,
    }),
    b.toolResult("c2", { text: "Started in the background." }),
    b.textDelta(
      "a1",
      "Your bot is running and just posted the first price to your channel. It posts again every hour while this computer is on."
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(2) }),
  ]);

/** A routine created: "keep it running" for a routine. */
const successKeepRoutine = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn(
      "r1",
      "u1",
      "Every morning at 8, send me the top 5 AI headlines",
      at(5)
    ),
    b.textStart("a1"),
    ...b.toolCall("c1", "agent-tools_cronjob", "a1", {
      action: "create",
      name: "Morning AI headlines",
      schedule: "0 8 * * *",
    }),
    b.toolResult("c1", { text: "Created. Morning AI headlines" }),
    b.textDelta(
      "a1",
      "Done: “Morning AI headlines” runs every day at 8:00 and sends you the top 5 AI stories with a line on each."
    ),
    b.textEnd("a1"),
    b.runFinished("r1", "success", { timestamp: at(2) }),
  ]);

/** A result, then the user's thanks and the bot's answer, in their language. */
const successThanks =
  (words: { ask: string; done: string; thanks: string; welcome: string }) =>
  (): RelayEvent[] =>
    seqd([
      ...b.sessionReady("inc-1", "YOLO"),
      ...userTurn("r1", "u1", words.ask, at(6)),
      b.textStart("a1"),
      ...b.toolCall("c1", "write", "a1", {
        file_path: "/Users/me/Desktop/calculator.html",
      }),
      b.toolResult("c1", { text: "Wrote calculator.html" }),
      b.textDelta("a1", words.done),
      b.textEnd("a1"),
      b.runFinished("r1", "success", { timestamp: at(5) }),
      ...userTurn("r2", "u2", words.thanks, at(2)),
      ...b.text("a2", "assistant", words.welcome),
      b.runFinished("r2", "success", { timestamp: at(1) }),
    ]);

// ─── the deliverable offer ─────────────────────────────────────────────

interface OfferWords {
  ask: string;
  answer: string;
  request: string;
  brief: string;
  path: string;
  label: string;
  done: string;
  quick: string;
  quickAnswer: string;
}

const OFFER_EN: OfferWords = {
  ask: "Compare Notion, Obsidian and Logseq for a five-person team that keeps shared meeting notes and a small wiki.",
  answer: [
    "Short version: **Notion** if the team wants one shared space with the least setup, **Obsidian** if people care most about owning plain files, and **Logseq** if your notes are mostly daily meeting logs.",
    "",
    "## At a glance",
    "",
    "| | Notion | Obsidian | Logseq |",
    "| --- | --- | --- | --- |",
    "| Real-time collaboration | Built in | Paid Sync, not live | Limited |",
    "| Where notes live | Notion's cloud | Local Markdown files | Local Markdown files |",
    "| Wiki structure | Pages and databases | Folders and links | Outline and links |",
    "| Cost for 5 people | About $50/month | Free, Sync $4/user | Free |",
    "| Offline | Partial | Full | Full |",
    "",
    "## Meeting notes",
    "",
    "Notion's templates and database views make recurring meetings easy: one database, a template per meeting type, filters by owner. Logseq's daily journal is the fastest place to type during a call, and its block references pull action items into one page. Obsidian needs a community plugin to match either.",
    "",
    "## The wiki",
    "",
    "For a small wiki that several people edit, Notion wins: permissions, comments and page history work without setup. Obsidian's graph and backlinks are excellent for one person's knowledge, but shared editing depends on syncing files, which leads to conflicts when two people edit at once.",
    "",
    "## Recommendation",
    "",
    "- Start with Notion for the shared wiki and meeting database.",
    "- Let anyone who prefers local files keep a personal Obsidian vault.",
    "- Revisit in three months: if most notes are daily logs, try Logseq for those.",
  ].join("\n"),
  request:
    "Turn your last answer into a polished report I can keep and share, saved as a PDF in the workspace.",
  brief:
    "A comparison of Notion, Obsidian and Logseq for a five-person team's shared meeting notes and wiki",
  path: "/Users/me/Documents/notes-tools-comparison.pdf",
  label: "Notes tools comparison",
  done: "Here's the report: the comparison table, a section each on meeting notes and the wiki, and the recommendation, on four pages.",
  quick: "What's the capital of Portugal?",
  quickAnswer: "Lisbon.",
};

const OFFER_PT: OfferWords = {
  ask: "Compare Notion, Obsidian e Logseq para uma equipe de cinco pessoas que mantém atas de reunião e uma pequena wiki.",
  answer: [
    "Resumindo: **Notion** se a equipe quer um espaço compartilhado com o mínimo de configuração, **Obsidian** se o mais importante é ter os arquivos em texto puro, e **Logseq** se as notas são principalmente registros diários de reuniões.",
    "",
    "## Visão geral",
    "",
    "| | Notion | Obsidian | Logseq |",
    "| --- | --- | --- | --- |",
    "| Colaboração em tempo real | Nativa | Sync pago, não ao vivo | Limitada |",
    "| Onde ficam as notas | Nuvem do Notion | Arquivos Markdown locais | Arquivos Markdown locais |",
    "| Estrutura de wiki | Páginas e bancos de dados | Pastas e links | Tópicos e links |",
    "| Custo para 5 pessoas | Cerca de US$ 50/mês | Grátis, Sync US$ 4/usuário | Grátis |",
    "| Offline | Parcial | Completo | Completo |",
    "",
    "## Atas de reunião",
    "",
    "Os modelos e as visualizações de banco de dados do Notion facilitam reuniões recorrentes: um banco de dados, um modelo por tipo de reunião e filtros por responsável. O diário do Logseq é o lugar mais rápido para digitar durante uma chamada, e as referências de bloco reúnem as tarefas numa só página. O Obsidian precisa de um plugin da comunidade para chegar perto.",
    "",
    "## A wiki",
    "",
    "Para uma wiki pequena editada por várias pessoas, o Notion vence: permissões, comentários e histórico de páginas funcionam sem configuração. O grafo e os backlinks do Obsidian são ótimos para o conhecimento de uma pessoa, mas a edição compartilhada depende de sincronizar arquivos, o que gera conflitos quando duas pessoas editam ao mesmo tempo.",
    "",
    "## Recomendação",
    "",
    "- Comece com o Notion para a wiki e o banco de atas.",
    "- Quem preferir arquivos locais pode manter um cofre pessoal no Obsidian.",
    "- Reavalie em três meses: se a maioria das notas forem registros diários, teste o Logseq para eles.",
  ].join("\n"),
  request:
    "Transforme sua última resposta em um relatório bem acabado que eu possa guardar e compartilhar, salvo como PDF no espaço de trabalho.",
  brief:
    "Comparação entre Notion, Obsidian e Logseq para as atas e a wiki de uma equipe de cinco pessoas",
  path: "/Users/me/Documents/comparacao-ferramentas-de-notas.pdf",
  label: "Comparação de ferramentas de notas",
  done: "Aqui está o relatório: a tabela comparativa, uma seção sobre atas e outra sobre a wiki, e a recomendação, em quatro páginas.",
  quick: "Qual é a capital de Portugal?",
  quickAnswer: "Lisboa.",
};

const offerAnswered = (words: OfferWords): StreamChunk[] => [
  ...b.sessionReady("inc-1", "YOLO"),
  ...userTurn("r1", "u1", words.ask, at(9)),
  b.textStart("a1"),
  ...b.toolCall("c0", "web_search", "a1", {
    query: "Notion Obsidian Logseq team pricing collaboration",
  }),
  b.toolResult("c0", { text: "10 results" }),
  b.textDelta("a1", words.answer),
  b.textEnd("a1"),
  b.runFinished("r1", "success", { timestamp: at(8) }),
];

/** The document tool at work on the request the offer sent. */
const offerWorking = (words: OfferWords): StreamChunk[] => [
  ...offerAnswered(words),
  ...userTurn("r2", "u2", words.request, at(1)),
  b.textStart("a2"),
  ...b.toolCall("c1", "document", "a2", {
    brief: words.brief,
    output_path: words.path,
  }),
  b.subagentStarted("doc-1", "delegate", words.brief, "c1", "a2"),
];

const offerDelivered = (words: OfferWords): StreamChunk[] => [
  ...offerWorking(words),
  b.subagentFinished("doc-1", `Printed ${words.path}`),
  b.toolResult("c1", { text: `Printed ${words.path}` }),
  ...b.toolCall("c2", "agent-tools_present_deliverable", "a2", {
    items: [{ path: words.path, label: words.label }],
  }),
  b.toolResult("c2", { text: `[artifact] ${words.path}` }),
  b.textDelta("a2", words.done),
  b.textEnd("a2"),
  b.runFinished("r2", "success", { timestamp: at(0) }),
];

const offerShort = (words: OfferWords): StreamChunk[] => [
  ...b.sessionReady("inc-1", "YOLO"),
  ...userTurn("r1", "u1", words.quick, at(2)),
  ...b.text("a1", "assistant", words.quickAnswer),
  b.runFinished("r1", "success", { timestamp: at(1) }),
];

const offerScenarios = (locale: string, words: OfferWords): Scenario[] =>
  (
    [
      ["shown", offerAnswered, {}],
      ["working", offerWorking, {}],
      ["delivered", offerDelivered, { deliverables: true }],
      ["short", offerShort, {}],
    ] as const
  ).map(([state, events, view]) => ({
    id: `deliverable-offer-${state}-${locale.slice(0, 2)}`,
    canvas: ["DeliverableOffer", state, locale],
    skin: "session",
    events: () => seqd(events(words)),
    view: { deliverableOffer: true, ...view },
  }));

interface CreditWords {
  ask: string;
  answer: string;
}

const CREDITS_EN: CreditWords = {
  ask: "Find the three cheapest direct flights from Lisbon to Berlin next Friday.",
  answer:
    "The cheapest direct flights next Friday are TAP at 07:05 (€89), easyJet at 13:40 (€94) and Lufthansa at 18:20 (€131). TAP's fare includes a cabin bag; the other two charge for one.",
};

const CREDITS_PT: CreditWords = {
  ask: "Encontre os três voos diretos mais baratos de Lisboa para Berlim na próxima sexta-feira.",
  answer:
    "Os voos diretos mais baratos na próxima sexta são TAP às 07:05 (€89), easyJet às 13:40 (€94) e Lufthansa às 18:20 (€131). A tarifa da TAP inclui bagagem de mão; as outras duas cobram à parte.",
};

/**
 * A finished turn and what it billed: `credits` on its terminal as the agent
 * sends it (absent for a turn on the user's own key). The account read the
 * line's "left" comes from is the app's own.
 */
const creditsTurn =
  (words: CreditWords, credits?: number) => (): RelayEvent[] =>
    seqd([
      ...b.sessionReady("inc-1", "YOLO"),
      ...userTurn("r1", "u1", words.ask, at(3)),
      b.textStart("a1"),
      ...b.toolCall("c1", "web_search", "a1", {
        query: "Lisbon Berlin direct flights Friday",
      }),
      b.toolResult("c1", { text: "10 results" }),
      ...b.toolCall("c2", "web_fetch", "a1", {
        url: "https://www.example.com/flights/lis-ber",
      }),
      b.toolResult("c2", { text: "Fares loaded" }),
      b.textDelta("a1", words.answer),
      b.textEnd("a1"),
      b.runFinished("r1", "success", {
        timestamp: at(2),
        ...(credits != null && {
          metadata: { abacus: { turnUsage: { credits } } },
        }),
      }),
    ]);

const sessionOutcome = (kind: string) => (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn("r1", "u1", "Summarize the open pull requests.", at(1)),
    b.runError("r1", { code: "turn_failed", ...OUTCOME_ERRORS[kind]! }),
  ]);

const sessionSubagents = (): RelayEvent[] =>
  seqd([
    ...b.sessionReady("inc-1", "YOLO"),
    ...userTurn("r1", "u1", "Audit the three packages in parallel.", at(4)),
    b.textStart("a1"),
    ...b.toolCall("c1", "delegate_task", "a1", {
      task: "Audit packages/agent",
    }),
    ...b.toolCall("c2", "delegate_task", "a1", {
      task: "Audit packages/connectors",
    }),
    ...b.toolCall("c3", "delegate_task", "a1", { task: "Audit apps/updater" }),
    b.subagentStarted("sub-1", "delegate", "Audit packages/agent", "c1", "a1"),
    b.subagentStarted(
      "sub-2",
      "delegate",
      "Audit packages/connectors",
      "c2",
      "a1"
    ),
    b.subagentStarted("sub-3", "delegate", "Audit apps/updater", "c3", "a1"),
    ...b.toolCall(
      "sub-1:t1",
      "ls",
      "",
      { path: "packages/agent" },
      { subagentRunId: "sub-1" }
    ),
    b.toolResult(
      "sub-1:t1",
      { text: "src\npackage.json" },
      { subagentRunId: "sub-1" }
    ),
    ...b.text("sub-1:final", "assistant", "No issues.", {
      subagentRunId: "sub-1",
    }),
    b.subagentFinished("sub-1", "No issues."),
    ...b.toolCall(
      "sub-2:t1",
      "read",
      "",
      { path: "packages/connectors/src/index.ts" },
      { subagentRunId: "sub-2" }
    ),
    b.subagentError("sub-3", "Stopped at its limit"),
  ]);

const sessionSandboxRefused = (): RelayEvent[] => {
  const d = b.descriptor(
    {
      type: "sandbox_denied",
      command: "npm install left-pad",
      denials: [
        { kind: "write", path: "/Users/me/.npm/_cacache" },
        { kind: "host", host: "registry.npmjs.org", port: 443 },
      ],
      note: "It installs a package into the global cache.",
      tool: { id: "c1", name: "bash", type: "bash", input: {} },
      displayName: "Run command",
    } as never,
    {
      id: "p1",
      toolCallId: "c1",
      runId: "r1",
      allowed: [
        "accept",
        "reject",
        "allowAlways",
        "accept_with_message",
        "reject_with_message",
      ],
    }
  );
  return seqd([
    ...b.sessionReady("inc-1", "AUTO"),
    ...userTurn("r1", "u1", "Add left-pad", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "bash", "a1", { command: "npm install left-pad" }),
    ...b.permissionEvents([d], d),
  ]);
};

const permission =
  (
    request: Record<string, unknown>,
    toolName: string,
    input: Record<string, unknown>,
    mode = "DEFAULT",
    allowed?: string[]
  ) =>
  (): RelayEvent[] => {
    const d = b.descriptor(
      {
        ...request,
        tool: { id: "c1", name: toolName, type: toolName, input },
        displayName: toolName,
      } as never,
      {
        id: "p1",
        toolCallId: "c1",
        runId: "r1",
        ...(allowed != null ? { allowed } : {}),
      }
    );
    return seqd([
      ...b.sessionReady("inc-1", mode),
      ...userTurn("r1", "u1", "Go ahead", at(1)),
      b.textStart("a1"),
      ...b.toolCall("c1", toolName, "a1", input),
      ...b.permissionEvents([d], d),
    ]);
  };

const SANDBOX = [
  "accept",
  "accept_with_message",
  "background",
  "allowAlways",
  "allow_always_with_rule",
  "allow_always_with_rules",
  "allowYolo",
  "reject",
  "reject_with_message",
];

const twoPermissions = (): RelayEvent[] => {
  const d1 = b.descriptor(
    {
      type: "run_terminal",
      command: "git push origin fix/sidebar-restore",
      cwd: "/repo",
      background: false,
      tool: { id: "c1", name: "bash", type: "bash", input: {} },
      displayName: "Run",
    } as never,
    { id: "p1", toolCallId: "c1", allowed: SANDBOX }
  );
  const d2 = b.descriptor(
    {
      type: "edit_file",
      filePath: "src/workspace-view.tsx",
      originalContent: "a\nb",
      newContent: "a\nc",
      tool: { id: "c2", name: "edit", type: "edit", input: {} },
      displayName: "Edit",
    } as never,
    { id: "p2", toolCallId: "c2" }
  );
  return seqd([
    ...b.sessionReady("inc-1", "DEFAULT"),
    ...userTurn("r1", "u1", "Ship it", at(1)),
    b.textStart("a1"),
    ...b.toolCall("c1", "bash", "a1", {
      command: "git push origin fix/sidebar-restore",
    }),
    ...b.toolCall("c2", "edit", "a1", { path: "src/workspace-view.tsx" }),
    ...b.permissionEvents([d1, d2]),
  ]);
};

const idleSession =
  (mode = "DEFAULT") =>
  (): RelayEvent[] =>
    seqd([
      ...b.sessionReady("inc-1", mode),
      ...userTurn("r1", "u1", "Why does the split view fold at 900?", at(20)),
      ...b.text(
        "a1",
        "assistant",
        "It folds when both panes would drop below their 360 px minimum."
      ),
      b.runFinished("r1"),
    ]);

const empty = (): RelayEvent[] => seqd(b.sessionReady("inc-1", "DEFAULT"));

const fromGolden = (name: string) => () => golden(name);

const migratedHistory = (): UIMessage[] => {
  const raw = import.meta.glob<unknown>(
    "../../../../../../packages/contract/src/transcript/__fixtures__/v1/*.json",
    {
      import: "default",
      eager: true,
    }
  );
  return Object.entries(raw).flatMap(([path, file]) => {
    const name = /([^/]+)\.json$/.exec(path)![1]!;
    const segments = Array.isArray(file)
      ? file
      : ((file as { segments?: unknown[] }).segments ?? []);
    return v1ToUiMessages(segments).map((message) => ({
      ...message,
      id: `${name}:${message.id}`,
    }));
  });
};

export const SCENARIOS: Scenario[] = [
  {
    id: "turn-credits-en",
    canvas: ["TurnCredits", "Abacus turn"],
    skin: "session",
    events: creditsTurn(CREDITS_EN, 18.4),
    view: { upgradeDialog: true },
  },
  {
    id: "turn-credits-pt",
    canvas: ["TurnCredits", "Abacus turn", "pt-BR"],
    skin: "session",
    events: creditsTurn(CREDITS_PT, 18.4),
    view: { upgradeDialog: true },
  },
  {
    id: "turn-credits-own-key-en",
    canvas: ["TurnCredits", "own key"],
    skin: "session",
    events: creditsTurn(CREDITS_EN),
  },
  ...offerScenarios("en", OFFER_EN),
  ...offerScenarios("pt-BR", OFFER_PT),
  {
    id: "retry-offer-session",
    canvas: ["RetryOffer", "session"],
    skin: "session",
    events: retryAfterComplaint,
    view: { retryOffer: { label: "Claude Opus 5.5", plan: "Basic" } },
  },
  {
    id: "retry-offer-bot",
    canvas: ["RetryOffer", "bot"],
    skin: "bot",
    events: retryAfterComplaint,
    view: {
      placeholder: "Message your bot...",
      retryOffer: { label: "Claude Opus 5.5", plan: "Basic" },
    },
  },
  {
    id: "top-model-hint-session",
    canvas: ["TopModelHint", "session"],
    skin: "session",
    events: headerAnswered,
    view: { model: "RouteLLM", topModels: true },
  },
  {
    id: "next-step-session",
    canvas: ["NextStep", "session"],
    skin: "session",
    events: nextStepStore,
  },
  {
    id: "next-step-bot",
    canvas: ["NextStep", "bot"],
    skin: "bot",
    events: nextStepStore,
    view: { placeholder: "Message your bot..." },
  },
  {
    id: "success-site",
    canvas: ["SuccessPitchCard", "site"],
    skin: "bot",
    events: successSite,
    view: {
      placeholder: "Message your bot...",
      successPitch: { trigger: "deliverable", moment: "site", lead: "apps" },
    },
  },
  {
    id: "success-big-task",
    canvas: ["BigTaskCard", "15 files"],
    skin: "session",
    events: successBigTask,
    view: {
      successPitch: {
        trigger: "big_task",
        moment: "big_task",
        lead: "apps",
        detail: "15",
      },
    },
  },
  {
    id: "success-keep-server",
    canvas: ["KeepRunningCard", "server"],
    skin: "session",
    events: successKeepServer,
    view: {
      successPitch: {
        trigger: "keep_running",
        moment: "server",
        lead: "agents",
        name: "btc-bot",
      },
    },
  },
  {
    id: "success-keep-routine",
    canvas: ["KeepRunningCard", "routine"],
    skin: "session",
    events: successKeepRoutine,
    view: {
      successPitch: {
        trigger: "keep_running",
        moment: "routine",
        lead: "agents",
        name: "Morning AI headlines",
      },
    },
  },
  {
    id: "success-thanks-en",
    canvas: ["SuccessPitchCard", "positive reaction"],
    skin: "bot",
    events: successThanks({
      ask: "Make me a calculator on my desktop",
      done: "Done: calculator.html is on your desktop. It adds, subtracts, multiplies and divides, keeps a running total, and works with the keyboard too.",
      thanks: "perfect, thank you!",
      welcome: "You're welcome! I can add a history panel next if you'd like.",
    }),
    view: {
      placeholder: "Message your bot...",
      successPitch: {
        trigger: "positive_reaction",
        moment: "reaction",
        lead: null,
      },
    },
  },
  {
    id: "success-thanks-tr",
    canvas: ["SuccessPitchCard", "positive reaction", "tr-TR"],
    skin: "bot",
    events: successThanks({
      ask: "Masaüstüme bir hesap makinesi yap",
      done: "Tamam: calculator.html masaüstünde. Toplama, çıkarma, çarpma ve bölme yapıyor, ara toplamı tutuyor ve klavyeyle de çalışıyor.",
      thanks: "harika olmuş, çok teşekkürler!",
      welcome:
        "Rica ederim! Hesap makinesi masaüstünde, istersen geçmiş ekranı da ekleyebilirim.",
    }),
    view: {
      placeholder: "Bir mesaj yaz...",
      successPitch: {
        trigger: "positive_reaction",
        moment: "reaction",
        lead: null,
      },
    },
  },
  {
    id: "success-thanks-pt",
    canvas: ["SuccessPitchCard", "positive reaction", "pt-BR"],
    skin: "bot",
    events: successThanks({
      ask: "Faça uma calculadora na minha área de trabalho",
      done: "Pronto: calculator.html está na sua área de trabalho. Ela soma, subtrai, multiplica e divide, guarda o total parcial e também funciona pelo teclado.",
      thanks: "valeu, ficou perfeito!",
      welcome: "De nada! Se quiser, posso adicionar um histórico das contas.",
    }),
    view: {
      placeholder: "Escreva uma mensagem...",
      successPitch: {
        trigger: "positive_reaction",
        moment: "reaction",
        lead: null,
      },
    },
  },
  {
    id: "bot-message-inline-links",
    canvas: ["Inline reply links"],
    skin: "bot",
    events: () =>
      seqd([
        ...b.sessionReady("inc-inline-links", "YOLO"),
        ...userTurn(
          "r-inline-links",
          "u-inline-links",
          "Compare these references. Keep www.example.com/docs plain in my message."
        ),
        ...b.text(
          "a-inline-links",
          "assistant",
          "Start with https://developer.mozilla.org/en-US/docs/Web/JavaScript, read https://www.typescriptlang.org/docs/, and compare https://example.com/. The [reference guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript) keeps its label.\n\nCode stays literal: `https://example.com/code`."
        ),
        b.runFinished("r-inline-links", "success"),
      ]),
  },
  {
    id: "bot-message-links-loading",
    canvas: ["Reply preview loading"],
    skin: "bot",
    events: () =>
      seqd([
        ...b.sessionReady("inc-loading", "YOLO"),
        ...userTurn("r-loading", "u-loading", "Show the two references."),
        ...b.text(
          "a-loading",
          "assistant",
          "Read https://httpbin.org/delay/3?inline-preview=loading. The link stays usable while its preview loads."
        ),
        b.runFinished("r-loading", "success"),
      ]),
  },
  {
    id: "bot-message-links-failed",
    canvas: ["Reply preview failure"],
    skin: "bot",
    events: () =>
      seqd([
        ...b.sessionReady("inc-failed", "YOLO"),
        ...userTurn(
          "r-failed",
          "u-failed",
          "Keep the link usable even if its preview fails."
        ),
        ...b.text(
          "a-failed",
          "assistant",
          "This page has no preview: https://example.com/not-a-preview. The reply stays readable."
        ),
        b.runFinished("r-failed", "success"),
      ]),
  },
  {
    id: "bot-message-links",
    canvas: ["Reply links and selection"],
    skin: "bot",
    events: () =>
      seqd([
        ...b.sessionReady("inc-links", "YOLO"),
        ...userTurn(
          "r-links",
          "u-links",
          "Please compare these two references. Keep this paragraph selectable, including www.example.com/docs which should stay plain in my message."
        ),
        ...b.text(
          "a-links",
          "assistant",
          "You can select this entire paragraph, copy a word, or use the keyboard to extend your selection. Read https://developer.mozilla.org/en-US/docs/Web/JavaScript and https://example.com/ for the two references.\n\nCode stays literal: `https://example.com/code`."
        ),
        b.runFinished("r-links", "success"),
      ]),
  },
  { id: "bot-chat", canvas: ["BotChat"], skin: "bot", events: botChat },
  {
    id: "bot-chat-scrolled",
    canvas: ["BotChatScrolled"],
    skin: "bot",
    events: botUnread,
  },
  {
    id: "bot-approval-inline",
    canvas: ["BotApproval"],
    skin: "bot",
    events: botApproval,
  },
  {
    id: "bot-typing",
    canvas: ["BotChatPanel"],
    skin: "bot",
    events: botTyping,
  },
  {
    id: "bot-unread-marker",
    canvas: ["BotChannel"],
    skin: "bot",
    events: botUnread,
  },
  { id: "bot-banners", canvas: ["BotStates"], skin: "bot", events: botBanners },
  {
    id: "session-test-repair",
    canvas: [],
    skin: "session",
    events: () => testRepair(false),
  },
  {
    id: "session-test-repair-limit",
    canvas: [],
    skin: "session",
    events: () => testRepair(true),
  },
  {
    id: "bot-model-chip",
    canvas: ["BotDetails"],
    skin: "bot",
    events: idleSession("YOLO"),
    view: { model: "RouteLLM" },
  },
  {
    id: "bot-golden-plain",
    canvas: [],
    skin: "bot",
    events: fromGolden("plain-text"),
    reply: "Hello again.",
  },
  {
    id: "bot-golden-housekeeping",
    canvas: [],
    skin: "bot",
    events: fromGolden("bot-housekeeping"),
  },
  {
    id: "session-running",
    canvas: ["SessionRunning"],
    skin: "session",
    events: sessionRunning,
    view: { model: "RouteLLM" },
  },
  {
    id: "session-new",
    canvas: ["Main", "MainCollapsed"],
    skin: "session",
    events: empty,
    view: {
      preStart: true,
      placeholder: "Describe the work",
      model: "RouteLLM",
    },
  },
  {
    id: "session-mini",
    canvas: ["FullView"],
    skin: "session",
    events: idleSession(),
  },
  {
    id: "session-mini-focused",
    canvas: ["FullViewFocused"],
    skin: "session",
    events: idleSession(),
  },
  {
    id: "session-split",
    canvas: ["SplitView"],
    skin: "session",
    events: idleSession(),
  },
  {
    id: "session-subagents",
    canvas: ["SubAgents"],
    skin: "session",
    events: sessionSubagents,
  },
  {
    id: "session-failed-ratelimit",
    canvas: ["SessionFailed"],
    skin: "session",
    events: sessionFailedRateLimit,
    view: { model: "Claude Sonnet" },
  },
  ...Object.keys(OUTCOME_ERRORS).map((kind) => ({
    id: `session-outcome-${kind}`,
    canvas: [],
    skin: "session" as const,
    events: sessionOutcome(kind),
    view: { model: kind.startsWith("own-key") ? "Gemini" : "Abacus.AI" },
  })),
  {
    id: "session-sandbox-refused",
    canvas: ["SessionBrowser"],
    skin: "session",
    events: sessionSandboxRefused,
  },
  {
    id: "session-browser",
    canvas: [],
    skin: "session",
    events: permission(
      {
        type: "browser_action",
        action: "click",
        url: "https://example.com/login",
        description: "Click “Sign in” on example.com",
      },
      "browser_click",
      { url: "https://example.com/login" },
      "DEFAULT",
      ["accept", "reject"]
    ),
  },
  {
    id: "session-review",
    canvas: ["SessionReview"],
    skin: "session",
    events: sessionReview,
  },
  {
    id: "session-workspace-missing",
    canvas: ["SessionWorkspaceMissing"],
    skin: "session",
    events: idleSession(),
    view: { readOnly: "Can't send: ~/code/abacusai-bot no longer exists." },
  },
  {
    id: "session-golden-tool-bash",
    canvas: [],
    skin: "session",
    events: fromGolden("tool-bash"),
  },
  {
    id: "session-golden-delegates",
    canvas: [],
    skin: "session",
    events: fromGolden("delegate-colliding-ids"),
  },
  {
    id: "session-golden-permission",
    canvas: [],
    skin: "session",
    events: fromGolden("permission-two-calls"),
  },
  {
    id: "session-golden-plan",
    canvas: [],
    skin: "session",
    events: fromGolden("todo-plan"),
  },
  {
    id: "session-golden-turn-failed",
    canvas: [],
    skin: "session",
    events: fromGolden("turn-failed"),
  },
  {
    id: "session-golden-steer",
    canvas: [],
    skin: "session",
    events: fromGolden("steer-and-queue"),
  },
  {
    id: "session-migrated",
    canvas: [],
    skin: "session",
    events: empty,
    history: migratedHistory,
  },
  {
    id: "composer-bot-resting",
    canvas: ["ComposerStates"],
    skin: "bot",
    events: idleSession("YOLO"),
  },
  {
    id: "composer-session-resting",
    canvas: ["ComposerStates"],
    skin: "session",
    events: idleSession(),
    view: { model: "RouteLLM" },
  },
  {
    id: "composer-bot-queue",
    canvas: ["ComposerStates"],
    skin: "bot",
    events: botQueue,
  },
  {
    id: "composer-attachments",
    canvas: ["ComposerStates"],
    skin: "session",
    events: idleSession(),
    view: {
      draft: {
        text: "Use these files",
        attachments: [
          {
            id: "done",
            name: "report.pdf",
            path: "/repo/report.pdf",
            state: "done",
          },
          { id: "loading", name: "photo.png", path: null, state: "uploading" },
          {
            id: "failed",
            name: "archive.zip",
            path: null,
            state: "error",
            error: "Couldn't save this file",
          },
        ],
      },
    },
  },
  {
    id: "composer-mention",
    canvas: ["ComposerStates", "Pickers"],
    skin: "session",
    events: idleSession(),
    view: { draft: { text: "@workspace", attachments: [] } },
  },
  {
    id: "composer-dictating",
    canvas: ["ComposerStates", "dictation"],
    skin: "session",
    events: idleSession(),
    view: { dictating: true, placeholder: "Listening… (dictation preview)" },
  },
  {
    id: "composer-mode-open",
    canvas: ["ComposerStates"],
    skin: "session",
    events: idleSession(),
    view: { model: "RouteLLM", openPicker: "mode" },
  },
  {
    id: "composer-model-open",
    canvas: ["ComposerStates", "Pickers"],
    skin: "session",
    events: idleSession(),
    view: { model: "RouteLLM", openPicker: "model" },
  },
  {
    id: "perm-run-command",
    canvas: ["PermissionStates"],
    skin: "session",
    events: permission(
      {
        type: "run_terminal",
        command: "git push origin fix/sidebar-restore",
        cwd: "/Users/me/code/abacusai-bot",
        background: false,
      },
      "bash",
      { command: "git push origin fix/sidebar-restore" },
      "DEFAULT",
      SANDBOX
    ),
  },
  {
    id: "perm-credentials",
    canvas: ["PermissionStates"],
    skin: "session",
    events: permission(
      {
        type: "run_terminal",
        command: "cat ~/.npmrc",
        cwd: "/repo",
        background: false,
        credentialPaths: ["~/.npmrc"],
      },
      "bash",
      { command: "cat ~/.npmrc" },
      "DEFAULT",
      SANDBOX
    ),
  },
  {
    id: "perm-edit-file",
    canvas: ["PermissionStates"],
    skin: "session",
    events: permission(
      {
        type: "edit_file",
        filePath: "src/workspace-view.tsx",
        originalContent: "mainArea: centerSize - restoredSize,",
        newContent:
          "mainArea: centerSize - fromCenter,\n[oppositeId]: oppositeSize - fromOpposite,",
      },
      "edit",
      { path: "src/workspace-view.tsx" }
    ),
  },
  {
    id: "perm-network-host",
    canvas: ["PermissionStates"],
    skin: "session",
    events: permission(
      { type: "network_host", host: "registry.npmjs.org", port: 443 },
      "bash",
      { command: "npm install" },
      "AUTO",
      SANDBOX
    ),
  },
  {
    id: "perm-exit-plan",
    canvas: ["PermissionStates"],
    skin: "session",
    events: permission(
      {
        type: "exit_plan_mode",
        planFilePath: "plan.md",
        planContent:
          "1. Take the width from the centre first\n2. Take the rest from the opposite panel\n3. Add a test for the full-width case",
      },
      "exit_plan_mode",
      {},
      "PLAN"
    ),
  },
  {
    id: "perm-question",
    canvas: ["PermissionStates"],
    skin: "session",
    events: permission(
      {
        type: "ask_user_question",
        questions: [
          {
            question: "Which breakpoint should fold split view?",
            header: "Breakpoint",
            multiSelect: false,
            options: [
              {
                label: "960",
                description: "matching the current compact mode",
              },
              { label: "768", description: "matching the sidebar" },
              { label: "Something else", description: "" },
            ],
          },
          {
            question: "Keep the old setting?",
            header: "Setting",
            multiSelect: true,
            options: [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ],
          },
        ],
      },
      "ask_user_question",
      {},
      "DEFAULT",
      ["question_answers", "reject"]
    ),
  },
  {
    id: "perm-two-pending",
    canvas: [],
    skin: "session",
    events: twoPermissions,
  },
  {
    id: "readonly-telegram",
    canvas: ["ReadOnlyStates"],
    skin: "bot",
    events: idleSession("YOLO"),
    view: { readOnly: "This chat lives in Telegram. Reply there." },
  },
  {
    id: "readonly-answering",
    canvas: ["ReadOnlyStates"],
    skin: "bot",
    events: botTyping,
    view: { readOnly: "Answering in WhatsApp…" },
  },
  {
    id: "readonly-routine-run",
    canvas: ["ReadOnlyStates"],
    skin: "session",
    events: sessionReview,
    view: { readOnly: "A routine run. Open the routine to change it." },
  },
  {
    id: "readonly-folder-gone",
    canvas: ["ReadOnlyStates"],
    skin: "session",
    events: idleSession(),
    view: { readOnly: "Can't send: ~/code/old no longer exists." },
  },
];

export const scenarioById = (id: string): Scenario | undefined =>
  SCENARIOS.find((scenario) => scenario.id === id);
