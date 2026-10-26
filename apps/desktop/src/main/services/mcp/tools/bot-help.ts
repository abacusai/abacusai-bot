import type { Connector } from "@abacus-ai/connectors/registry";
/**
 * `bot_help`: questions about the app itself (what it can do, where a
 * setting is, what is connected, where and when routines run), answered from
 * the app's state at call time. The model answered these from memory and was
 * wrong (external models "cannot be connected", routines "run on the
 * server", Gmail "is not connected" while it was), so the answer is built
 * from the registries and live statuses, never written down as a FAQ.
 */
import {
  BOT_HELP_TOOL,
  BOT_HELP_TOPICS,
  type BotHelpBot,
  botHelpPathText,
  botHelpPlace,
  type BotHelpTopic,
} from "@abacus-ai/contract/bot-help";
import type { ConnectorStatus } from "@abacus-ai/contract/contracts";
import type {
  AbacusPlanTier,
  ModelAvailability,
} from "@abacus-ai/contract/models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";
import {
  PAID_FEATURE_TOOL,
  type PaidFeature,
  TOOLSETS_FOR_DISPLAY,
} from "@abacus-ai/contract/toolsets";

import {
  alwaysOnLine,
  HOSTED_ROUTINE_FACTS,
  LOCAL_ROUTINE_FACTS,
} from "./cronjob";
import type { ToolDefinition, ToolHost, ToolResult } from "./definition";

/** What the app knows when the question is asked; each part read only for the topics that need it. */
export interface BotHelpFacts {
  topic: BotHelpTopic | null;
  /** The provider, connector, chat app, bot or toolset asked about. */
  name: string;
  /** The hosted computer (bot.abacus.ai), not the desktop app. */
  hosted: boolean;
  tier: AbacusPlanTier;
  /** The app draws a button for the place under the reply (an app chat, not a chat app). */
  card: boolean;
  /** The caller is the WhatsApp chat on the user's phone. */
  phone: boolean;
  /** The plan's name as last read, when there is one. */
  planName: string | null;
  /** Where this app's routines run. */
  runner: "local" | "hosted";
  /** How many routines the user has, when routines were asked about. */
  routines: { local: number; hosted: number } | null;
  connectors: Array<{ connector: Connector; status: ConnectorStatus }> | null;
  models: ModelAvailability[] | null;
  /** Each model provider, and whether its key is set here. */
  providers: Array<{ provider: string; label: string; keySet: boolean }>;
  bots: BotHelpBot[];
  enabledToolsets: ReadonlySet<string>;
  withheldFeatures: readonly PaidFeature[];
}

const wants = (facts: BotHelpFacts, topic: BotHelpTopic): boolean =>
  facts.topic == null || facts.topic === topic;

const fold = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, "");

const matches = (text: string, name: string): boolean =>
  fold(name).length > 0 && fold(text).includes(fold(name));

const where = (facts: BotHelpFacts, topic: BotHelpTopic): string =>
  `Where: ${botHelpPathText(botHelpPlace(topic, facts.name, facts.bots))}`;

/** The 24/7 word for this plan; an unknown plan reads as free, which sends the model to billing_plan. */
const alwaysOn = (facts: BotHelpFacts): string => {
  const line = alwaysOnLine(
    facts.tier === "basic" || facts.tier === "paid" ? "paid" : "free"
  );
  return line.charAt(0).toUpperCase() + line.slice(1);
};

/** Topics where "does it work with the app closed" is asked of something other than a routine. */
const RUNS_WITH_THE_APP: ReadonlySet<BotHelpTopic | null> = new Set([
  null,
  "chat_apps",
  "connectors",
  "bots",
  "capabilities",
]);

function routinesSection(facts: BotHelpFacts): string[] {
  const lines = ["Routines:"];
  if (facts.runner === "hosted") lines.push(...HOSTED_ROUTINE_FACTS);
  else {
    lines.push(...LOCAL_ROUTINE_FACTS);
    lines.push(
      "Nothing this app runs is kept on a server: with the computer off or the app closed, no",
      "routine fires, no reminder is sent and no chat app is answered.",
      alwaysOn(facts)
    );
  }
  if (facts.hosted && facts.tier === "free")
    lines.push(
      "Routines here come with the paid plans: this account's free plan cannot make one." +
        " Call billing_plan with upgrade: true for the plan and link."
    );
  if (facts.routines != null)
    lines.push(
      `Their routines now: ${facts.routines.local + facts.routines.hosted}` +
        (facts.routines.hosted > 0
          ? ` (${facts.routines.hosted} on the server)`
          : "") +
        "."
    );
  lines.push(where(facts, "routines"));
  return lines;
}

