import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";
import * as v from "valibot";

import { optionalField } from "#renderer/lib/navigation/search";

import { SETTINGS_INDEX } from "./search-index";
export const SettingsSearch = v.object({
  focus: optionalField(
    v.union([
      v.picklist(SETTINGS_INDEX.map((x) => x.id)),
      v.pipe(
        v.string(),
        v.maxLength(240),
        v.regex(/^(sounds-bot-|memory-bot-|memory-|usage-)[A-Za-z0-9._:/@-]+$/)
      ),
    ])
  ),
});
export const ModelsSearch = v.object({
  provider: optionalField(
    v.picklist([
      "local",
      ...PROVIDER_KEY_FIELDS.filter((x) => x.kind === "model").map(
        (x) => x.provider
      ),
    ])
  ),
  for: optionalField(
    v.pipe(
      v.string(),
      v.regex(/^(session:[A-Za-z0-9._-]{1,120}|draft:[A-Za-z0-9._:-]{1,120})$/)
    )
  ),
});
export const AccountSearch = v.object({
  invite: optionalField(v.picklist(["link", "gmail", "whatsapp"])),
});
