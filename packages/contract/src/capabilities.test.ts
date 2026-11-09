/**
 * The capability registry: each entry reads as now, after one step, or not
 * from this chat, from the caller's own tools, chat apps, surface and plan;
 * and a template promises only what an entry says how to do on its channel.
 */
import { describe, expect, it } from "vitest";

import { HOME_CHANNELS } from "./bots";
import { BOT_TEMPLATES } from "./bots/templates";
import {
  AUTO_REPLY_NEVER,
  capabilityById,
  capabilityFacts,
  capabilityLine,
  capabilityNote,
  type CapabilityState,
} from "./capabilities";

const state = (over: Partial<CapabilityState> = {}): CapabilityState => ({
  surface: "desktop",
  tier: "free",
  chatApps: { whatsapp: true, telegram: false, discord: false },
  tools: new Set(["cronjob", "paid_feature", "connect_connector"]),
  ...over,
});

const line = (id: Parameters<typeof capabilityById>[0], s: CapabilityState) =>
  capabilityLine(capabilityById(id), s);

describe("a capability as this caller can act on it", () => {
  it.each([
    // [entry, caller, how it reads]
    ["routines", state(), "Yes, now:"],
    [
      "routines",
      state({ tools: new Set(["bot_help"]) }),
      "Not from this chat:",
    ],
    ["media", state({ tools: new Set() }), "Not from this chat:"],
    [
      "auto-reply",
      state({ tools: new Set(["whatsapp_auto_reply"]) }),
      "Yes, now:",
    ],
    ["auto-reply", state(), "Not from this chat: in a bot's own chat"],
    [
      "send-read-messages",
      state({
        chatApps: { whatsapp: false },
        tools: new Set(["send_chat_message"]),
      }),
      "After one step (link a chat app",
    ],
    ["phone-chat", state({ surface: "hosted" }), "Not on the web version"],
    ["always-on", state({ tier: "free" }), "After one step (a paid plan)"],
    ["always-on", state({ tier: "unknown" }), "After one step (a paid plan)"],
    ["publish", state({ tier: "basic" }), "Their paid plan gives the rest"],
    ["whatsapp-business", state({ tools: new Set() }), "Yes, now:"],
  ] as const)("%s reads %s", (id, caller, expected) => {
    expect(line(id, caller)).toContain(expected);
  });

  it("names the phone route per chat app, with the step for one not linked", () => {
    const text = line("phone-chat", state());
    expect(text).toContain(
      'WhatsApp: in WhatsApp on their phone they open their own "Message yourself" chat'
    );
    expect(text).toContain(
      "Telegram (after one step: link it under Messaging)"
    );
    expect(text).toContain("ChatLLM mobile app is another Abacus AI product");
  });

  it("never offers a plan-gated ask as a flat no, on any plan", () => {
    for (const tier of ["free", "basic", "paid", "unknown"] as const)
      for (const id of ["always-on", "publish"] as const)
        expect(line(id, state({ tier }))).toMatch(
          /billing_plan.*never a flat no/
        );
  });

  it("filters by topic", () => {
    const chat = capabilityFacts(state(), { topic: "chat_apps" });
    expect(chat).toHaveLength(4);
    expect(chat.join("\n")).not.toContain("routine");
  });
});

describe("auto-reply's limits", () => {
  it("are said at the moment of action, in the lane's own words", () => {
    const note = capabilityNote("auto-reply");
    expect(note).toContain(AUTO_REPLY_NEVER);
    expect(note).toContain("never promise the user it will");
    expect(note).toContain("Instead: to ask a contact something");
  });
});

describe("what a template promises", () => {
  const chatApps = BOT_TEMPLATES.filter((row) => row.homeChannel != null);

  it("covers every chat app", () => {
    expect(chatApps.map((row) => row.homeChannel).sort()).toEqual(
      [...HOME_CHANNELS].sort()
    );
  });

  it.each(chatApps.map((row) => [row.id, row] as const))(
    "%s claims only what the registry says how to do on its channel",
    (_id, template) => {
      // "message you from my phone", "DM you": the phone route is claimed.
      if (/phone|\bDM\b/i.test(`${template.mission} ${template.title}`))
        expect(template.claims).toContain("phone-chat");
      for (const id of template.claims ?? []) {
        const does = capabilityById(id).does;
        const how =
          typeof does === "string" ? does : does[template.homeChannel!];
        expect(how, `${id} on ${template.homeChannel}`).toBeTruthy();
      }
    }
  );

  it("never gives Discord a self chat", () => {
    const does = capabilityById("phone-chat").does as Record<string, string>;
    expect(does.discord).not.toMatch(/message yourself|saved messages/i);
  });
});