function modelsSection(facts: BotHelpFacts): string[] {
  const lines = [
    "Models:",
    "The model each chat, bot and routine uses is picked in the model menu. Besides the",
    "models their Abacus AI plan includes, any provider below works with the user's own",
    "API key, added in the app (its row on the Models page); its models then run here.",
  ];
  const named =
    facts.name.length > 0 && facts.topic === "models"
      ? facts.providers.filter(
          (entry) =>
            matches(entry.label, facts.name) ||
            matches(entry.provider, facts.name)
        )
      : [];
  for (const entry of named.length > 0 ? named : facts.providers)
    lines.push(
      `- ${entry.label} (${entry.provider}): ${entry.keySet ? "key set" : "no key yet"}`
    );
  const runnable = (facts.models ?? []).filter((model) => model.configured);
  const onPlan = runnable.filter((model) => model.provider === "abacus");
  if (onPlan.length > 0)
    lines.push(
      `On their Abacus AI plan, runnable now: ${onPlan.map((model) => model.label).join(", ")}.`
    );
  if (facts.name.length > 0 && facts.topic === "models") {
    const asked = (facts.models ?? []).filter(
      (model) =>
        matches(model.label, facts.name) || matches(model.id, facts.name)
    );
    lines.push(
      asked.length === 0
        ? `No model in the catalog matches "${facts.name}" by name; it may still come with a provider above.`
        : `Matching "${facts.name}": ${asked
            .map(
              (model) =>
                `${model.label} (${model.configured ? "runs now" : "needs its key or plan"})`
            )
            .join(", ")}.`
    );
  }
  lines.push(where(facts, "models"));
  return lines;
}

const connectorLine = ({
  connector,
  status,
}: {
  connector: Connector;
  status: ConnectorStatus;
}): string =>
  `- ${connector.name}: ${
    status.state === "connected"
      ? `connected${status.account != null && status.account.length > 0 ? ` as ${status.account}` : ""}`
      : status.state === "unavailable"
        ? "unavailable right now"
        : "not connected"
  }`;

function connectorsSection(
  facts: BotHelpFacts,
  kind: "account" | "chat"
): string[] {
  const entries = (facts.connectors ?? []).filter((entry) =>
    kind === "chat"
      ? entry.connector.kind === "messaging"
      : entry.connector.kind !== "messaging"
  );
  const named =
    facts.name.length > 0
      ? entries.filter(
          (entry) =>
            matches(entry.connector.name, facts.name) ||
            matches(entry.connector.id, facts.name)
        )
      : [];
  const shown = named.length > 0 ? named : entries;
  const lines =
    kind === "chat"
      ? [
          "Chat apps (WhatsApp, Telegram, Discord), linked or not, right now:",
          ...shown.map(connectorLine),
          ...(facts.hosted
            ? []
            : [
                "The agent that reads and answers them runs in this app, so it answers only while",
                "the app is running on this computer.",
              ]),
          where(facts, "chat_apps"),
        ]
      : [
          "Connectors (accounts and tool servers), right now:",
          ...shown
            .filter(
              (entry) => named.length > 0 || entry.status.state === "connected"
            )
            .map(connectorLine),
          ...(named.length > 0
            ? []
            : [
                `Every other connector on the list is not connected: ${shown
                  .filter((entry) => entry.status.state !== "connected")
                  .map((entry) => entry.connector.name)
                  .join(", ")}.`,
              ]),
          "Connecting one: the user connects it in the app, or you ask for it with connect_connector.",
          where(facts, "connectors"),
        ];
  if (facts.connectors == null)
    return [
      lines[0]!,
      "Their status cannot be read right now: say so, never guess.",
    ];
  return lines;
}

function botsSection(facts: BotHelpFacts): string[] {
  return [
    "Bots:",
    facts.bots.length === 0
      ? "They have no bots yet."
      : `Their bots: ${facts.bots.map((bot) => bot.name).join(", ")}.`,
    "A bot's name, look, instructions, model and chat apps are changed in its editor (Edit bot).",
    where(facts, "bots"),
  ];
}

function capabilitiesSection(facts: BotHelpFacts): string[] {
  const on = TOOLSETS_FOR_DISPLAY.filter((set) =>
    facts.enabledToolsets.has(set.id)
  );
  const off = TOOLSETS_FOR_DISPLAY.filter(
    (set) => !facts.enabledToolsets.has(set.id)
  );
  const lines = [
    "Capabilities (tool groups the user switches on and off):",
    `On: ${on.map((set) => set.id).join(", ")}.`,
    `Off: ${off.length === 0 ? "none" : off.map((set) => set.id).join(", ")}.`,
  ];
  lines.push(
    "Making images, video or audio: the plan makes them in Abacus AI Agent on the web (and the user's",
    `own key for it makes them here, when one is set). Asked for one, call ${PAID_FEATURE_TOOL} first and lead with that.`
  );
  if (facts.withheldFeatures.length > 0)
    lines.push(
      `Not on this account here: ${facts.withheldFeatures.map((feature) => feature.name).join(", ")}. ` +
        `For any of these, call ${PAID_FEATURE_TOOL}: it says which plan has it and where.`
    );
  lines.push(where(facts, "capabilities"));
  return lines;
}

