/**
 * Who this agent process is, for memory: decided once by the desktop when it
 * spawns the process (service-host `memoryEnv`), and only read here. What a
 * lane may load and write is decided in this file and nowhere else.
 */
import path from "path";

import { abacusBotDir } from "../config.js";
import { AgentMode } from "../protocol.js";
import type { ProjectRef, Scope } from "./notes.js";
import { chatProjectKey, findProject } from "./notes.js";

/**
 * off:        the Memory switch is off: nothing loaded, nothing written, no tool.
 * owner:      the user's own chat (desktop, a bot's chat with them, the phone lane).
 * routine:    a routine run; its own project only, never `you/`.
 * bot-sender: someone else talking to the user's bot: only their own contact notes.
 * sender:     someone else in a chat app with no bot: nothing at all.
 */
export type Lane = "off" | "owner" | "routine" | "bot-sender" | "sender";

export interface MemoryContext {
  lane: Lane;
  /** The project this chat works in, when the app knows one. */
  project: ProjectRef | null;
  /** bot-sender only: whose contact folder. */
  contact: string | null;
  /** Nobody is watching: the run gets the project card and its journal only. */
  unattended: boolean;
}

const LANES: readonly Lane[] = [
  "off",
  "owner",
  "routine",
  "bot-sender",
  "sender",
];

const parseProject = (raw: string | undefined): ProjectRef | null => {
  if (raw == null || raw.trim().length === 0) return null;
  try {
    const value = JSON.parse(raw) as Partial<ProjectRef>;
    if (
      (value.kind === "folder" ||
        value.kind === "bot" ||
        value.kind === "routine" ||
        value.kind === "topic") &&
      typeof value.key === "string" &&
      value.key.length > 0 &&
      typeof value.name === "string"
    )
      return {
        kind: value.kind,
        key: value.key,
        name: value.name,
        ...(typeof value.path === "string" ? { path: value.path } : {}),
      };
  } catch {
    // A malformed value is no project, never a crash at spawn.
  }
  return null;
};

/**
 * A process started without the desktop (tests, the bare CLI) is the owner,
 * working in the folder it was started in, unless that is one of the app's
 * own folders (the auto workspace, a bot's or a routine's home).
 */
const projectOfCwd = (cwd: string): ProjectRef | null => {
  const resolved = path.resolve(cwd);
  const home = path.resolve(abacusBotDir());
  if (resolved === home || resolved.startsWith(home + path.sep)) return null;
  return {
    kind: "folder",
    key: resolved,
    name: path.basename(resolved) || resolved,
    path: resolved,
  };
};

export const readMemoryContext = (
  cwd: string,
  mode: AgentMode | string,
  env: NodeJS.ProcessEnv = process.env
): MemoryContext => {
  const declared = env.ABACUSAI_BOT_MEMORY;
  const lane = LANES.find((each) => each === declared) ?? "owner";
  const declaredProject =
    declared == null
      ? projectOfCwd(cwd)
      : parseProject(env.ABACUSAI_BOT_MEMORY_PROJECT);
  // A chat in the auto workspace keeps the project it opened, across restarts.
  const opened =
    declaredProject == null && lane === "owner" && env.ABACUSAI_BOT_SESSION_ID
      ? chatProjectKey(env.ABACUSAI_BOT_SESSION_ID)
      : null;
  const openedProject = opened != null ? findProject(opened) : null;
  const project =
    declaredProject ??
    (openedProject != null
      ? {
          kind: openedProject.kind,
          key: openedProject.key,
          name: openedProject.name,
          ...(openedProject.path != null ? { path: openedProject.path } : {}),
        }
      : null);
  const contact =
    lane === "bot-sender"
      ? (env.ABACUSAI_BOT_MEMORY_CONTACT ?? "").trim() || null
      : null;
  return {
    // A sender chat with no contact to write to is the plain sender lane.
    lane: lane === "bot-sender" && contact == null ? "sender" : lane,
    project,
    contact,
    unattended: mode === AgentMode.Unattended,
  };
};

/** Whether this process gets the memory tool and a memory block at all. */
export const hasMemory = (context: MemoryContext): boolean =>
  context.lane !== "off" && context.lane !== "sender";

/** The project's folder name, when it already has one. */
export const projectSlug = (context: MemoryContext): string | null =>
  context.project == null
    ? null
    : (findProject(context.project.key)?.slug ?? null);

/** Whether `about you` reaches this chat's prompt. */
export const readsYou = (context: MemoryContext): boolean =>
  context.lane === "owner" && !context.unattended;

/**
 * Whether this chat may change notes in `scope`. Journals follow the same rule
 * except that a routine run may always add to its own project's journal.
 */
export const mayWrite = (
  context: MemoryContext,
  scope: Scope,
  slug: string | null
): boolean => {
  switch (context.lane) {
    case "owner":
      if (context.unattended) return false;
      return scope.kind !== "contact";
    case "routine":
      return (
        !context.unattended && scope.kind === "project" && scope.slug === slug
      );
    case "bot-sender":
      return (
        scope.kind === "contact" &&
        scope.slug === slug &&
        scope.contact === context.contact
      );
    default:
      return false;
  }
};

export const mayJournal = (
  context: MemoryContext,
  scope: Scope,
  slug: string | null
): boolean =>
  mayWrite(context, scope, slug) ||
  (context.lane === "routine" &&
    scope.kind === "project" &&
    scope.slug === slug);

/** Whether `scope` may be read (searched, opened) from this chat. */
export const mayRead = (
  context: MemoryContext,
  scope: Scope,
  slug: string | null
): boolean => {
  switch (context.lane) {
    case "owner":
      if (context.unattended)
        return scope.kind === "project" && scope.slug === slug;
      return scope.kind !== "contact";
    case "routine":
      return scope.kind === "project" && scope.slug === slug;
    case "bot-sender":
      return (
        (scope.kind === "project" && scope.slug === slug) ||
        (scope.kind === "contact" &&
          scope.slug === slug &&
          scope.contact === context.contact)
      );
    default:
      return false;
  }
};
