import * as v from "valibot";

import { optionalField } from "#renderer/lib/navigation/search";
import { WorkspaceId } from "@abacus-ai/contract/contract/ids";
import { MessagingPlatformIdSchema } from "@abacus-ai/contract/contract/messaging";
export { CONNECTOR_CATEGORY_TABS } from "#renderer/lib/navigation/search";
export const MessagingSearch = v.object({
  platform: optionalField(MessagingPlatformIdSchema),
});
export const McpSearch = v.object({
  server: optionalField(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  logs: optionalField(v.string()),
});
export const SkillsSearch = v.object({
  marketplace: optionalField(v.literal(true)),
  workspace: optionalField(WorkspaceId),
});
