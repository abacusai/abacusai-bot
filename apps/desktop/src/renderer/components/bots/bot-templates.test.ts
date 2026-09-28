/**
 * The template catalog, and which cards a tab leads with.
 *
 * The cards are the product team's sheet, one tab per category. Within a
 * tab, what the user has connected decides the order: someone who has just
 * linked WhatsApp is shown the WhatsApp bot first, not wherever the sheet
 * happened to put it. But only on a tab that has that bot at all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  FEATURED_TEMPLATE_IDS,
  TEMPLATE_FOR_CONNECTOR,
  heroTemplateIds,
  orderedTemplateIds,
  templateIdsInCategory,
} from "./bot-templates";

describe("heroTemplateIds", () => {
  it("leads with the featured cards, in the sheet's order, when nothing is connected", () => {
    expect(heroTemplateIds([])).toEqual([...FEATURED_TEMPLATE_IDS]);
    expect(heroTemplateIds()).toEqual([...FEATURED_TEMPLATE_IDS]);
    expect(FEATURED_TEMPLATE_IDS[0]).toBe("chief-of-staff");
  });

  it("leads with the bot for the platform the user connected", () => {
    expect(heroTemplateIds(["messaging-telegram"])[0]).toBe("telegram-agent");
    expect(heroTemplateIds(["messaging-discord"])[0]).toBe("discord-agent");
    expect(heroTemplateIds(["abacus-gmailuser"])[0]).toBe("email-drafting");
    expect(heroTemplateIds(["abacus-slack"])[0]).toBe("chief-of-staff");
  });

  it("keeps the caller's order when several are connected", () => {
    expect(
      heroTemplateIds(["messaging-whatsapp", "abacus-gmailuser"]).slice(0, 2)
    ).toEqual(["whatsapp-agent", "email-drafting"]);

    expect(
      heroTemplateIds(["abacus-gmailuser", "messaging-whatsapp"]).slice(0, 2)
    ).toEqual(["email-drafting", "whatsapp-agent"]);
  });

  it("never repeats a card, and never changes length", () => {
    const ids = heroTemplateIds(Object.keys(TEMPLATE_FOR_CONNECTOR));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(FEATURED_TEMPLATE_IDS.length);
  });

  it("ignores a connector with no bot of its own", () => {
    expect(heroTemplateIds(["abacus-googlecalendar"])).toEqual([
      ...FEATURED_TEMPLATE_IDS,
    ]);
  });
});

describe("orderedTemplateIds, per tab", () => {
  it("promotes a connected bot only on a tab that has it", () => {
    // WhatsApp is linked, but the Finance tab has no WhatsApp bot: it must
    // not grow one, and must keep the sheet's order.
    expect(orderedTemplateIds("finance", ["messaging-whatsapp"])).toEqual(
      templateIdsInCategory("finance")
    );
  });

  it("shows every category's own cards, in the sheet's order", () => {
    for (const category of BOT_TEMPLATE_CATEGORIES) {
      const ids = orderedTemplateIds(category);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual(templateIdsInCategory(category));
    }
  });

  it("lists a template shared by two tabs on both, as one template", () => {
    expect(templateIdsInCategory("featured")).toContain(
      "daily-stock-recommender"
    );
    expect(templateIdsInCategory("finance")).toContain(
      "daily-stock-recommender"
    );
    expect(
      BOT_TEMPLATES.filter(({ id }) => id === "daily-stock-recommender")
    ).toHaveLength(1);
  });
});

describe("the templates behind the tabs", () => {
  it("has a real template for every connector it maps", () => {
    const ids = new Set(BOT_TEMPLATES.map((template) => template.id));

    for (const id of Object.values(TEMPLATE_FOR_CONNECTOR))
      expect(ids).toContain(id);
  });

  it("gives every template a persona and a mission, from the sheet", () => {
    for (const template of BOT_TEMPLATES) {
      expect(template.persona.length, template.id).toBeGreaterThan(0);
      expect(template.mission.length, template.id).toBeGreaterThan(20);
      expect(template.categories.length, template.id).toBeGreaterThan(0);
    }
  });

  it("has card copy in the base locale for every template", () => {
    // The name and description are localized; a template without them
    // renders its raw i18n key on the card.
    const locale = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../locales/en-US.json"), "utf8")
    ) as { bots: { templates: Record<string, Record<string, string>> } };

    for (const template of BOT_TEMPLATES) {
      const copy = locale.bots.templates[template.id];
      expect(copy?.name, template.id).toBeTruthy();
      expect(copy?.description, template.id).toBeTruthy();
    }
    expect(Object.keys(locale.bots.templates)).toHaveLength(
      BOT_TEMPLATES.length
    );
  });

  it("uses no id twice", () => {
    const ids = BOT_TEMPLATES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
