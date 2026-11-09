/**
 * The user's own words in a turn (`ownWords`), read off every wrapper the app
 * puts around them, each built by the framer that writes it. A note with a
 * new tag in a framer file fails here until `APP_NOTE_TAGS` declares it, so
 * the app's English never reads as the user's language again.
 */
import fs from "node:fs";
import path from "node:path";

import { midTaskText } from "@abacus-ai/agent/mid-task-inbox";
import {
  APP_NOTE_TAGS,
  frameChannelMessage,
  ownWords,
} from "@abacus-ai/agent/user-text";
import { describe, expect, it } from "vitest";

import {
  buildRoutineEditorPrompt,
  buildRoutineFirePrompt,
} from "#main/services/agent-tools/routine-prompt";
import {
  askOutcomeNote,
  botAskIntro,
  frameBotRequest,
  taskFollowUpNote,
} from "#main/services/bots/bot-ask";
import {
  kickstartMessage,
  senderChatIntro,
} from "#main/services/bots/bot-service";
import { channelWords } from "#main/services/messaging/channel-words";
import {
  REPLY_REMINDER,
  senderLabel,
} from "#main/services/messaging/messaging-gateway-service";
import {
  appendEnvironmentNotice,
  formatEnvironmentNotice,
} from "#main/services/providers/environment-notice-service";

import { nudgeNotes } from "./nudge-agenda";
import { phoneTurnText } from "./phone-lane";

const WORDS = "کل صبح کی میٹنگ کب ہے؟";
const label = senderLabel("whatsapp", { userName: "Sam", userId: "u1" });
const notice = formatEnvironmentNotice({
  connectors: ["whatsapp"],
  accountConnectors: [],
  mcpServers: [],
  skills: [],
} as never);
const job = {
  id: "r1",
  name: "Brief",
  prompt: "Summarise my inbox every morning.",
  enabled: true,
  schedule: "0 9 * * *",
} as never;
const bot = { id: "b1", name: "Ali", description: "Plan my week." } as never;
const ali = { name: "Ali", title: "" } as never;

