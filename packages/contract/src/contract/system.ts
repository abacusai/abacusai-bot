import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { AbacusStreak, OpenFilePathResult } from "../contracts";
import { FUNNEL_STEPS } from "../funnel";
import type { OpenLink } from "../open-link";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

/** What the renderer used to read synchronously from the preload. */
export interface SystemInfo {
  appVersion: string;
  legacyComposerDrafts?: Record<string, string>;
  /** Upgraded from the old renderer (1.0.85 or earlier). */
  legacyInstall: boolean;
  platform: string;
  /**
   * The OS's preferred languages, in order (absent from an older main): what
   * a "system" UI language and the agent's reply fallback both resolve from.
   */
  systemLanguages?: string[];
  arch: string;
  versions: Record<string, string | undefined>;
  homeDir: string;
  paths: { home: string; sessionHome: string; botHome: string };
  materialIconsBasePath: string | null;
  contractVersion: number;
  foundationApi: number;
}

export interface NotificationMetadata {
  kind?:
    | "bot"
    | "session"
    | "routine"
    | "routine-run"
    | "messaging"
    | "channel"
    | "github-watch";
  botId?: string;
  channelId?: string;
  routineId?: string;
  workspaceId?: string;
  sessionId?: string;
  /** Text for the session's composer, placed there and never sent; an empty composer only. */
  draft?: string;
}

export type SystemEvent =
  | {
      type: "notification";
      title: string;
      body: string;
      metadata?: NotificationMetadata;
    }
  | {
      type: "notification-clicked";
      metadata: NotificationMetadata;
    }
  /** A page was installed as an app or uninstalled: install buttons ask again. */
  | { type: "installed-apps-changed" }
  /** An `abacusaibot://` link is waiting: `takeOpenLink` hands it over. */
  | { type: "open-link" }
  /** A quit met running work, or its wait changed; see `quitGuard`. */
  | { type: "quit-guard"; state: QuitGuardState }
  /** The streak as the platform answered a finished turn's report: newer than the last account read. */
  | { type: "streak"; streak: AbacusStreak };

/** One piece of running work a quit would stop. */
export interface QuitGuardWork {
  sessionId: string;
  /** The chat's name; empty when it has none yet. */
  label: string;
}

/**
 * A quit while work runs: `asking` waits on the user's choice, `waiting`
 * quits by itself once the work is done.
 */
export type QuitGuardState =
  | { phase: "idle" }
  | { phase: "asking" | "waiting"; work: QuitGuardWork[] };

export const QUIT_GUARD_ANSWERS = ["shown", "wait", "quit", "cancel"] as const;
export type QuitGuardAnswer = (typeof QUIT_GUARD_ANSWERS)[number];

export interface PickedFile {
  path: string;
  name: string;
  /** Empty when the file is over the kind's size cap (`theme`). */
  data: Uint8Array;
  mimeType: string;
  /** Bytes on disk. */
  size?: number;
}

/** What `saveCopy` did. */
export interface SaveCopyResult {
  /**
   * The saved file (one file) or the folder the copies went into; null when
   * the user cancelled, nothing was found, or the browser downloaded them.
   */
  destination: string | null;
  saved: number;
  /** Items not saved: no longer there, or the copy failed. */
  skipped: number;
}

/** A file as the readers take it: the path the agent named, and its root. */
export interface SaveCopyItem {
  filePath: string;
  hostRoot: string;
}

const SaveCopyItemSchema = v.object({
  filePath: v.pipe(v.string(), v.nonEmpty()),
  hostRoot: v.pipe(v.string(), v.nonEmpty()),
});

