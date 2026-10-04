import { AgentMode } from "@abacus-ai/contract/agent-types";
import * as v from "valibot";

import {
  AVATAR_SHAPES,
  AVATAR_ACCESSORIES,
  isSupportedAvatarColor,
} from "#renderer/lib/bots/avatar";

// Draft validation checks shape, not form validity: an unfinished name or cron
// time must survive a swap just as typed, without trimming or normalization.
const nullableString = v.nullable(v.string());
const envelope = v.object({
  runId: v.string(),
  messageId: v.string(),
  parts: v.array(v.looseObject({ type: v.string() })),
  forwardedProps: v.optional(v.record(v.string(), v.unknown())),
});
const attachment = v.object({
  id: v.string(),
  name: v.string(),
  path: nullableString,
  state: v.picklist(["uploading", "done", "error"]),
  size: v.optional(v.number()),
  mimeType: v.optional(v.string()),
  error: v.optional(v.string()),
});
const chat = v.record(
  v.string(),
  v.object({
    text: v.string(),
    attachments: v.array(attachment),
    mode: v.optional(v.enum(AgentMode)),
    model: v.optional(nullableString),
    pendingSubmit: v.optional(envelope),
  })
);
const botValues = v.object({
  name: v.string(),
  persona: v.string(),
  instructions: v.string(),
  description: v.string(),
  model: nullableString,
  look: v.object({
    shape: v.picklist(AVATAR_SHAPES),
    color: v.pipe(v.string(), v.check(isSupportedAvatarColor)),
    accessory: v.picklist(AVATAR_ACCESSORIES),
  }),
  checkIn: v.object({
    preset: v.picklist([
      "off",
      "hourly",
      "daily",
      "weekdays",
      "weekly",
      "custom",
    ]),
    time: v.string(),
    weekday: v.number(),
    custom: nullableString,
    enabled: v.boolean(),
  }),
});
const bot = v.nullable(
  v.object({
    id: v.string(),
    templateId: nullableString,
    lookPicked: v.optional(v.boolean()),
    values: botValues,
    stages: v.object({
      bot: v.boolean(),
      checkIn: v.picklist(["none", "persisted", "failed"]),
    }),
  })
);
const start = v.object({
  id: v.string(),
  workspaceId: nullableString,
  worktree: v.variant("kind", [
    v.object({ kind: v.literal("current") }),
    v.object({ kind: v.literal("existing"), id: v.string() }),
    v.object({ kind: v.literal("new"), baseRef: v.string() }),
  ]),
  worktreeOperationId: nullableString,
  stage: v.picklist(["draft", "created", "checkout-ready", "handed-off"]),
  envelope: v.nullable(envelope),
});
type Dock =
  | { kind: "leaf"; id: string; tabs: string[]; active: string | null }
  | {
      kind: "split";
      id: string;
      orientation: "horizontal" | "vertical";
      children: Dock[];
    };
const dock: v.GenericSchema<Dock> = v.lazy(() =>
  v.variant("kind", [
    v.object({
      kind: v.literal("leaf"),
      id: v.string(),
      tabs: v.array(v.string()),
      active: nullableString,
    }),
    v.object({
      kind: v.literal("split"),
      id: v.string(),
      orientation: v.picklist(["horizontal", "vertical"]),
      children: v.array(dock),
    }),
  ])
);
const tabs = v.record(
  v.string(),
  v.object({
    tabs: v.array(
      v.object({
        ref: v.string(),
        title: v.string(),
        openedAt: v.number(),
        path: v.optional(v.string()),
        sessionId: v.optional(v.string()),
        shell: v.optional(
          v.picklist(["system", "cmd", "powershell", "pwsh", "busybox"])
        ),
        url: v.optional(v.string()),
      })
    ),
    last: nullableString,
    tree: v.optional(dock),
  })
);
export const CONTINUITY_STORES: ReadonlyArray<{
  key: string;
  storage: string;
  prefix?: boolean;
  schema: v.GenericSchema;
}> = [
  { key: "chat.drafts.v1", storage: "abacus.chat.drafts", schema: chat },
  { key: "bots.drafts.v1", storage: "renderer:bot-draft", schema: bot },
  {
    key: "bots.edits.v1",
    storage: "abacus.bots.edits",
    schema: v.record(
      v.string(),
      v.object({ values: botValues, baseline: botValues })
    ),
  },
  {
    key: "sessions.startDraft.v1",
    storage: "abacus.sessions.start",
    schema: start,
  },
  {
    key: "sessions.panelTabs.v1",
    storage: "abacus.sessions.tabs",
    schema: tabs,
  },
  {
    key: "sessions.review.v1",
    storage: "abacus.sessions.reviews",
    schema: v.record(v.string(), v.record(v.string(), v.string())),
  },
  {
    key: "routines.editorLog.v1",
    storage: "routine-editor:",
    prefix: true,
    schema: v.array(v.object({ user: v.string(), reply: v.string() })),
  },
];
const binding = new Map<
  string,
  { read(): unknown; write(value: unknown): void }
>();
const definitionFor = (storage: string) =>
  CONTINUITY_STORES.find((s) =>
    s.prefix ? storage.startsWith(s.storage) : storage === s.storage
  );
export const bindContinuityStore = (
  storage: string,
  store: { read(): unknown; write(value: unknown): void }
): (() => void) => {
  if (!definitionFor(storage))
    throw new Error(`Unregistered session store: ${storage}`);
  binding.set(storage, store);
  return () => {
    if (binding.get(storage) === store) binding.delete(storage);
  };
};
export type DraftSnapshot = Record<string, { key: string; value: unknown }>;
export const captureDrafts = (): DraftSnapshot => {
  const result: DraftSnapshot = {};
  const keys = new Set([...binding.keys(), ...Object.keys(sessionStorage)]);
  for (const storage of keys) {
    const definition = definitionFor(storage);
    if (!definition) continue;
    // Use the live value even when sessionStorage quota was exhausted.
    const value = binding.has(storage)
      ? binding.get(storage)!.read()
      : JSON.parse(sessionStorage.getItem(storage) ?? "null");
    result[storage] = { key: definition.key, value };
  }
  return result;
};
export const restoreDrafts = (snapshot: DraftSnapshot): void => {
  for (const [storage, entry] of Object.entries(snapshot)) {
    const definition = definitionFor(storage);
    if (!definition || definition.key !== entry.key) {
      console.warn(`[continuity] unknown store ${storage}`);
      continue;
    }
    const parsed = v.safeParse(definition.schema, entry.value);
    if (!parsed.success) {
      console.warn(`[continuity] invalid ${entry.key}`);
      continue;
    }
    try {
      sessionStorage.setItem(storage, JSON.stringify(parsed.output));
    } catch (error) {
      console.warn(`[continuity] storage ${storage}`, error);
    }
    binding.get(storage)?.write(parsed.output);
  }
};
