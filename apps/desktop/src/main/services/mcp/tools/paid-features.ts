import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { AbacusPlanTier } from "@abacus-ai/contract/models";
import {
  abacusAgentPromptUrl,
  CHATLLM_APP_URLS,
  PAID_FEATURE_TOOL,
  PAID_FEATURES,
  type PaidFeature,
} from "@abacus-ai/contract/toolsets";

import { botUpgradePage } from "../../providers/abacus-upgrade";
import { bullets, priceLine } from "./billing";
import type {
  HostCapabilities,
  ToolDefinition,
  ToolResult,
} from "./definition";

/**
 * Where the plan serves a capability for an app caller: this app, or Abacus
 * AI Agent on the web. The phone answers from its own handoff
 * (`phoneHandoffResult`), never from here.
 */
export type PaidFeaturePlace = "app" | "web";

export const paidFeaturePlace = (feature: PaidFeature): PaidFeaturePlace =>
  feature.inApp ? "app" : "web";

/**
 * Paid-plan capabilities this account lacks: on the free plan, those whose
 * tools are not listed; on a paid one, those the plan serves only on the web.
 */
export const withheldFeatures = (
  tier: AbacusPlanTier,
  listed: (feature: PaidFeature) => boolean
): PaidFeature[] =>
  tier === "unknown"
    ? []
    : PAID_FEATURES.filter(
        (feature) => (tier === "free" || !feature.inApp) && !listed(feature)
      );

const names = (features: readonly PaidFeature[]): string =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(
    features.map((feature) => feature.name)
  );

/**
 * How the answer reaches the user: an app chat draws the card with a reply
 * that carries the link too; a chat app or the phone gets the link in the
 * reply; a routine's result carries the link.
 */
export type PaidFeatureReply = "card" | "chat" | "routine";

/** Where a call stands when it runs, which can differ from when it was listed. */
interface PaidFeatureCall {
  feature: PaidFeature;
  tier: AbacusPlanTier;
  place: PaidFeaturePlace;
  /** Its tools are listed for this caller now. */
  listed: boolean;
  reply: PaidFeatureReply;
  /** Read when the account could upgrade: null when it cannot be read. */
  plan: BillingPlan | null;
  /** The request in the user's words, carried to the web. */
  prompt: string | null;
}

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

const NEVER_CANNOT =
  "Never say you cannot do it, that it is not available, or that you have no tool for it. Never say you are making it or that it is on its way either: they make it there.";

/**
 * The reply's first words say what makes it and where. Asked for a video, the
 * model opened with "I can't make video here" and reached the plan only after.
 */
const leadWithYes = (example: string): string =>
  `Open your reply with the yes: your first words say what makes it and where, for example "${example}" (in their language). Never open with what this app or chat lacks.`;

const NO_DETOURS =
  "Do not make it another way instead: no Canva, Hugging Face or other connector, and no local script or program (ffmpeg, Blender, Python and the like), unless the user named that app or tool themselves. This answer is the answer.";

const ATTACHED =
  "If they gave you an image or file to edit, tell them to attach it there.";

/** Said only in the app, where Settings exist: the user's own key still makes it here. */
const OWN_KEY =
  "(This app makes it only with a provider key of the user's own, in Settings, API keys: say so only if they ask.)";

const webOnly = (feature: PaidFeature, reply: PaidFeatureReply): string =>
  `This app does not make ${feature.name} on the Abacus plan: the plan makes it in Abacus AI Agent on the web.${reply === "chat" ? "" : ` ${OWN_KEY}`}`;

/** The ChatLLM mobile app in each store, as the phone's answers give it. */
const CHATLLM_APP_LINKS = `The ChatLLM app: iPhone ${CHATLLM_APP_URLS.iphone} Android ${CHATLLM_APP_URLS.android}`;

/** Where a plan serves it, said beside the free plan's answer; nothing when it is this app. */
const elsewhere = (call: PaidFeatureCall): string =>
  call.place === "web" ? ` ${webOnly(call.feature, call.reply)}` : "";

/**
 * How the next message is read. Offered a script beside the plan, users
 * answered "yes" and got a document; so the reply offers one thing, and a
 * yes, a no or a new ask each have one answer. `again` is what a yes gets.
 */
