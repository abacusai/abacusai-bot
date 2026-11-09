/**
 * The capability registry: each entry reads as now, after one step, or not
 * from this chat, from the caller's own tools, chat apps, connectors, surface
 * and plan; and a template promises only what an entry says how to do.
 */
import { CONNECTORS } from "@abacus-ai/connectors/registry";
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
  phoneChatRoute,
} from "./capabilities";

const state = (over: Partial<CapabilityState> = {}): CapabilityState => ({
  surface: "desktop",
  tier: "free",
  chatApps: { whatsapp: true, telegram: false, discord: false },
  connectors: null,
  tools: new Set(["cronjob", "paid_feature", "connect_connector"]),
  ...over,
});

const web = (over: Partial<CapabilityState> = {}): CapabilityState =>
  state({ surface: "hosted", chatApps: { whatsapp: true }, ...over });

const line = (id: Parameters<typeof capabilityById>[0], s: CapabilityState) =>
  capabilityLine(capabilityById(id), s);

describe("on the desktop app", () => {
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
      "After one step (link it under Messaging)",
    ],
    ["always-on", state({ tier: "free" }), "After one step (a paid plan)"],
    ["always-on", state({ tier: "unknown" }), "After one step (a paid plan)"],
    ["publish", state({ tier: "basic" }), "Their paid plan gives the rest"],
  ] as const)("%s reads %s", (id, caller, expected) => {
    expect(line(id, caller)).toContain(expected);
  });

  it("names the phone route per chat app, from each app's own link", () => {
    const text = line("phone-chat", state());
    expect(text).toContain(
      'WhatsApp: in WhatsApp on their phone they open their own "Message yourself" chat'
    );
    expect(text).toContain(
      "Telegram (after one step: link it under Messaging)"
    );
    expect(
      line("phone-chat", state({ chatApps: { telegram: true } }))
    ).toContain("Telegram: in Telegram they write to the Abacus AI bot");
    expect(text).toContain("ChatLLM mobile app is another Abacus AI product");
  });
});

describe("on the web version", () => {
  it("routes the phone through AbacusAI Bot's own number, never the desktop's self chat", () => {
    const text = line("phone-chat", web());
    expect(text).toContain(
      "Yes, now: WhatsApp: in WhatsApp on their phone they message AbacusAI Bot's own number"
    );
    expect(text).not.toContain("Message yourself");
    expect(text).not.toMatch(/desktop app does it/);
    expect(
      line("phone-chat", web({ chatApps: { whatsapp: false } }))
    ).toContain("after one step: connect WhatsApp in the app");
  });

  it.each([
    ["routines", web({ tier: "free" }), "After one step (a paid plan)"],
    [
      "routines",
      web({ tier: "basic" }),
      "Yes, now: a routine, made with cronjob, runs on the server",
    ],
    ["always-on", web({ tier: "free" }), "the web version runs on the server"],
    ["auto-reply", web(), "Not on the web version"],
    ["send-read-messages", web(), "reaches only them"],
    [
      "send-read-messages",
      web({ chatApps: { whatsapp: false } }),
      "After one step (connect WhatsApp",
    ],
  ] as const)("%s reads %s", (id, caller, expected) => {
    expect(line(id, caller)).toContain(expected);
  });

  it("never says the web version runs only while a computer is on", () => {
    expect(capabilityFacts(web({ tier: "basic" })).join("\n")).not.toMatch(
      /while the computer is on|this computer/
    );
  });
});

describe("a connector-backed entry follows the connector", () => {
  it.each([
    [{ state: "connected" }, "Yes, now:"],
    [
      { state: "available" },
      "After one step (connect it on the Connectors page",
    ],
    [
      { state: "unavailable", reason: "not offered" },
      "Not on this account right now (not offered)",
    ],
  ])("WhatsApp Business %o", (status, expected) => {
    for (const s of [state, web])
      expect(
        line(
          "whatsapp-business",
          s({ connectors: { "abacus-whatsappbusiness": status } })
        )
      ).toContain(expected);
  });

  it("names the registry's own connector count", () => {
    const accounts = CONNECTORS.filter(
      (connector) => connector.kind !== "messaging"
    );
    expect(line("connectors", state())).toContain(
      `${accounts.length} on the list, such as ${accounts[0]!.name}`
    );
  });
});

describe("plans", () => {
  it("never offers a plan-gated ask as a flat no, on any plan or surface", () => {
    for (const tier of ["free", "basic", "paid", "unknown"] as const)
      for (const id of ["always-on", "publish"] as const)
        for (const s of [state, web])
          expect(line(id, s({ tier }))).toMatch(
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
        const does = capabilityById(id).desktop.does;
        const how =
          typeof does === "string" ? does : does[template.homeChannel!];
        expect(how, `${id} on ${template.homeChannel}`).toBeTruthy();
      }
    }
  );

  it("never gives Discord a self chat, and the web its own route", () => {
    expect(phoneChatRoute("discord")).not.toMatch(
      /message yourself|saved messages/i
    );
    expect(phoneChatRoute("whatsapp", "hosted")).toContain(
      "AbacusAI Bot's own number"
    );
    expect(phoneChatRoute("whatsapp")).toContain("Message yourself");
  });
});
