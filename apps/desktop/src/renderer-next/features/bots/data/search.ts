/**
 * `/bots/new`'s search (spec 03 §5.2). Every field falls back instead of
 * throwing: a stale template id or category just shows the start page.
 */
import * as v from "valibot";

import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  type BotTemplateCategory,
} from "#next/lib/bots/templates";
import { optionalField } from "#next/lib/navigation/search";

const TemplateId = v.picklist(
  BOT_TEMPLATES.map((template) => template.id) as [string, ...string[]]
);

const TemplateCategory = v.picklist(
  BOT_TEMPLATE_CATEGORIES as unknown as [
    BotTemplateCategory,
    ...BotTemplateCategory[],
  ]
);

export const NEW_BOT_DEFAULTS = { category: "featured" } as const;

export const NewBotSearch = v.object({
  /** Absent: the start page. */
  step: optionalField(v.picklist(["setup"])),
  template: optionalField(TemplateId),
  category: v.optional(v.fallback(TemplateCategory, "featured"), "featured"),
});
