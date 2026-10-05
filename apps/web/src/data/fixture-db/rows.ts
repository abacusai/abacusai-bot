/**
 * The canvas's home, as rows (spec 01 §10.2 step 2): the five bots from
 * `BotsSidebar`, the sessions and workspaces from `SessionsSidebar`, two
 * routines. Used by tests and by the dev fixture tables; never shipped.
 */
import type {
  BotRow,
  PrefsRow,
  RoutineRow,
  SessionRow,
  WorkspaceRow,
} from "@abacus-ai/contract/contract";

const minutesAgo = (now: number, minutes: number): number =>
  now - minutes * 60_000;

export const fixtureBots = (now = Date.now()): BotRow[] =>
  [
    [
      "chief-of-staff",
      "Chief of Staff",
      "Drafted in Gmail, waiting in drafts",
      "#22c55e",
      "blob",
      5,
    ],
    [
      "morning-brief",
      "Morning Brief",
      "Three meetings and one deadline today",
      "#3b82f6",
      "round",
      90,
    ],
    [
      "follow-up-tracker",
      "Follow-Up Tracker",
      "Two people owe you a reply",
      "#14b8a6",
      "squircle",
      60 * 26,
    ],
    [
      "meeting-prep",
      "Meeting Prep",
      "Brief ready for the design review",
      "#a855f7",
      "leaf",
      60 * 30,
    ],
    [
      "trend-scout",
      "Trend Scout",
      "Scanning launches and funding news",
      "#f97316",
      "pebble",
      60 * 50,
    ],
  ].map(([id, name, title, avatarColor, avatarShape, age]) => ({
    id: id as string,
    name: name as string,
    title: title as string,
    description: "",
    persona: "",
    avatarColor: avatarColor as string,
    avatarShape: avatarShape as string,
    workspaceId: null,
    sessionId: null,
    channel: null,
    model: null,
    createdAt: minutesAgo(now, (age as number) + 1000),
    updatedAt: minutesAgo(now, age as number),
  }));

export const fixtureWorkspaces = (): WorkspaceRow[] => [
  {
    id: "abacusai-bot",
    label: "abacusai-bot",
    description: "main",
    status: "active",
    path: "/Users/you/code/abacusai-bot",
    isActive: true,
  },
  {
    id: "default",
    label: "Default workspace",
    description: "",
    status: "idle",
    kind: "auto",
    isActive: false,
  },
  // Hidden from the sidebar: routine and bot folders.
  {
    id: "routine-folder",
    label: "Morning digest",
    description: "",
    status: "idle",
    kind: "routine",
    isActive: false,
  },
];

const session = (
  now: number,
  id: string,
  workspaceId: string,
  label: string,
  minutes: number,
  extra: Partial<SessionRow> = {}
): SessionRow => ({
  id,
  workspaceId,
  label,
  conversationId: null,
  createdAt: new Date(minutesAgo(now, minutes + 60)).toISOString(),
  updatedAt: new Date(minutesAgo(now, minutes)).toISOString(),
  status: "stopped",
  agentStatus: "idle" as SessionRow["agentStatus"],
  model: null,
  mode: null,
  worktreeId: null,
  worktreePath: null,
  worktreeBranch: null,
  routineId: null,
  runOutcome: null,
  runTrigger: null,
  editorFor: null,
  botOwned: false,
  owner: null,
  turn: null,
  ...extra,
});

export const fixtureSessions = (now = Date.now()): SessionRow[] => [
  session(
    now,
    "fix-sidebar-width",
    "abacusai-bot",
    "Fix sidebar restore width",
    2,
    {
      turn: {
        phase: "streaming",
        isBusy: true,
        updatedAt: new Date(now).toISOString(),
      },
    }
  ),
  session(now, "review-prs", "abacusai-bot", "Review my pull requests", 30),
  session(
    now,
    "terminal-tab",
    "abacusai-bot",
    "Terminal as a side panel tab",
    60 * 5
  ),
  session(
    now,
    "compress-installers",
    "abacusai-bot",
    "Compress the installers",
    60 * 28
  ),
  session(now, "spreadsheet", "default", "Clean up a spreadsheet", 60 * 3),
  session(now, "flights", "default", "Find me flights", 60 * 49),
  // Never listed: a bot's chat, a routine run, a routine editor.
  session(now, "bot-chat", "default", "Chief of Staff", 1, { botOwned: true }),
  session(now, "routine-run", "routine-folder", "Morning digest run", 10, {
    routineId: "morning-digest",
  }),
  session(now, "routine-editor", "default", "Editing a routine", 10, {
    editorFor: "morning-digest",
  }),
];

export const fixtureRoutines = (now = Date.now()): RoutineRow[] => [
  {
    id: "morning-digest",
    name: "Morning digest",
    schedule: "0 8 * * 1-5",
    runAt: null,
    webhookToken: null,
    prompt: "Summarise my inbox and calendar",
    workspaceId: "routine-folder",
    botId: null,
    enabled: true,
    createdAt: minutesAgo(now, 60 * 24 * 7),
    lastRunAt: minutesAgo(now, 60 * 3),
    lastResult: "Sent",
    nextRunAt: minutesAgo(now, -60 * 21),
    webhookUrl: null,
    webhookPublicPending: false,
    botName: null,
    recentRuns: [],
  },
  {
    id: "weekly-report",
    name: "Weekly report",
    schedule: "0 17 * * 5",
    runAt: null,
    webhookToken: null,
    prompt: "Write the weekly status report",
    workspaceId: null,
    botId: null,
    enabled: false,
    createdAt: minutesAgo(now, 60 * 24 * 30),
    lastRunAt: null,
    lastResult: null,
    nextRunAt: null,
    webhookUrl: null,
    webhookPublicPending: false,
    botName: null,
    recentRuns: [],
  },
];

export const fixturePrefs = (overrides: Partial<PrefsRow> = {}): PrefsRow => ({
  id: "app",
  theme: "system",
  language: "system",
  sidebar: { pinned: true, openSection: null },
  pinned: { sessionIds: ["fix-sidebar-width"], botIds: [] },
  models: { selectedModelId: null, favoriteModelIds: [], perWorkspace: {} },
  defaultMode: "DEFAULT" as PrefsRow["defaultMode"],
  workspaceExpanded: {},
  lastPickedWorkspaceId: null,
  recentFolders: [],
  creditsExhaustedAt: null,
  browserHomepage: null,
  onboardingStep: null,
  dismissals: { referralCardUntil: null, upsell: false },
  panes: {},
  motion: { reduce: "system" },
  sounds: { enabled: true, perEvent: {} },
  updatedAt: new Date(0).toISOString(),
  ...overrides,
});
