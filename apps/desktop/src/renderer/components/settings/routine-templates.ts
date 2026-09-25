import {
  Bug,
  CalendarClock,
  GitPullRequest,
  Inbox,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * Routine templates: first drafts, every field editable in the dialog. The
 * prompt is not localized (the agent runs on it; the user rewrites it), the
 * name and blurb are i18n keys. Each is written for what this app can reach.
 */
export interface RoutineTemplate {
  /** Also the i18n key stem: routines.templates.<id>.name / .description */
  id: string;
  icon: LucideIcon;
  prompt: string;
  preset: "daily" | "weekdays" | "weekly";
  /** 24-hour HH:MM, the dialog's own format. */
  time: string;
  /** Connectors it reads from, named on the card so the ask is honest. */
  works?: string[];
  /**
   * The prompt says "this workspace": it reads a repository, a test suite,
   * a dependency file. Picking one points the dialog's folder field at the
   * open project, since a routine's own folder holds none of that.
   */
  needsWorkspace?: boolean;
}

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "morning-brief",
    icon: Sparkles,
    preset: "weekdays",
    time: "08:30",
    works: ["Google Calendar", "Gmail", "Slack"],
    prompt: [
      "Tell me what today needs from me, in under ten lines. Pull today's",
      "calendar, the mail that actually wants a reply, and anything in Slack",
      "addressed to me directly. Lead with whatever is time-sensitive, say",
      "what you think can wait, and name the one thing worth doing first.",
      "Skip anything that needs no decision from me.",
    ].join(" "),
  },
  {
    id: "inbox-triage",
    icon: Inbox,
    preset: "weekdays",
    time: "09:00",
    works: ["Gmail"],
    prompt: [
      "Go through the mail that came in since your last run. Sort it into",
      "needs a reply, worth reading, and noise, and say which is which in one",
      "line each. Draft replies in my voice for the ones that need one and",
      "show me the drafts. Send nothing. Flag anything with a deadline in it.",
    ].join(" "),
  },
  {
    id: "pr-digest",
    needsWorkspace: true,
    icon: GitPullRequest,
    preset: "weekdays",
    time: "17:30",
    prompt: [
      "Look at the open pull requests on this workspace's repository. For each",
      "one say what it changes, whether it is waiting on me or on someone",
      "else, and how long it has been sitting. Put the ones going stale first.",
      "Say plainly if there are none rather than padding the report.",
    ].join(" "),
  },
  {
    id: "failing-tests",
    needsWorkspace: true,
    icon: Bug,
    preset: "daily",
    time: "07:00",
    prompt: [
      "Run this workspace's test suite and tell me only what changed: tests",
      "that fail now and passed before, and tests that pass now and failed",
      "before. For each new failure, name the likely cause from the output and",
      "the file to look at. Do not fix anything. Report and stop.",
    ].join(" "),
  },
  {
    id: "dependency-watch",
    needsWorkspace: true,
    icon: ShieldAlert,
    preset: "weekly",
    time: "10:00",
    prompt: [
      "Check this workspace's dependencies for security advisories and for",
      "releases we are more than a major version behind on. Separate the two:",
      "an advisory is something to act on this week, a version bump usually is",
      "not. For each advisory say what it affects and whether we reach the",
      "vulnerable code. Propose nothing that needs a rewrite.",
    ].join(" "),
  },
  {
    id: "week-in-review",
    needsWorkspace: true,
    icon: CalendarClock,
    preset: "weekly",
    time: "16:00",
    prompt: [
      "Write up the week from this workspace's commit history: what shipped,",
      "what is half-finished, and what has not moved since last week. Group it",
      "by theme rather than listing commits, and keep it short enough to paste",
      "into a status update. End with what looks stuck.",
    ].join(" "),
  },
];