export const system = {
  activity: mutation.input(NoInput).output(type<void>()),
  openPrivacyPane: mutation
    .input(
      v.object({ pane: v.picklist(["screen-recording", "accessibility"]) })
    )
    .output(type<void>()),
  dialog: {
    /** Null when cancelled. */
    openFolder: mutation.input(NoInput).output(type<string | null>()),
    /**
     * `kind: "image"` narrows the picker; `"theme"` picks one .json/.jsonc
     * and leaves `data` empty over THEME_FILE_MAX_BYTES. Null when cancelled.
     */
    openFiles: mutation
      .input(
        v.optional(
          v.object({ kind: v.optional(v.picklist(["all", "image", "theme"])) })
        )
      )
      .output(type<PickedFile[] | null>()),
  },
  /**
   * http, https and mailto go to the OS; a local file: URL takes openPath's
   * checks; anything else is refused, not thrown.
   */
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
  /**
   * "Save" / "Save all" on files the bot made, from the local window only.
   * One file: the OS save dialog, which asks before replacing. Several, or a
   * folder: a folder picker, each copied in under a name not yet taken there.
   * Paths resolve as the file readers' do (`~`, `/workspace`, relative).
   */
  saveCopy: mutation
    .input(
      v.object({
        items: v.pipe(
          v.array(SaveCopyItemSchema),
          v.minLength(1),
          v.maxLength(1000)
        ),
      })
    )
    .output(type<SaveCopyResult>()),
  info: query.input(NoInput).output(type<SystemInfo>()),
  acknowledgeLegacyDrafts: mutation
    .input(v.object({ keys: v.array(v.string()) }))
    .output(type<void>()),
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
  /** The quit guard now; its changes arrive as `quit-guard` events. */
  quitGuard: query.input(NoInput).output(type<QuitGuardState>()),
  /**
   * The main window's answer to an `asking` quit (`shown`: its dialog is up,
   * so main shows no native one), or `cancel` to stop a `waiting` one.
   */
  answerQuitGuard: mutation
    .input(v.object({ answer: v.picklist(QUIT_GUARD_ANSWERS) }))
    .output(type<void>()),
  deleteAllData: mutation
    .input(v.strictObject({ confirmation: v.literal("DELETE_ALL_LOCAL_DATA") }))
    .output(type<void>()),
  /**
   * The `abacusaibot://` link the app last opened from, once: null when
   * there is none or another caller took it.
   */
  takeOpenLink: mutation.input(NoInput).output(type<OpenLink | null>()),
  /**
   * "Install as app": a page the agent made in a chat (a served URL, an html
   * file) gets a launcher entry and a window of its own. Desktop only.
   */
  artifactApps: {
    list: query
      .input(NoInput)
      .output(type<Array<{ id: string; title: string }>>()),
    /** Whether a presented page (URL or path) can be installed, and its app's id when it is. */
    status: query
      .input(v.object({ target: v.pipe(v.string(), v.nonEmpty()) }))
      .output(
        type<{
          installable: boolean;
          installedId: string | null;
          /** "app": a tool or game (keeps data, draws, animates); "site": a page to read. */
          kind: "app" | "site";
        }>()
      ),
    /** Installs it, or returns the app it already is. */
    install: mutation
      .input(
        v.object({
          target: v.pipe(v.string(), v.nonEmpty()),
          sessionId: v.nullable(v.pipe(v.string(), v.maxLength(200))),
        })
      )
      .output(type<{ id: string; title: string }>()),
    /** Asks the user first; false when they cancelled. */
    uninstall: mutation
      .input(v.object({ id: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)) }))
      .output(type<boolean>()),
    open: mutation
      .input(v.object({ id: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)) }))
      .output(type<void>()),
  },
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
        kind: v.optional(v.picklist(["needs-you", "done", "failed"])),
        dedupeKey: v.optional(v.string()),
        metadata: v.optional(
          v.object({
            kind: v.optional(
              v.picklist([
                "bot",
                "session",
                "routine",
                "routine-run",
                "messaging",
                "channel",
                "github-watch",
              ])
            ),
            botId: v.optional(v.string()),
            channelId: v.optional(v.string()),
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
