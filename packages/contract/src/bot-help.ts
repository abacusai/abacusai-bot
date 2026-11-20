/**
 * Where things are in the app, for `bot_help`: the place a question about
 * the app is answered, as the path the user clicks and the route a button
 * opens. Built from the registries (providers, connectors, chat apps,
 * toolsets, the user's bots), never from a written list of answers, so a
 * place cannot outlive the page it names: the renderer's tests check every
 * route, search and label here against the router and en-US. The app's own
 * controls (the message box's buttons, a new chat, the areas and pages) are
 * `BOT_HELP_CONTROLS`, which the same tests hold to the renderer: a rail
 * area, page, shortcut or message-box button with no entry fails there.
 */
import { resolveConnector } from "@abacus-ai/connectors/registry";

import { PROVIDER_KEY_FIELDS } from "./settings";
import { TOOLSETS_FOR_DISPLAY } from "./toolsets";

export const BOT_HELP_TOOL = "bot_help";

/** What a question can be about; the tool's `topic`. */
export const BOT_HELP_TOPICS = [
  "models",
  "connectors",
  "chat_apps",
  "routines",
  "bots",
  "capabilities",
  "plan",
  "app",
] as const;
export type BotHelpTopic = (typeof BOT_HELP_TOPICS)[number];

const isBotHelpTopic = (value: unknown): value is BotHelpTopic =>
  (BOT_HELP_TOPICS as readonly unknown[]).includes(value);

/**
 * The topic and name a call asks about. A name that is itself a topic
 * ({ topic: "capabilities", name: "routines" }) is that topic, and a name
 * with no topic that one of the app's controls goes by ({ name: "mic" }) is
 * the app's: the model reaches for the nearest word, and the answer should
 * be the one it meant.
 */
export const botHelpRequest = (
  topic: unknown,
  name: unknown
): { topic: BotHelpTopic | null; name: string } => {
  const text = typeof name === "string" ? name.trim() : "";
  const named = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (isBotHelpTopic(named) && named !== topic)
    return { topic: named, name: "" };
  if (isBotHelpTopic(topic)) return { topic, name: text };
  return {
    topic: text.length > 0 && botHelpControls(text).length > 0 ? "app" : null,
    name: text,
  };
};

/**
 * One step of a path: the UI label's i18n key, and its en-US text for the
 * main process, which has no translator. A name from a registry (a
 * provider, a connector, a bot) has text only: it is shown as is.
 */
export interface BotHelpLabel {
  key?: string;
  text: string;
}

/** The routes a place may open; the renderer's tests check each is a real one. */
export const BOT_HELP_ROUTES = [
  "/settings/models",
  "/settings/account",
  "/library/connectors",
  "/library/messaging",
  "/library/tools",
  "/library/tools/$toolsetId",
  "/routines",
  "/bots",
  "/bots/$botId/edit",
  "/bots/new",
  "/sessions/new",
  "/artifacts",
  "/settings/general",
  "/settings/appearance",
  "/settings/notifications",
  "/settings/memory",
  "/settings/usage",
  "/settings/environment",
  "/settings/about",
  "/settings/browser",
  "/settings/devices",
  "/settings/keyboard",
  "/library/templates",
  "/library/mcp",
  "/library/skills",
] as const;
export type BotHelpRoute = (typeof BOT_HELP_ROUTES)[number];

export interface BotHelpPlace {
  /** What the user clicks, in order, from the app's rail. */
  path: readonly BotHelpLabel[];
  to: BotHelpRoute;
  params?: Readonly<Record<string, string>>;
  search?: Readonly<Record<string, string>>;
}

/** The fixed labels a path is made of. */
export const BOT_HELP_LABELS = {
  settings: { key: "shell.rail.settings", text: "Settings" },
  models: { key: "settings.pages.models", text: "Models" },
  account: { key: "settings.pages.account", text: "Account" },
  managePlan: { key: "phase5.managePlan", text: "Manage plan" },
  library: { key: "shell.rail.library", text: "Library" },
  connectors: { key: "library.pages.connectors", text: "Connectors" },
  messaging: { key: "library.pages.messaging", text: "Messaging" },
  tools: { key: "library.pages.tools", text: "Tools" },
  routines: { key: "shell.rail.routines", text: "Routines" },
  bots: { key: "shell.rail.bots", text: "Bots" },
  editBot: { key: "bots.sidebar.edit", text: "Edit bot" },
  sessions: { key: "shell.rail.sessions", text: "Sessions" },
  newSession: { key: "sessions.sidebar.new", text: "New session" },
} as const satisfies Record<string, BotHelpLabel>;

const L = BOT_HELP_LABELS;

