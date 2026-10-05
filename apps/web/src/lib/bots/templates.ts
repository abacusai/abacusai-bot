import {
  BOT_TEMPLATES as catalog,
  orderedTemplateIds as ordered,
  type BotTemplateCategory,
} from "@abacus-ai/contract/bots/templates";

import { IS_ELECTRON } from "#renderer/lib/platform";
export * from "@abacus-ai/contract/bots/templates";
export const BOT_TEMPLATES = catalog.filter(
  (template) =>
    IS_ELECTRON ||
    !["whatsapp-agent", "telegram-agent", "discord-agent"].includes(template.id)
);
export const orderedTemplateIds = (
  category: BotTemplateCategory,
  connectors: readonly string[] = []
) =>
  ordered(category, connectors).filter((id) =>
    BOT_TEMPLATES.some((template) => template.id === id)
  );
export const heroTemplateIds = (connectors: readonly string[] = []) =>
  orderedTemplateIds("featured", connectors);

export const templateIdsInCategory = (category: BotTemplateCategory) =>
  orderedTemplateIds(category);
