import { AgentMode } from "@abacus-ai/contract/agent-types";
import { isTerminalShellId } from "@abacus-ai/contract/terminal-shells";
import { Store } from "@tanstack/react-store";
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
  kind: v.optional(v.picklist(["file", "folder"])),
  count: v.optional(v.number()),
});
const composerDraft = v.object({
  text: v.string(),
  attachments: v.array(attachment),
  mode: v.optional(v.enum(AgentMode)),
  model: v.optional(nullableString),
  pendingSubmit: v.optional(envelope),
  replyTo: v.optional(
    v.looseObject({
      messageId: v.string(),
      role: v.picklist(["user", "assistant"]),
      excerpt: v.string(),
    })
  ),
  selectionStart: v.optional(v.number()),
  selectionEnd: v.optional(v.number()),
  scrollTop: v.optional(v.number()),
});
const chat = v.record(v.string(), composerDraft);
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
  submittedAt: v.optional(v.number()),
  envelope: v.nullable(envelope),
});
const tabs = v.record(
  v.string(),
  v.object({
    open: v.optional(v.boolean()),
    order: v.optional(v.array(v.string())),
    tabs: v.array(
      v.object({
        ref: v.string(),
        title: v.string(),
        openedAt: v.number(),
        path: v.optional(v.string()),
        sessionId: v.optional(v.string()),
        shell: v.optional(v.custom(isTerminalShellId)),
        url: v.optional(v.string()),
      })
    ),
    last: nullableString,
  })
);
const panel = v.record(
  v.string(),
  v.object({
    open: v.boolean(),
    expanded: v.optional(v.boolean()),
    tabs: v.array(
      v.object({
        id: v.string(),
        kind: v.picklist([
          "details",
          "memory",
          "files",
          "browser",
          "changes",
          "terminal",
          "device",
          "agent",
          "thread",
        ]),
        title: v.optional(v.string()),
        url: v.optional(v.string()),
        path: v.optional(v.string()),
      })
    ),
    active: nullableString,
  })
);
export const CONTINUITY_STORES: ReadonlyArray<{
  key: string;
  storage: string;
  prefix?: boolean;
  schema: v.GenericSchema;
}> = [
  {
    key: "chat.drafts.v1",
    storage: "abacusai-bot:abacus.chat.drafts",
    schema: chat,
  },
  {
    key: "bots.drafts.v1",
    storage: "abacusai-bot:renderer:bot-draft",
    schema: bot,
  },
  {
    key: "bots.edits.v1",
    storage: "abacusai-bot:abacus.bots.edits",
    schema: v.record(
      v.string(),
      v.object({ values: botValues, baseline: botValues })
    ),
  },
  {
    key: "sessions.startDraft.v1",
    storage: "abacusai-bot:abacus.sessions.start",
    schema: start,
  },
  {
    key: "sessions.drafts.v1",
    storage: "abacusai-bot:abacus.sessions.drafts",
    schema: v.object({
      activeId: nullableString,
      drafts: v.record(
        v.string(),
        v.object({
          ...start.entries,
          createdAt: v.number(),
          updatedAt: v.number(),
          composer: composerDraft,
        })
      ),
    }),
  },
  {
    key: "sessions.panelTabs.v1",
    storage: "abacusai-bot:abacus.sessions.tabs",
    schema: tabs,
  },
  {
    key: "shell.panel.v1",
    storage: "abacusai-bot:abacus.shell.panel",
    schema: panel,
  },
  {
    key: "sessions.review.v1",
    storage: "abacusai-bot:abacus.sessions.reviews",
    schema: v.record(v.string(), v.record(v.string(), v.string())),
  },
  {
    key: "routines.editorLog.v1",
    storage: "abacusai-bot:routine-editor:",
    prefix: true,
    schema: v.array(v.object({ user: v.string(), reply: v.string() })),
  },
  {
    key: "whatsapp.claim.v1",
    storage: "abacusai-bot:whatsapp.claim",
    schema: v.string(),
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
/**
 * What of `value` the schema accepts, as stored (unknown fields kept): the
 * whole value, or else a record's or a list's valid entries, so one bad
 * draft, tab set or mark never costs the others. `undefined` when nothing
 * is usable (no valid entry either).
 */
const salvage = (schema: v.GenericSchema, value: unknown): unknown => {
  const valid = (schema: v.GenericSchema, value: unknown): boolean =>
    v.safeParse(schema, value).success;
  if (valid(schema, value)) return value;
  const shape = schema as {
    type: string;
    value?: v.GenericSchema;
    item?: v.GenericSchema;
  };
  let kept: unknown[] | Record<string, unknown> | undefined;
  if (
    shape.type === "record" &&
    shape.value &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const entries = Object.entries(value).filter(([, entry]) =>
      valid(shape.value!, entry)
    );
    if (entries.length > 0) kept = Object.fromEntries(entries);
  }
  if (shape.type === "array" && shape.item && Array.isArray(value)) {
    const items = value.filter((entry) => valid(shape.item!, entry));
    if (items.length > 0) kept = items;
  }
  if (kept !== undefined) return kept;
  return undefined;
};

/**
 * A store `persistedStore` made: `flush` writes a batched change now,
 * `bind` registers it for continuity (returns the unbinding), `dispose`
 * flushes and lets go of everything it holds.
 */
export type PersistedStore<T> = Store<T> & {
  flush(): void;
  bind(): () => void;
  dispose(): void;
};

/**
 * A module-level store kept in `sessionStorage` under `storage`, one of
 * `CONTINUITY_STORES` (so its schema checks what is read back, and a
 * document swap carries it): read once at creation, keeping what the schema
 * accepts entry by entry (`initial` when nothing is usable; storage is left
 * as it was until the state changes), written on every change (removed
 * when it is `null`), and bound for `captureDrafts`/`restoreDrafts` until
 * `dispose`. Storage that is full or blocked leaves the state in memory.
 *
 * A store that lives with a component passes `bind: false` and binds from
 * an effect, so a render React discards never registers.
 *
 * `batchMs` writes at most once per that many ms, unless `urgent` says a
 * change must go out at once; a pending write is flushed when the page is
 * hidden (the last event a frozen or discarded tab is guaranteed) or
 * unloaded, and by `flush`. `serialize` picks what is written.
 */
export const persistedStore = <T>(
  storage: string,
  initial: () => T,
  options: {
    serialize?(state: T): unknown;
    batchMs?: number;
    urgent?(previous: T, next: T): boolean;
    bind?: boolean;
    durable?: boolean;
  } = {}
): PersistedStore<T> => {
  const definition = definitionFor(storage);
  if (!definition) throw new Error(`Unregistered session store: ${storage}`);
  const storageArea = () =>
    options.durable ? globalThis.localStorage : globalThis.sessionStorage;
  const read = (): T => {
    try {
      const raw = storageArea()?.getItem(storage);
      if (raw == null) return initial();
      return (salvage(definition.schema, JSON.parse(raw)) as T) ?? initial();
    } catch {
      return initial();
    }
  };
  const store = new Store<T>(read());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (): void => {
    clearTimeout(timer);
    timer = undefined;
    try {
      const value = options.serialize?.(store.state) ?? store.state;
      if (value == null) storageArea()?.removeItem(storage);
      else storageArea()?.setItem(storage, JSON.stringify(value));
    } catch {
      // Full or blocked: this document keeps it in memory.
    }
  };
  let previous = store.state;
  const subscription = store.subscribe((next) => {
    const urgent = options.urgent?.(previous, next) ?? false;
    previous = next;
    if (options.batchMs == null || urgent) write();
    else timer ??= setTimeout(write, options.batchMs);
  });
  const flush = (): void => {
    if (timer !== undefined) write();
  };
  const flushHidden = (): void => {
    if (document.visibilityState === "hidden") flush();
  };
  if (options.batchMs != null) {
    globalThis.addEventListener?.("pagehide", flush);
    globalThis.document?.addEventListener("visibilitychange", flushHidden);
  }
  const bind = (): (() => void) =>
    bindContinuityStore(storage, {
      read: () => store.state,
      write: (value) => store.setState(() => value as T),
    });
  const unbind = options.bind === false ? () => undefined : bind();
  return Object.assign(store, {
    flush,
    bind,
    dispose: () => {
      flush();
      subscription.unsubscribe();
      unbind();
      globalThis.removeEventListener?.("pagehide", flush);
      globalThis.document?.removeEventListener("visibilitychange", flushHidden);
    },
  });
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
    const value = salvage(definition.schema, entry.value);
    if (value === undefined) {
      console.warn(`[continuity] invalid ${entry.key}`);
      continue;
    }
    try {
      sessionStorage.setItem(storage, JSON.stringify(value));
    } catch (error) {
      console.warn(`[continuity] storage ${storage}`, error);
    }
    binding.get(storage)?.write(value);
  }
};
