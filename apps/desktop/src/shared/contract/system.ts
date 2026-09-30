import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { OpenFilePathResult } from "../contracts";
import { FUNNEL_STEPS } from "../funnel";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

/** What the renderer used to read synchronously from the preload. */
export interface SystemInfo {
  appVersion: string;
  platform: string;
  arch: string;
  versions: Record<string, string | undefined>;
  homeDir: string;
  paths: { home: string; sessionHome: string; botHome: string };
  materialIconsBasePath: string | null;
  contractVersion: number;
  foundationApi: number;
}

export interface NotificationMetadata {
  kind?: "session" | "bot" | "routine";
  botId?: string;
  routineId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export type SystemEvent = {
  type: "notification-clicked";
  metadata: NotificationMetadata;
};

export interface PickedFile {
  path: string;
  name: string;
  data: Uint8Array;
  mimeType: string;
}

export const system = {
  openPrivacyPane: mutation
    .input(
      v.object({ pane: v.picklist(["screen-recording", "accessibility"]) })
    )
    .output(type<void>()),
  dialog: {
    /** Null when cancelled. */
    openFolder: mutation.input(NoInput).output(type<string | null>()),
    /** `kind: "image"` narrows the picker. Null when cancelled. */
    openFiles: mutation
      .input(
        v.optional(v.object({ kind: v.optional(v.picklist(["all", "image"])) }))
      )
      .output(type<PickedFile[] | null>()),
  },
  /** http, https and mailto only; anything else is refused, not thrown. */
  openExternal: mutation
    .input(v.object({ url: v.pipe(v.string(), v.url()) }))
    .output(type<void>()),
  /** Restricted to the app's working directories; some paths are revealed. */
  openPath: mutation
    .input(v.object({ path: v.pipe(v.string(), v.nonEmpty()) }))
    .output(type<OpenFilePathResult>()),
  showItemInFolder: mutation
    .input(v.object({ path: v.pipe(v.string(), v.nonEmpty()) }))
    .output(type<void>()),
  info: query.input(NoInput).output(type<SystemInfo>()),
  /**
   * Open at login (spec 05 §31.5 c). macOS and Windows only; Linux answers
   * `PRECONDITION_FAILED { reason: "unsupported-platform" }`.
   */
  loginItem: {
    get: query.input(NoInput).output(type<{ openAtLogin: boolean }>()),
    set: mutation
      .input(v.object({ openAtLogin: v.boolean() }))
      .output(type<{ openAtLogin: boolean }>()),
  },
  restart: mutation.input(NoInput).output(type<void>()),
  /** First-run milestones; fire-and-forget. */
  funnelStep: mutation
    .input(
      v.object({
        step: v.picklist(FUNNEL_STEPS),
        detail: v.optional(v.string()),
        /**
         * Report only the first time this install reaches the step (main's
         * persisted `reportFunnelStepOnce`; spec 06 §6.5).
         */
        once: v.optional(v.literal(true)),
      })
    )
    .output(type<void>()),
  logs: {
    /** `filePath` is null when the user cancelled the save dialog. */
    save: mutation
      .input(v.object({ rendererLogs: v.string() }))
      .output(type<{ filePath: string | null }>()),
    /** Fire-and-forget: a log line never waits on main. */
    append: mutation
      .input(v.object({ lines: v.array(v.string()) }))
      .output(type<void>()),
  },
  notify: mutation
    .input(
      v.object({
        title: v.string(),
        body: v.string(),
        metadata: v.optional(
          v.object({
            kind: v.optional(v.picklist(["session", "bot", "routine"])),
            botId: v.optional(v.string()),
            routineId: v.optional(v.string()),
            workspaceId: v.optional(v.string()),
            sessionId: v.optional(v.string()),
          })
        ),
      })
    )
    .output(type<void>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<SystemEvent>())),
};