const fold = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A control or page of the app, for questions on how to use the app itself
 * ("how do I dictate", "how do I start a new chat"). Its label is the app's
 * own (an i18n key and its en-US text); `how` is said to the model only.
 */
export interface BotHelpControl {
  id: string;
  /** What the app shows on it. */
  label: BotHelpLabel;
  /** What it shows in its other states (Stop while a reply runs). */
  states?: readonly BotHelpLabel[];
  /** The renderer's `data-slot`, for a control named by its value (the chosen model). */
  slot?: string;
  /** What people call it, besides its labels. */
  words?: readonly string[];
  /** Its shortcut, as the renderer's hotkeys write it ("Mod+N"). */
  hotkey?: string;
  /** Where it is and how it is used. A page has none: its label says what it is. */
  how?: string;
  /** The page it is on or opens, for the card; none for a control in the chat on screen. */
  place?: BotHelpPlace;
}

const pageOf = (
  under: BotHelpLabel,
  key: string,
  text: string,
  to: BotHelpRoute
): BotHelpControl => ({
  id: to,
  label: { key, text },
  place: { path: [under, { key, text }], to },
});

/** The message box's buttons, a new chat and the shell's controls, then every area and page. */
export const BOT_HELP_CONTROLS: readonly BotHelpControl[] = [
  {
    id: "new_chat",
    label: L.newSession,
    words: [
      "new chat",
      "new conversation",
      "start over",
      "fresh chat",
      "clear chat",
    ],
    hotkey: "Mod+N",
    how:
      "A new chat is a session: Sessions on the rail (the app's left edge), then the + (New session) at the top of the sessions list. " +
      "Typing /new in a session's message box does the same, and so does the shortcut while in Sessions (in Bots it makes a new bot). " +
      "The new chat opens empty; the earlier ones stay in the sessions list. A bot keeps one chat of its own.",
    place: { path: [L.sessions, L.newSession], to: "/sessions/new" },
  },
  {
    id: "dictate",
    label: { key: "chat.composer.dictate", text: "Dictate" },
    states: [{ key: "chat.composer.stopDictation", text: "Stop dictating" }],
    words: [
      "mic",
      "microphone",
      "voice",
      "dictation",
      "speak",
      "talk",
      "speech",
      "voice typing",
    ],
    how:
      "The microphone button in every chat's message box, at its right end beside Send. Click it and speak: a waveform and a timer show while it listens. " +
      "Click Stop dictating (the square button) to finish: the words are written into the message box to check and edit, then sent with Send. Escape cancels. " +
      "The first time, the app gets its speech model ready and says when dictation is ready; speech becomes text on this device. " +
      "If the microphone is blocked, allow the app under microphone in the computer's privacy settings.",
  },
  {
    id: "attach",
    label: { key: "chat.composer.attach", text: "Attach" },
    words: [
      "attachment",
      "file",
      "upload",
      "image",
      "photo",
      "picture",
      "folder",
      "pdf",
      "document",
    ],
    how:
      "The + button at the left of the message box: files or images, a folder, and Add connectors. " +
      "Files can also be dropped onto the message box or pasted into it.",
  },
  {
    id: "model",
    label: { key: "chat.composer.models", text: "Models" },
    slot: "chat-model-picker",
    words: [
      "model menu",
      "switch model",
      "change model",
      "pick a model",
      "llm",
    ],
    how:
      "The chosen model's name in the message box, left of the microphone: click it to search and pick a model (a star keeps one under Favourites). " +
      "Typing /model does the same. Switching mid-chat can offer to continue in a new chat. Keys for other providers are the models topic.",
  },
  {
    id: "modes",
    label: { key: "chat.composer.modes", text: "Permission modes" },
    slot: "chat-mode-picker",
    words: [
      "mode",
      "permission",
      "supervised",
      "auto",
      "full access",
      "approve",
      "approval",
      "sandbox",
    ],
    how:
      "The mode chip at the left of a session's message box (Supervised, Auto, Full access…) sets what runs without asking; /permissions does the same. " +
      "A bot's chat has no mode chip: it runs with full access.",
  },
  {
    id: "send",
    label: { key: "chat.composer.send", text: "Send" },
    states: [
      { key: "chat.composer.stop", text: "Stop" },
      { key: "chat.composer.queue", text: "Add to the queue" },
    ],
    words: [
      "send",
      "stop",
      "cancel",
      "interrupt",
      "queue",
      "enter",
      "new line",
    ],
    how:
      "The round button at the right end of the message box; Enter sends and Shift+Enter starts a new line. " +
      "While a reply runs it is Stop, and a message sent meanwhile is added to the queue and goes next.",
  },
  {
    id: "commands",
    label: { key: "chat.composer.commands", text: "Commands" },
    words: ["slash", "slash command", "/"],
    how: "Typing / in the message box lists the commands (/new, /model, /plan, /copy, /rename, /export…); /help shows every one.",
  },
  {
    id: "command_menu",
    label: { key: "shell.command.title", text: "Command menu" },
    words: ["search", "find a chat", "jump to", "palette"],
    hotkey: "Mod+K",
    how: "Opens a search of areas, pages, bots and sessions.",
  },
  {
    id: "sidebar",
    label: { key: "shell.topBar.toggleSidebar", text: "Toggle sidebar" },
    words: [
      "sidebar",
      "chat list",
      "history",
      "past chats",
      "old chats",
      "previous chats",
      "rename a chat",
      "delete a chat",
      "pin",
    ],
    hotkey: "Mod+B",
    how:
      "Each area's list sits left of its page: Sessions lists the chats, Bots the bots. Search it at the top; a row's menu renames, pins, marks unread or deletes. " +
      "The title bar's sidebar button or the shortcut hides and shows it; clicking the area already open on the rail does too.",
  },
  {
    id: "side_panel",
    label: { key: "shell.topBar.openPanel", text: "Open side panel" },
    words: [
      "side panel",
      "terminal",
      "browser",
      "changes",
      "diff",
      "undo changes",
      "files",
      "preview",
    ],
    hotkey: "Mod+Alt+B",
    how: "The button at the right of the title bar opens a chat's side panel: its tabs show Changes (each edited file, with Undo), Terminal, Files and Browser.",
  },
  {
    id: "share",
    label: { key: "share.action", text: "Share" },
    words: ["share", "public link", "link"],
    how: "Share in a chat's title bar, once the chat made something that can be shared (a page, a document): it makes a link anyone can open, listed and stoppable.",
  },
  {
    id: "/bots/new",
    label: L.bots,
    how: "Standing agents, each with its own instructions, model, memory and chats; New bot makes one.",
    place: { path: [L.bots], to: "/bots/new" },
  },
  {
    id: "/sessions/new",
    label: L.sessions,
    how: "The chats: each session is one, on a folder of this computer.",
    place: { path: [L.sessions], to: "/sessions/new" },
  },
  {
    id: "/routines",
    label: L.routines,
    how: "Tasks that run on a schedule, on demand or from a webhook.",
    place: { path: [L.routines], to: "/routines" },
  },
  {
    id: "/artifacts",
    label: { key: "shell.rail.artifacts", text: "Artifacts" },
    how: "Every file the chats and bots made, to open, find or share.",
    place: {
      path: [{ key: "shell.rail.artifacts", text: "Artifacts" }],
      to: "/artifacts",
    },
  },
  {
    id: "/library/connectors",
    label: L.library,
    how: "Connectors, chat apps, MCP servers, skills, tools and templates.",
    place: { path: [L.library], to: "/library/connectors" },
  },
  {
    id: "/settings/general",
    label: L.settings,
    hotkey: "Mod+,",
    how: "At the bottom of the rail.",
    place: { path: [L.settings], to: "/settings/general" },
  },
  ...(
    [
      ["general", "General"],
      ["appearance", "Appearance"],
      ["notifications", "Notifications"],
      ["memory", "Memory"],
      ["usage", "Usage"],
      ["account", "Account"],
      ["models", "Models"],
      ["environment", "Environment"],
      ["about", "About"],
      ["browser", "Browser"],
      ["devices", "Devices"],
      ["keyboard", "Keyboard"],
    ] as const
  ).map(([page, text]) =>
    pageOf(L.settings, `settings.pages.${page}`, text, `/settings/${page}`)
  ),
  ...(
    [
      ["templates", "Templates"],
      ["connectors", "Connectors"],
      ["messaging", "Messaging"],
      ["mcp", "MCP servers"],
      ["skills", "Skills"],
      ["tools", "Tools"],
    ] as const
  ).map(([page, text]) =>
    pageOf(L.library, `library.pages.${page}`, text, `/library/${page}`)
  ),
];

