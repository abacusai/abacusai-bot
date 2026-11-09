/**
 * The web version offers no chat-app agent: its chat apps run only in the
 * desktop app, and WhatsApp on the web is AbacusAI Bot's own number. So no bot
 * made here carries a home channel, and no first reply names a desktop route.
 */
import { BOT_TEMPLATES as CATALOG } from "@abacus-ai/contract/bots/templates";
import { expect, it } from "vitest";

import { BOT_TEMPLATES } from "./templates";

it("offers no template with a home channel on the web", () => {
  expect(CATALOG.some((template) => template.homeChannel != null)).toBe(true);
  expect(
    BOT_TEMPLATES.filter((template) => template.homeChannel != null)
  ).toEqual([]);
});