const afterOffer = (
  question: string,
  again: string,
  no = "say that is fine in one short line and carry on. Do not offer it again in this chat unless they ask for one of these again."
): string[] => [
  `Offer no other work in this reply (no script, storyboard or plan instead), and end with at most one short question: ${question}. A yes then means only that.`,
  "When they answer it:",
  `- A yes (yes, ok, sure, sim, evet, dale or the like, in any language): one short line in their language and ${again}. Nothing else: do not start their request or any other work, and call no tool.`,
  `- Every later yes, ok, okay or sure, even right after you gave the link: ${again} once more. It is not a goodbye: never answer it with a thumbs-up or "let me know", and never say anything is being made or ready.`,
  "- They ask the price or what the plan gives: answer from the lines above, then the same link.",
  `- A no or not now: ${no}`,
  "- Anything else: do that, as usual.",
];

/**
 * The link types their request into Abacus AI Agent and sends nothing: told
 * only "open it there", the model said the video was being made.
 */
const PREFILL_ONLY =
  "The link only types their request into Abacus AI Agent; it sends nothing, and nothing is made until they send it there. Never say it is being made, that they will see it there, or that you started it: say they open it there and send it.";

/** The paid plan's answer: the plan already has it, on the web. */
const webAnswer = (call: PaidFeatureCall): string[] => {
  const { feature, reply, prompt } = call;
  return [
    `Their plan includes ${feature.name}. ${webOnly(feature, reply)}`,
    `Their link, which opens Abacus AI Agent with their request typed in: ${abacusAgentPromptUrl(prompt)}`,
    `Give the link exactly as written, on its own line.${reply === "card" ? " The app also shows an Open in Abacus AI Agent card with your reply, which opens the same." : ""}`,
    `Tell them so in their language, in one or two short lines. ${leadWithYes(`Your plan makes ${feature.name} in Abacus AI Agent on the web; your request is ready there:`)} Then the link, then that they open it and send it there. ${ATTACHED} Do not offer an upgrade for it. ${PREFILL_ONLY} ${NEVER_CANNOT} ${NO_DETOURS}`,
    ...afterOffer(
      "whether they want to open it there",
      "the link again, exactly as written, on its own line"
    ),
  ];
};

/** What the model is told when it asks for a capability this account lacks. */
export function paidFeatureResult(
  host: { ok: (text: string) => ToolResult },
  call: PaidFeatureCall
): ToolResult {
  const { feature, tier, listed, reply, plan } = call;
  if (listed)
    return host.ok(
      `The ${feature.name} tools are listed for you now: use them for this request.`
    );
  if (tier === "unknown")
    return host.ok(
      reply === "routine"
        ? `${capitalized(feature.name)} is made with a paid plan, in Abacus AI Agent on the web, not in this run. Say so in the run's result with this link as written: ${abacusAgentPromptUrl(call.prompt)}. ${NO_DETOURS}`
        : `Their plan cannot be read right now. Call billing_plan with upgrade: true and answer from it which plan includes ${feature.name}, leading with that plan and where it makes it. ${NEVER_CANNOT} ${NO_DETOURS}`
    );
  if (tier !== "free") {
    if (call.place === "app")
      return host.ok(
        `Their plan includes ${feature.name}, but it is switched off in Settings, Capabilities. Tell them, in their language, to switch it on there and ask again.`
      );
    return host.ok(webAnswer(call).join("\n"));
  }
  const next = plan?.upgrades[0];
  const where = elsewhere(call);
  if (next == null)
    return host.ok(
      [
        `${capitalized(feature.name)} is not on this account's free plan; it comes with the paid plans.${where}`,
        reply === "routine"
          ? `Say so in the run's result, with this upgrade link as written: ${botUpgradePage("app")}. ${NO_DETOURS}`
          : `Call billing_plan with upgrade: true, then tell them once, in their language, which plan includes it, its price and their upgrade link, leading with that plan and what it makes. ${NEVER_CANNOT} ${NO_DETOURS}`,
      ].join("\n")
    );
  const lines = [
    `${capitalized(feature.name)} is not on this account's free plan.${where}`,
    `The upgrade: ${next.planName}, ${priceLine(next)}. What it gives:`,
    ...bullets(next.features),
  ];
  // Only a chat app mints a one-time link. The app's reply stays in the chat
  // long after such a link dies, so it gets the bot's upgrade page, as a
  // routine does: that page signs the user in and makes their checkout itself.
  const link =
    reply === "chat"
      ? (next.url ??
        (plan?.upgradeInMobileApp === true ? null : botUpgradePage("channel")))
      : plan?.upgradeInMobileApp === true
        ? null
        : botUpgradePage("app");
  if (link != null) lines.push(`Their upgrade link: ${link}`);
  const offer =
    link == null
      ? "They upgrade in the mobile app, under Settings: say so instead of a link."
      : reply === "card"
        ? "Give the upgrade link exactly as written, on its own line. The app also shows an Upgrade card with your reply, which opens the same upgrade."
        : "Give the upgrade link exactly as written, on its own line.";
  const includes =
    call.place === "app"
      ? `${next.planName} includes ${feature.name} (in this app once they upgrade)`
      : `${next.planName} includes ${feature.name} on the web in Abacus AI Agent`;
  const example =
    call.place === "app"
      ? `${next.planName} gives you ${feature.name} right here: ${priceLine(next)}.`
      : `${next.planName} gives you ${feature.name} in Abacus AI Agent on the web: ${priceLine(next)}.`;
  lines.push(
    "",
    `Tell them in their language, in one or two short lines, that ${includes}, naming (in their language) the feature above that covers it, and its price. ${leadWithYes(example)}${call.place === "web" ? ` ${ATTACHED}` : ""}`,
    offer,
    `If no feature above covers ${feature.name}, do not say the plan includes it. ${NEVER_CANNOT} ${NO_DETOURS} Do not call ${PAID_FEATURE_TOOL} again for this request.`
  );
  // Nobody answers a routine's result.
  if (reply !== "routine")
    lines.push(
      ...afterOffer(
        `whether they want ${next.planName}`,
        link == null
          ? "where they upgrade again (the mobile app, under Settings)"
          : "the upgrade link again, exactly as written, on its own line"
      )
    );
  return host.ok(lines.join("\n"));
}

