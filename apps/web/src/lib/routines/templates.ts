import {
  Bug,
  CalendarClock,
  FlaskConical,
  Gamepad2,
  GitPullRequest,
  Globe,
  Inbox,
  MessageSquareCode,
  ShieldAlert,
  Sparkles,
  Sunrise,
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
  preset: "daily" | "weekdays" | "weekly" | "custom";
  /** 24-hour HH:MM, the dialog's own format. */
  time: string;
  /** The cron for a `custom` preset. */
  custom?: string;
  /** Connectors it reads from, named on the card so the ask is honest. */
  works?: string[];
  /**
   * The prompt says "this workspace": it reads a repository, a test suite,
   * a dependency file. Picking one points the dialog's folder field at the
   * open project, since a routine's own folder holds none of that.
   */
  needsWorkspace?: boolean;
  /**
   * A coding routine: offered by project, set up in one tap
   * (coding-routines.tsx), and left out of the full form's picks.
   */
  coding?: {
    /** The app checks a site the user names (`uptimeUrl`). */
    watchesSite?: boolean;
    /** A watcher: most runs find nothing (`quietIsNormal`). */
    quietIsNormal?: boolean;
    /** Runs when the GitHub watcher finds a new review (`githubReviews`). */
    githubReviews?: boolean;
  };
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
  {
    id: "nightly-tests",
    needsWorkspace: true,
    coding: {},
    icon: FlaskConical,
    preset: "daily",
    time: "02:00",
    prompt: [
      "Run this project's test suite. If it all passes, say so in one line",
      "with the count. If tests fail, fix them without touching my working",
      "copy: add a separate git worktree on a new branch from the default",
      "branch, find the cause of each failure, fix the code (the test only when",
      "the test itself is wrong), and run the suite again there. Commit, push",
      "the branch and open a draft pull request when this repository has a",
      "GitHub remote you can reach; otherwise leave the branch here. Never",
      "commit to or push the default branch, and remove the worktree when you",
      "are done. Report: the verdict on the first line (passed, failed,",
      "fixed), then one line per failure with the file and the cause, then the",
      "pull request link or the branch name. A failure that needs my decision:",
      "say what it needs and leave it.",
    ].join(" "),
  },
  {
    id: "pr-review-fixes",
    needsWorkspace: true,
    coding: { quietIsNormal: true, githubReviews: true },
    icon: MessageSquareCode,
    preset: "custom",
    time: "09:00",
    custom: "0 9-18 * * 1-5",
    prompt: [
      "Check my open pull requests on this project's GitHub repository for",
      "review comments and requested changes since your last run; your notes",
      "say which ones you already handled. For each new one that asks for a",
      "code change, make it in a separate git worktree on that pull request's",
      "branch, run the tests that cover it, commit, push to the same branch,",
      "and reply under the comment with what you changed. Never force-push,",
      "never touch my working copy, never push the default branch. A comment",
      "that needs my judgment: list it for me, do not answer it. Report: how",
      "many you fixed and how many need me on the first line, then one line",
      "each with the pull request and a link.",
    ].join(" "),
  },
  {
    id: "site-down",
    coding: { watchesSite: true },
    icon: Globe,
    preset: "custom",
    time: "09:00",
    custom: "*/5 * * * *",
    prompt: [
      "Watch my site and tell me when it goes down and when it comes back.",
      "When it goes down, say what it answered and anything in this project",
      "that may explain it, such as the latest commit or deploy. A few lines",
      "at most.",
    ].join(" "),
  },
  {
    id: "overnight-changes",
    needsWorkspace: true,
    coding: {},
    icon: Sunrise,
    preset: "weekdays",
    time: "08:30",
    prompt: [
      "Tell me what changed in this project's repository since yesterday",
      "morning. Fetch first, then: new commits on the main branches grouped by",
      "what they do, pull requests opened, merged or waiting on my review, and",
      "the default branch's CI status if you can see it. Five lines at most,",
      "with the one thing to look at first on the first line. If nothing",
      "changed, say so in one line.",
    ].join(" "),
  },
  {
    id: "game-check",
    needsWorkspace: true,
    coding: {},
    icon: Gamepad2,
    preset: "daily",
    time: "19:00",
    prompt: [
      "Build this game the way the project builds it and start it. A web game:",
      "open the build in the browser and play the first minute with its own",
      "controls. Report: on the first line whether it built and ran, then any",
      "build errors, console errors or crashes with the file to look at, and",
      "in one line what you saw on screen. Change no code.",
    ].join(" "),
  },
];

/** What the full form offers: a coding routine's settings come only with its own setup. */
export const FORM_ROUTINE_TEMPLATES = ROUTINE_TEMPLATES.filter(
  (template) => template.coding == null
);

/** The coding routines, in the order they are offered. */
export const CODING_ROUTINE_TEMPLATES = ROUTINE_TEMPLATES.filter(
  (template) => template.coding != null
);

/** Report-only templates the coding routines cover, left out where those are offered. */
export const CODING_COVERED_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  "pr-digest",
  "failing-tests",
]);
