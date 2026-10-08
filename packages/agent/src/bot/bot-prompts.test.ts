/**
 * A bot answers everyone the user allowed. The old rule let it stay quiet
 * on "broadcasts and automated content", and a model read a contact saved
 * as "My Airtel" as a telco robot and sent nothing, to the user's own
 * second number.
 */
import { describe, expect, it } from "vitest";

import { BROWSER_SYSTEM_PROMPT } from "../browser-task.js";
import { WHATSAPP_CHANNEL } from "../channel.js";
import {
  phoneConsolidatePrompt,
  phoneFlushPrompt,
  phoneOperatingPrompt,
} from "../phone/phone-prompts.js";
import { botOperatingPrompt } from "./bot-prompts.js";

describe("the bot's reply rule", () => {
  it("answers every message from an allowed sender", () => {
    const prompt = botOperatingPrompt();
    expect(prompt).toMatch(/every message gets an answer/i);
    expect(prompt).toMatch(/never judge a sender to be automated/i);
    expect(prompt).not.toMatch(/broadcasts, automated content/i);
  });

  it("keeps NO_REPLY only for its own echo", () => {
    expect(botOperatingPrompt()).toMatch(
      /NO_REPLY is only for your\s+own words echoing back/i
    );
  });
});

describe("what the prompts say about the browser, per channel", () => {
  it("sends an app chat's user to the Browser pane, and a chat without one never there", () => {
    expect(botOperatingPrompt()).toMatch(/Browser pane/);
    const paneless = botOperatingPrompt(WHATSAPP_CHANNEL);
    expect(paneless).not.toMatch(/pane/i);
    expect(paneless).toMatch(/never ask for a password/);
  });

  it("tells the phone loop how screenshots reach the chat, and acts only through chat, links and approval pages", () => {
    const prompt = phoneOperatingPrompt(null);
    expect(prompt).not.toMatch(/pane/i);
    expect(prompt).toMatch(/`send_media` sends an image/);
    expect(prompt).toMatch(
      /acts only through this chat, one-time links and approval\s+pages/
    );
    expect(prompt).toMatch(/screenshot at the review/);
    expect(prompt).toMatch(/picture puzzle, say honestly you can't solve it/);
  });
});

describe("the phone loop's clock and check-ins", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("states the user's zone, not this machine's, and that a due is on their clock", () => {
    const prompt = flat(phoneOperatingPrompt(null, "Asia/Kolkata"));
    expect(prompt).toMatch(
      /local timezone is Asia\/Kolkata \(GMT\+5:30, UTC\+05:30\)/
    );
    expect(prompt).toMatch(/`due` is the user's own local date and time/);
    expect(prompt).not.toMatch(/UTC offset|not set/);
  });

  it("asks which stop is meant before turning check-ins off", () => {
    expect(flat(phoneOperatingPrompt(null))).toMatch(
      /could mean the task you are on, ask which they mean/
    );
  });
});

describe("the payment rule", () => {
  const prompts = {
    phone: phoneOperatingPrompt(null),
    "bot (app)": botOperatingPrompt(),
    "bot (WhatsApp)": botOperatingPrompt(WHATSAPP_CHANNEL),
    "browser sub-agent": BROWSER_SYSTEM_PROMPT,
  };
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("is the approved rule everywhere: only after approval of the exact amount, merchant and site", () => {
    for (const [name, prompt] of Object.entries(prompts)) {
      expect(flat(prompt), name).not.toMatch(
        /never complete a (?:purchase|payment)|go as far as the payment step and no further/i
      );
      expect(flat(prompt), name).toMatch(/the CVV only if/);
    }
    for (const name of ["phone", "bot (app)", "bot (WhatsApp)"] as const) {
      expect(flat(prompts[name]), name).toMatch(
        /complete a payment or booking only after the user approved its exact amount, merchant and site on the `payment_approval` page: one card fill/
      );
      expect(flat(prompts[name]), name).toMatch(
        /Never ask for a password, card number, CVV or (?:one-time )?code in the chat/
      );
      expect(flat(prompts[name]), name).toMatch(
        /Never pay with a card the site saved, with UPI or with a wallet app/
      );
      expect(flat(prompts[name]), name).toMatch(
        /confirm saved ones in one line/
      );
      expect(flat(prompts[name]), name).toMatch(/a passport needs its own yes/);
    }
    expect(flat(BROWSER_SYSTEM_PROMPT)).toMatch(
      /Never pick a card the site saved, UPI or a wallet app/
    );
    expect(flat(BROWSER_SYSTEM_PROMPT)).toMatch(/browser_pause/);
    expect(flat(BROWSER_SYSTEM_PROMPT)).toMatch(
      /Paying: only after the user approved this payment; the browser checks the approval and the total itself/
    );
    expect(flat(BROWSER_SYSTEM_PROMPT)).toMatch(/browser_traveler_fill/);
    expect(flat(BROWSER_SYSTEM_PROMPT)).toMatch(/call browser_pause alone/);
  });

  it("keeps ID numbers out of what the memory turns write", () => {
    expect(flat(phoneFlushPrompt("2026-10-07"))).toMatch(
      /Never write a passport, ID, card or account number into about_you or log/
    );
    expect(
      flat(
        phoneConsolidatePrompt({
          missingDay: null,
          aboutYou: [],
          notes: [],
          loops: [],
        })
      )
    ).toMatch(/Never write a passport, ID, card or account number into log/);
  });
});