/** Where the phone's call stands when it runs. */
export interface PhoneHandoffCall {
  feature: PaidFeature;
  tier: AbacusPlanTier;
  /** Read (with its WhatsApp links) for a free or unread account's pitch: null when it cannot be read. */
  plan: BillingPlan | null;
}

/**
 * What the reply says first, for the asks this chat itself cannot do at all:
 * plainly, before the yes, so the user never waits for a file or an answer
 * that cannot come.
 */
const PHONE_FIRST: Record<string, string> = {
  video:
    "First say plainly, in a few words, that you cannot watch or analyse videos here in this chat, and that for free they can tell you what is in it or send a screenshot of it. Never ask them to send the video again.",
  project_files:
    "First say plainly, in a few words, that this chat cannot carry that file: WhatsApp refuses zip, apk, jar, exe and whole projects. Never send it, a renamed or zipped copy, or a link to it.",
  app_build:
    "Do not build it here and start nothing: it is built and deployed in the ChatLLM app.",
  routines:
    "Nothing was set up. With the plan, reminders, daily briefs and routines work right here in WhatsApp too.",
};

const PHONE_NO_DETOURS =
  "Do not do it another way in this chat instead: no `serve`, no `page`, no zip or renamed file, no connector or script, unless the user named that app or tool themselves. This answer is the answer.";

/** The free alternative a free account hears when it says no. */
const DESKTOP_ALTERNATIVE =
  "say that is fine in one short line, and that AbacusAI Bot is free on a computer, at bot.abacus.ai. Do not offer the upgrade again in this chat unless they ask for one of these again.";

/** The free account's pitch: Basic, all of it, and the link that takes them on to the ChatLLM app. */
const phoneUpgradeLines = (call: PhoneHandoffCall, link: string): string[] => {
  const { feature, plan } = call;
  const next = plan?.upgrades[0];
  const first = PHONE_FIRST[feature.feature];
  const where =
    "It takes them through the upgrade, then on to the ChatLLM app (the App Store or Google Play if they do not have it yet), where they ask for it.";
  const lines = [
    `${capitalized(feature.name)} is not in this chat on the free plan. With the paid plan, everything works fully on their phone in the ChatLLM app, ${feature.name} included.`,
    ...(first != null ? [first] : []),
  ];
  if (next == null)
    lines.push(
      `Call billing_plan with upgrade: true for the plan's price and what it gives, and pitch it from that, with this link: ${link}. Never invent a plan, price or feature.`,
      where
    );
  else
    lines.push(
      `The upgrade: ${next.planName}, ${priceLine(next)}. What it gives:`,
      ...next.features.map((line) => `  - ${line}`),
      `Their link: ${link}`,
      where,
      `${CHATLLM_APP_LINKS} (give these only when they ask where to get the app).`,
      "",
      `Tell them in their language, as one WhatsApp message: open with the yes, for example "With ${next.planName}, everything works fully on your phone in the ChatLLM app, this included: ${priceLine(next)}." Then every feature line above (translated, never shortened or dropped), then the link exactly as written on its own line.`
    );
  lines.push(
    `Never say it is not available to them: it is, in the ChatLLM app. ${PHONE_NO_DETOURS} Do not call ${PAID_FEATURE_TOOL} again for this request.`,
    ...afterOffer(
      `whether they want ${next?.planName ?? "the upgrade"}`,
      "the link again, exactly as written, on its own line",
      DESKTOP_ALTERNATIVE
    )
  );
  return lines;
};