function planSection(facts: BotHelpFacts): string[] {
  return [
    "Plan:",
    ...(facts.planName != null ? [`Their plan: ${facts.planName}.`] : []),
    // billing_plan is listed on every plan, so it owns these whatever the tier.
    "For their credits, prices, what each plan includes and upgrading, call billing_plan (upgrade: true when they might upgrade) and answer from it, never from memory.",
    "This app's chats, bots and routines run on the plan's credits. Limits a plan lists for",
    "Abacus AI Agent are limits of Abacus AI Agent on the web, not of this app.",
    where(facts, "plan"),
  ];
}

/** What the model is told: the facts for the topic (or every topic), then how to answer. */
export function botHelpResult(
  host: Pick<ToolHost, "ok">,
  facts: BotHelpFacts
): ToolResult {
  const sections: string[][] = [];
  if (wants(facts, "routines")) sections.push(routinesSection(facts));
  if (wants(facts, "chat_apps"))
    sections.push(connectorsSection(facts, "chat"));
  if (wants(facts, "connectors"))
    sections.push(connectorsSection(facts, "account"));
  if (wants(facts, "models")) sections.push(modelsSection(facts));
  if (wants(facts, "bots")) sections.push(botsSection(facts));
  if (wants(facts, "capabilities")) sections.push(capabilitiesSection(facts));
  if (wants(facts, "plan")) sections.push(planSection(facts));
  const app = facts.hosted
    ? "AbacusAI Bot on the web (bot.abacus.ai)"
    : "the AbacusAI Bot desktop app";
  const how = facts.phone
    ? "They are on WhatsApp and cannot click here: give each place as short steps in AbacusAI Bot on a computer."
    : facts.card
      ? "A button under your reply opens the place: point to it, and give the path too."
      : "They cannot click a button in this chat: give each place as short steps.";
  // Asked about a chat app or a connector, "does it work with the app
  // closed" is still a question of where things run: every answer says it.
  const runs =
    facts.runner === "hosted" || !RUNS_WITH_THE_APP.has(facts.topic)
      ? []
      : [
          "Everything here (chats, bots, routines, chat-app replies) runs in this app on this",
          "computer, only while it is on and the app is open: nothing of it runs on a server.",
          alwaysOn(facts),
          "",
        ];
  return host.ok(
    [
      `What ${app} is and has right now, read from the app:`,
      "",
      ...runs,
      ...sections.flatMap((section) => [...section, ""]),
      "Answer from this, in the user's language, briefly. Every path above is the English app's:",
      `name each step as the app shows it in their language. ${how} Never add a setting, page,`,
      "limit or capability this answer does not give, and never say something is not connected",
      "or not possible when this answer says otherwise.",
    ].join("\n")
  );
}

const DESCRIPTION = [
  "Help with this bot's own setup, answered from its live state: its routines (when and where",
  "they run, and whether they run with the computer off), its models and provider keys, its",
  "connections (connectors and chat apps), its bots and its capabilities. For how do I…, can I…,",
  "where is…, is X connected, does X work when the app is closed, which models can I use, how do",
  "I connect a chat app or rename a bot. Call it before answering any of these; never answer them",
  "from memory, and never say something is not connected or not possible without it. It names",
  "the place in the app for each, which the app shows as a button.",
  "It is not for building or publishing apps, websites or pages: that is the user's task, not a",
  "question about this bot. Never call it to check whether you can do a task: when the user asks",
  "you to make, build or publish something, use the tools you have for it. Plan prices and",
  "credits are billing_plan's. Asked to make an image, video or speech, call paid_feature",
  "straight away instead: the plan makes them in Abacus AI Agent on the web.",
];

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      enum: [...BOT_HELP_TOPICS],
      description:
        "What the question is about; leave it out for an overview of everything.",
    },
    name: {
      type: "string",
      description:
        'The one thing asked about, when there is one: a provider ("gemini"), a connector ("gmail"), a chat app ("telegram"), a bot\'s name, or a capability.',
    },
  },
};

/** The phone's words: the same answer, for a chat that cannot open the app. */
export const BOT_HELP_PHONE_DESCRIPTION = [
  ...DESCRIPTION,
  "Its places are in AbacusAI Bot on a computer: give them as steps.",
].join("\n");

export const BOT_HELP_INPUT_SCHEMA = INPUT_SCHEMA;

/** Every place in the model's answer; the model's own memory of the app is never asked. */
export const BOT_HELP_TOOLS: ToolDefinition[] = [
  {
    name: BOT_HELP_TOOL,
    toolsets: "always",
    botAlways: true,
    description: DESCRIPTION.join("\n"),
    inputSchema: INPUT_SCHEMA,
    run: (host, args, callerSession) => host.botHelp(args, callerSession),
  },
];

/** A model provider's key, as the Models page lists it. */
export const modelProviders = (
  keySet: (envVar: string) => boolean
): BotHelpFacts["providers"] =>
  PROVIDER_KEY_FIELDS.filter((field) => field.kind === "model").map(
    (field) => ({
      provider: field.provider,
      label: field.label,
      keySet: keySet(field.envVar),
    })
  );