/** Every name a control goes by, folded for matching. */
const controlNames = (control: BotHelpControl): string[] =>
  [
    control.id,
    control.label.text,
    ...(control.states ?? []).map((state) => state.text),
    ...(control.words ?? []),
  ].map(fold);

/**
 * The controls a question names: those whose label, state or words match
 * the name, best first (a whole name before a part of one); every control for
 * no name, none for a name nothing in the app goes by.
 */
export const botHelpControls = (name: string): readonly BotHelpControl[] => {
  const wanted = fold(name);
  if (wanted.length === 0) return BOT_HELP_CONTROLS;
  const exact = BOT_HELP_CONTROLS.filter((control) =>
    controlNames(control).includes(wanted)
  );
  if (exact.length > 0) return exact;
  return BOT_HELP_CONTROLS.filter((control) =>
    controlNames(control).some(
      (known) =>
        known.length > 2 && (wanted.includes(known) || known.includes(wanted))
    )
  );
};

/** A bot the guide can name: the caller passes its own list. */
export interface BotHelpBot {
  id: string;
  name: string;
}

const modelsPlace = (name: string): BotHelpPlace => {
  const wanted = fold(name);
  const provider =
    wanted.length === 0
      ? undefined
      : PROVIDER_KEY_FIELDS.filter((field) => field.kind === "model").find(
          (field) =>
            fold(field.provider) === wanted ||
            fold(field.label).startsWith(wanted) ||
            wanted.startsWith(fold(field.provider))
        );
  return provider == null
    ? { path: [L.settings, L.models], to: "/settings/models" }
    : {
        path: [L.settings, L.models, { text: provider.label }],
        to: "/settings/models",
        search: { provider: provider.provider },
      };
};