/** A paid account's answer: the plan already does it, in the ChatLLM app. */
const phoneAppLines = (call: PhoneHandoffCall, link: string): string[] => {
  const { feature } = call;
  const first = PHONE_FIRST[feature.feature];
  return [
    `Their plan includes ${feature.name}: it works fully on their phone in the ChatLLM app, not in this chat.`,
    ...(first != null ? [first] : []),
    `Their link, which takes them to the ChatLLM app (the App Store or Google Play if they do not have it yet; the web on a computer): ${link}`,
    `${CHATLLM_APP_LINKS} (when they ask for the app itself: the one for their phone, both when you do not know which).`,
    `Tell them in their language, in one or two short lines: lead with the yes, for example "Your plan does this fully in the ChatLLM app:", then the link exactly as written on its own line, then that they ask for it there. Nothing is made in this chat: never say it is being made, that it is on its way, or that you started it. Do not offer an upgrade. ${PHONE_NO_DETOURS}`,
    ...afterOffer(
      "whether they want to open it there",
      "the link again, exactly as written, on its own line"
    ),
  ];
};

/**
 * The WhatsApp chat's answer for everything it sends to the ChatLLM app: on
 * the free plan, Basic's whole pitch and its upgrade link; on a paid one, the
 * app. Both links are AbacusAI Bot's own page, tagged for WhatsApp.
 */
export function phoneHandoffResult(
  host: { ok: (text: string) => ToolResult },
  call: PhoneHandoffCall
): ToolResult {
  const { tier, plan } = call;
  if (tier === "free")
    return host.ok(
      phoneUpgradeLines(
        call,
        plan?.upgrades[0]?.url ?? botUpgradePage("whatsapp")
      ).join("\n")
    );
  if (tier === "unknown")
    return host.ok(
      `Their plan cannot be read right now. Call billing_plan with upgrade: true and answer from it which plan includes ${call.feature.name}, leading with that plan and that everything then works fully on their phone in the ChatLLM app. ${PHONE_NO_DETOURS}`
    );
  return host.ok(phoneAppLines(call, botUpgradePage("whatsapp")).join("\n"));
}

const description = (host: HostCapabilities): string =>
  [
    `${capitalized(names(host.withheldFeatures))}: the paid plans include these, and this account does not have them here.`,
    "When the user asks for one (to create, generate or edit an image, make a video, or make speech or audio, reading a",
    'text aloud included), call this first, before you write anything: no preamble, no "let me check", nothing about',
    "what this chat lacks. It says which plan includes it and where, at what price, with the link and how to word your",
    "reply, which opens with what the plan makes; the app offers them the upgrade or Abacus AI Agent on the web.",
    "Never tell the user you cannot do one of these or that it is not available, and never make one through a connector",
    "(Canva, Hugging Face) or a local script (ffmpeg, Blender, Python) instead, unless the user named that app. Reading",
    "or describing an image or video is not one of these.",
  ].join("\n");

/** The schema both the app and the phone take. */
export const paidFeatureSchema = (
  features: readonly PaidFeature[]
): Record<string, unknown> => ({
  type: "object",
  properties: {
    feature: {
      type: "string",
      enum: features.map((feature) => feature.feature),
      description: features
        .map((feature) => `${feature.feature}: ${feature.name}`)
        .join("; "),
    },
    prompt: {
      type: "string",
      description:
        "What they asked for, in their words (for an image, what it should show), carried to the web.",
    },
  },
  required: ["feature"],
});

/** The agent's word on paid-plan capabilities withheld from this account. */
export const PAID_FEATURE_TOOLS: ToolDefinition[] = [
  {
    name: PAID_FEATURE_TOOL,
    toolsets: "always",
    offered: (host) => host.withheldFeatures.length > 0,
    description: (_channel, host) => description(host),
    inputSchema: (_channel, host) => paidFeatureSchema(host.withheldFeatures),
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
