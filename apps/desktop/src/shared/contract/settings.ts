import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  DefaultAgentMode,
  ExecBackendState,
  NotificationSettings,
  SandboxSupport,
} from "../contracts";
import type { BackendId } from "../exec-backends";
import type { AbacusBotSettings } from "../settings";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

export const NotificationSettingsSchema = v.object({
  enabled: v.boolean(),
  sound: v.boolean(),
});

// `AgentMode.Yolo | AgentMode.Auto`, spelled as the values (see ids.ts).
export const DefaultAgentModeSchema = v.picklist([
  "YOLO",
  "AUTO",
] as DefaultAgentMode[]);

export const BackendIdSchema = v.picklist([
  "local",
  "docker",
  "singularity",
  "modal",
  "daytona",
  "ssh",
] as BackendId[]);

/**
 * The only destination for a stored or removed credential. The renderer maps
 * it to `settings.keys.listProviders`, `account.*` and `models.list`.
 */
export type SettingsEvent = {
  type: "credentials-changed";
  provider: string;
  configured?: boolean;
};

export const settings = {
  get: query.input(NoInput).output(type<AbacusBotSettings>()),
  promptHistory: {
    /** Newest first. */
    list: query.input(v.object({ scope: v.string() })).output(type<string[]>()),
    /** The history as it now stands. */
    add: mutation
      .input(v.object({ scope: v.string(), prompt: v.string() }))
      .output(type<string[]>()),
  },
  keys: {
    /** Ids only, never the keys. */
    listProviders: query.input(NoInput).output(type<string[]>()),
    /** An empty key removes it. */
    save: mutation
      .input(
        v.object({
          provider: v.pipe(v.string(), v.nonEmpty()),
          key: v.string(),
        })
      )
      .output(type<AbacusBotSettings>()),
  },
  setDefaultModel: mutation
    .input(v.object({ modelId: v.pipe(v.string(), v.nonEmpty()) }))
    .output(type<AbacusBotSettings>()),
  toolsets: {
    /** Keyed by toolset id. */
    get: query.input(NoInput).output(type<Record<string, boolean>>()),
    setEnabled: mutation
      .input(
        v.object({
          toolsetId: v.pipe(v.string(), v.nonEmpty()),
          enabled: v.boolean(),
        })
      )
      .output(type<Record<string, boolean>>()),
  },
  defaultMode: {
    get: query.input(NoInput).output(type<DefaultAgentMode>()),
    set: mutation
      .input(v.object({ mode: DefaultAgentModeSchema }))
      .output(type<DefaultAgentMode>()),
  },
  sandboxSupport: query.input(NoInput).output(type<SandboxSupport>()),
  notifications: {
    get: query.input(NoInput).output(type<NotificationSettings>()),
    set: mutation
      .input(NotificationSettingsSchema)
      .output(type<NotificationSettings>()),
  },
  execBackend: {
    get: query.input(NoInput).output(type<ExecBackendState>()),
    set: mutation
      .input(v.object({ backend: BackendIdSchema }))
      .output(type<ExecBackendState>()),
  },
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<SettingsEvent>())),
};