const chatAppsPlace = (name: string): BotHelpPlace => {
  const resolved = name.trim().length > 0 ? resolveConnector(name) : null;
  const match =
    resolved != null &&
    "match" in resolved &&
    resolved.match?.kind === "messaging"
      ? resolved.match
      : null;
  return match == null
    ? { path: [L.library, L.messaging], to: "/library/messaging" }
    : {
        path: [L.library, L.messaging, { text: match.name }],
        to: "/library/messaging",
        search: { platform: match.platform },
      };
};

const connectorsPlace = (name: string): BotHelpPlace => {
  const resolved = name.trim().length > 0 ? resolveConnector(name) : null;
  const match = resolved != null && "match" in resolved ? resolved.match : null;
  if (match?.kind === "messaging") return chatAppsPlace(name);
  return match == null
    ? { path: [L.library, L.connectors], to: "/library/connectors" }
    : {
        path: [L.library, L.connectors, { text: match.name }],
        to: "/library/connectors",
        search: { connector: match.id },
      };
};

const botsPlace = (name: string, bots: readonly BotHelpBot[]): BotHelpPlace => {
  const wanted = fold(name);
  const bot =
    wanted.length === 0
      ? undefined
      : (bots.find((entry) => entry.id === name.trim()) ??
        bots.find((entry) => fold(entry.name) === wanted));
  return bot == null
    ? { path: [L.bots], to: "/bots" }
    : {
        path: [L.bots, { text: bot.name }, L.editBot],
        to: "/bots/$botId/edit",
        params: { botId: bot.id },
      };
};

const capabilitiesPlace = (name: string): BotHelpPlace => {
  const wanted = fold(name);
  const toolset =
    wanted.length === 0
      ? undefined
      : TOOLSETS_FOR_DISPLAY.find(
          (set) =>
            fold(set.id) === wanted ||
            set.tools.some((tool) => fold(tool.name) === wanted)
        );
  return toolset == null
    ? { path: [L.library, L.tools], to: "/library/tools" }
    : {
        path: [
          L.library,
          L.tools,
          {
            key: `capabilities.toolsets.${toolset.labelKey}.label`,
            text: toolset.id.replace(/_/g, " "),
          },
        ],
        to: "/library/tools/$toolsetId",
        params: { toolsetId: toolset.id },
      };
};

/**
 * Where a question on `topic` (about `name`, when one is given) is answered
 * in the app. The main process words the path; the renderer draws the same
 * place as a button, so both read this one function. Null for a control in
 * the chat on screen (the microphone), or an app question that names none.
 */
export function botHelpPlace(
  topic: BotHelpTopic,
  name = "",
  bots: readonly BotHelpBot[] = []
): BotHelpPlace | null {
  switch (topic) {
    case "models":
      return modelsPlace(name);
    case "connectors":
      return connectorsPlace(name);
    case "chat_apps":
      return chatAppsPlace(name);
    case "routines":
      return { path: [L.routines], to: "/routines" };
    case "bots":
      return botsPlace(name, bots);
    case "capabilities":
      return capabilitiesPlace(name);
    case "plan":
      return {
        path: [L.settings, L.account, L.managePlan],
        to: "/settings/account",
        search: { focus: "plan" },
      };
    case "app":
      return name.trim().length === 0
        ? null
        : (botHelpControls(name)[0]?.place ?? null);
  }
}

/** A path as English words: "Settings → Models → Google Gemini (AI Studio)". */
export const botHelpPathText = (place: BotHelpPlace): string =>
  place.path.map((label) => label.text).join(" → ");