describe("ownWords", () => {
  it.each([
    ["typed words, as they are", WORDS, WORDS],
    [
      "a user who types a bracket keeps it",
      "[note to self] buy milk",
      "[note to self] buy milk",
    ],
    ["a chat app's label", frameChannelMessage(label, WORDS), WORDS],
    [
      "an auto-reply's rules ahead of a contact's message",
      `${senderChatIntro("Sam", "WhatsApp")}\n\n${frameChannelMessage(label, WORDS)}`,
      WORDS,
    ],
    [
      "the auto-reply reminder",
      `${REPLY_REMINDER}\n\n${frameChannelMessage(label, WORDS)}`,
      WORDS,
    ],
    [
      "attachment lines",
      frameChannelMessage(
        label,
        `${WORDS}\n[attachment: a.jpg saved to /tmp/a.jpg]`
      ),
      WORDS,
    ],
    [
      "a message that is only an attachment",
      frameChannelMessage(label, "[attachment: a.jpg saved to /tmp/a.jpg]"),
      "",
    ],
    ["an environment notice", appendEnvironmentNotice(WORDS, notice), WORDS],
    [
      "a vault note ahead of the words",
      `<system_reminder>\nSaved cards: 1\n</system_reminder>\n\n${WORDS}`,
      WORDS,
    ],
    ["a routine firing", buildRoutineFirePrompt(job, "schedule", null), ""],
    [
      "a bot's routine, its voice ahead of the fire",
      `You are Ali, running a routine you set up for the user.\nYour voice, every message: brisk\n\n${buildRoutineFirePrompt(job, "schedule", null)}`,
      "",
    ],
    [
      "the routine editor's wrapper",
      buildRoutineEditorPrompt(job, WORDS, {
        at: "2026-11-01T09:00:00Z",
        text: "Done: three emails.",
      }),
      WORDS,
    ],
    ["a mid-task message", midTaskText(WORDS), WORDS],
    ["another bot's request", frameBotRequest(ali, WORDS), ""],
    ["a bot request's rules", `${botAskIntro(ali)}\n\n${WORDS}`, ""],
    [
      "another bot's answer",
      askOutcomeNote({ id: "a1", request: "plan", answer: WORDS }, ali),
      "",
    ],
    [
      "a task follow-up",
      taskFollowUpNote({ id: "a1", request: "plan" }, ali, WORDS, "ok"),
      "",
    ],
    [
      "the phone lane's notes ahead of a message",
      phoneTurnText(
        { id: "m1", kind: "message", text: WORDS } as never,
        nudgeNotes({
          id: "m1",
          text: "STOP",
          stop_keyword: true,
          nudges_sent: [{ at: 1, text: "Your slot is at 10." }],
        })
      ),
      WORDS,
    ],
    [
      "the linked turn, greeting quoted inside the note",
      phoneTurnText({ id: "l1", kind: "linked", text: "hello" } as never),
      "",
    ],
    [
      "a host note",
      phoneTurnText({
        id: "n1",
        kind: "note",
        text: "A file arrived.",
      } as never),
      "",
    ],
    ["a voice note's words", `(voice note) ${WORDS}`, WORDS],
    ["a relayed photo", "(sent a photo)", ""],
  ])("%s", (_label, text, expected) => {
    expect(ownWords(text)).toBe(expected);
  });

  it("a first run, with its notice, is all the app's", async () => {
    const note = kickstartMessage(bot, "Urdu", await channelWords("en-US"));
    expect(ownWords(note)).toBe("");
    expect(ownWords(appendEnvironmentNotice(note, notice))).toBe("");
  });

  it("takes the tags' boundary where the turn carries them", () => {
    const prompt = buildRoutineEditorPrompt(job, WORDS, null);
    expect(
      ownWords(prompt, {
        operator: {
          kind: "routine-editor",
          visibleFrom: prompt.length - WORDS.length,
        },
      })
    ).toBe(WORDS);
    expect(
      ownWords(`${notice}`, {
        systemReminder: true,
        operator: { kind: "environment-notice" },
      })
    ).toBe("");
  });
});

/** Files that write notes into user turns; tags there must be declared. */
const FRAMER_FILES = [
  "apps/desktop/src/main/services/bots/bot-ask.ts",
  "apps/desktop/src/main/services/bots/bot-service.ts",
  "apps/desktop/src/main/services/messaging/messaging-gateway-service.ts",
  "apps/desktop/src/main/services/agent-tools/routine-prompt.ts",
  "apps/desktop/src/main/services/agent-tools/hosted-run.ts",
  "apps/desktop/src/main/services/agent-tools/routine-migration.ts",
  "apps/desktop/src/main/services/session/step-events.ts",
  "apps/host/src/phone-lane.ts",
  "apps/host/src/nudge-agenda.ts",
  "packages/agent/src/bot/bot-prompts.ts",
  "packages/agent/src/phone/phone-prompts.ts",
  "packages/agent/src/mid-task-inbox.ts",
  "packages/agent/src/agui/host.ts",
];
/** Log prefixes in those files, never in a prompt; and the mid-task prefix, which keeps the words. */
const NOT_NOTES = new Set([
  "abacusai-bot-agent",
  "bots",
  "messaging",
  "phone",
  "routines",
  "steps",
  "vault",
  "user mid-task",
]);

describe("every app note is declared", () => {
  it("finds no undeclared tag in a framer file", () => {
    const root = path.resolve(__dirname, "../../..");
    const declared = new Set<string>([
      ...APP_NOTE_TAGS.whole,
      ...APP_NOTE_TAGS.part,
    ]);
    const undeclared = FRAMER_FILES.flatMap((file) =>
      [
        ...fs
          .readFileSync(path.join(root, file), "utf8")
          .matchAll(/["'`]\[([a-z][a-z -]*)\] /g),
      ]
        .map((match) => match[1]!)
        .filter((tag) => !declared.has(tag) && !NOT_NOTES.has(tag))
        .map((tag) => `${file}: [${tag}]`)
    );
    expect(undeclared).toEqual([]);
  });
});
