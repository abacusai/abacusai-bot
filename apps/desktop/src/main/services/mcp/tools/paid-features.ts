import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { AbacusPlanTier } from "@abacus-ai/contract/models";
import {
  abacusAgentPromptUrl,
  CHATLLM_APP_URLS,
  PAID_FEATURE_STEPS,
  PAID_FEATURE_TOOL,
  PAID_FEATURES,
  PLAN_FIRST_FEATURES,
  type PaidFeature,
  type PaidFeatureStep,
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
  /** The free plan's step for a creative ask; null on a paid or unread plan, or when not given. */
  step?: PaidFeatureStep | null;
}

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

const NEVER_CANNOT =
  "Never say you cannot do it, that it is not available, or that you have no tool for it. Never say you are making it or that it is on its way either: they make it there.";

/**
 * The reply's first words say what makes it and where. Asked for a video, the
 * model opened with "I can't make video here" and reached the plan only after.
 */
const leadWithYes = (example: string, opening = "your reply"): string =>
  `Open ${opening} with the yes: your first words say what makes it and where, for example "${example}" (in their language). Never open with what this app or chat lacks.`;

/** A plain edit of the user's own file (a cut, a trim) is local work, not a detour. */
const NO_DETOURS =
  "Do not make it another way instead: no Canva, Hugging Face or other connector, and no local script or program (ffmpeg, Blender, Python and the like), unless the user named that app or tool themselves. This answer is the answer. A plain edit of their own file (cut, trim, compress, convert) is not this: do that here as usual.";

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

const NO_THANKS =
  "say that is fine in one short line and carry on. Do not offer it again in this chat unless they ask for one of these again.";

/** One answer each to a yes, a price ask, a no and anything else. */
const answers = (again: string, no = NO_THANKS): string[] => [
  `- A yes (yes, ok, sure, sim, evet, dale or the like, in any language): one short line in their language and ${again}. Nothing else: do not start their request or any other work, and call no tool.`,
  `- Every later yes, ok, okay or sure, even right after you gave the link: ${again} once more. It is not a goodbye: never answer it with a thumbs-up or "let me know", and never say anything is being made or ready.`,
  "- They ask the price or what the plan gives: answer from the lines above, then the same link.",
  `- A no or not now: ${no}`,
  "- Anything else: do that, as usual.",
];

/**
 * How the next message is read. Offered a script beside the plan, users
 * answered "yes" and got a document; so the reply offers one thing, and a
 * yes, a no or a new ask each have one answer. `again` is what a yes gets.
 */
const afterOffer = (
  question: string,
  again: string,
  no?: string,
  otherWork = "(no script, storyboard or plan instead)"
): string[] => [
  `Offer no other work in this reply ${otherWork}, and end with at most one short question: ${question}. A yes then means only that.`,
  "When they answer it:",
  ...answers(again, no),
];

/**
 * The creative plan a free account gets for a media ask, made in text and
 * free, before anything is generated. Given a script and the upgrade in one
 * reply, first-day users read only "paid feature" and left; the upgrade now
 * waits until they ask to generate what was planned.
 */
const CREATIVE_PLAN: Partial<Record<string, string>> = {
  video_gen:
    'a bold one-line title; a storyboard of 4 to 8 scenes as a list, one or two short lines each (the time in bold, what is on screen and how the camera moves, then the voice-over or on-screen text in quotes); then one line with the length, format and music, and "Caption:" with one line and a few hashtags for where it will be posted. No table',
  image_gen:
    "what it will show, in one line; the composition (what sits where, the framing); the style, light and colours; any text on it in quotes; the size for where it goes; then the exact prompt, ready to paste, in one quote block of two to four sentences (for an edit of their own image, the exact change)",
  tts: "the text to be read, in one quote block of short lines with (pause) marks where the voice should rest, then one line on the voice, tone and length",
};

/** What the free plan's description says about the asks that get a plan first. */
const planFirstLines = (features: readonly PaidFeature[]): string[] => [
  `On this plan, ${names(features)} go in two steps, and both call this first, before you write anything (no preamble,`,
  'no "let me check", nothing about what this chat lacks):',
  "- step plan: an ask for one whose plan is not in this chat yet (to create, generate or edit an image, make a video,",
  "  make speech or audio, reading a text aloud included; even when it says generate, and asking whether you can make",
  "  one counts too), or a change to a plan you wrote (shorter, another style). Its answer says what the plan holds;",
  "  the app puts a Generate button under your reply.",
  '- step generate: once your plan for it is in this chat and they ask to generate or make it (a yes, "generate it",',
  "  the Generate button). Its answer says which plan makes it, at what price, with the link, and the app shows the",
  "  upgrade. Never write the plan again.",
  "In a routine's run, which nobody answers, use step generate at once.",
];

/**
 * The link types their request into Abacus AI Agent and sends nothing: told
 * only "open it there", the model said the video was being made.
 */
const PREFILL_ONLY =
  "The link only types their request into Abacus AI Agent; it sends nothing, and nothing is made until they send it there. Never say it is being made, that they will see it there, or that you started it: say they open it there and send it.";

/**
 * The free plan's first step: the creative plan, free, with no price and no
 * card. The app draws the Generate button from this call, so every plan
 * reply ends on it whatever the model chooses to offer.
 */
const planStep = (call: PaidFeatureCall, plan: string): string[] => [
  `Write the creative plan for their ${call.feature.name} now, in text, in their language: ${plan}.`,
  "Open straight on the plan; where a detail is missing, pick a sensible one instead of asking. Say nothing about plans, prices, upgrades or what this chat cannot do, and never say it is being made.",
  call.reply === "card"
    ? "End with one short question: whether to generate it now. The app shows a Generate button under your reply that answers it: do not call suggest_tasks in this reply, and do not list the button in your text."
    : "End with one short question: whether to generate it now.",
  `When they ask to generate it, call ${PAID_FEATURE_TOOL} with step generate. A change they ask for first: step plan again, then the revised plan.`,
];

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
  const creative = PLAN_FIRST_FEATURES.has(feature.feature)
    ? CREATIVE_PLAN[feature.feature]
    : undefined;
  if (call.step === "plan" && creative != null && reply !== "routine")
    return host.ok(planStep(call, creative).join("\n"));
  const next = plan?.upgrades[0];
  const where = elsewhere(call);
  if (next == null)
    return host.ok(
      [
        `${capitalized(feature.name)} is not on this account's free plan; it comes with the paid plans.${where}`,
        reply === "routine"
          ? `Say so in the run's result, with this upgrade link as written: ${botUpgradePage("paid_feature")}. ${NO_DETOURS}`
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
        : botUpgradePage("paid_feature");
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
  // Nobody answers a routine's result: it keeps the pitch alone.
  const creativePlan =
    reply === "routine" ? undefined : CREATIVE_PLAN[feature.feature];
  lines.push(
    "",
    ...(creativePlan != null
      ? [
          `They asked to generate what you planned. When an earlier reply in this chat holds its plan, your reply is only the lines below: never write the plan, storyboard, script or prompt again, not even shortened. Only when no earlier reply has a plan for it (they asked to generate it straight away), write one first, in text and in their language: ${creativePlan}.`,
        ]
      : []),
    `Tell them in their language, in one or two short lines, that ${includes}, naming (in their language) the feature above that covers it, and its price. ${leadWithYes(example, creativePlan != null ? "those lines" : "your reply")}${call.place === "web" ? ` ${ATTACHED}` : ""}`,
    offer,
    `If no feature above covers ${feature.name}, do not say the plan includes it. ${NEVER_CANNOT} ${NO_DETOURS} Do not call ${PAID_FEATURE_TOOL} again for this request.`
  );
  const again =
    link == null
      ? "where they upgrade again (the mobile app, under Settings)"
      : "the upgrade link again, exactly as written, on its own line";
  if (reply !== "routine")
    lines.push(
      ...afterOffer(
        `whether they want ${next.planName}`,
        again,
        undefined,
        creativePlan != null ? "beyond the plan" : undefined
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
  "say that is fine in one short line, and that the AbacusAI Bot desktop app is a free download that does this on a computer (bot.abacus.ai). Do not offer the upgrade again in this chat unless they ask for one of these again.";

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

/** Asked to cut the dull parts of their own recording, the model pitched video analysis: plain edits stay local. */
const NOT_THESE = [
  "Never tell the user you cannot do one of these or that it is not available, and never make one through a connector",
  "(Canva, Hugging Face) or a local script (ffmpeg, Blender, Python) instead, unless the user named that app.",
  "Not one of these: describing an image, and plain edits of the user's own media file that add nothing new (cut, trim,",
  "split, join, compress, convert, extract audio, resize, rotate, crop, or keep only the parts they want: ask which, or",
  "find the silences and scene changes). Do those on this computer with ffmpeg or the like, installing it with their OK",
  "if missing. Adding or changing what an image or video shows (a person, object, outfit or motion) is one of these.",
];

/** What each withheld feature the free plan's description sends straight here is, in the user's terms. */
const CALL_FIRST_ASK: Partial<Record<string, string>> = {
  video: "watch or describe what is in a video",
};

const description = (host: HostCapabilities): string => {
  const header = `${capitalized(names(host.withheldFeatures))}: the paid plans include these, and this account does not have them here.`;
  // The free plan plans what it would make before any upgrade; a paid plan's
  // media is made on the web, so its asks go straight here.
  const planFirst =
    host.freePlan === true
      ? host.withheldFeatures.filter((feature) =>
          PLAN_FIRST_FEATURES.has(feature.feature)
        )
      : [];
  if (planFirst.length === 0)
    return [
      header,
      "When the user asks for one (to create, generate or edit an image, make a video or change what one shows, watch or",
      "describe what is in a video, or make speech or audio, reading a text aloud included), call this first, before you",
      'write anything: no preamble, no "let me check", nothing about what this chat lacks. It says which plan includes it',
      "and where, at what price, with the link and how to word your reply; the app offers them the upgrade or Abacus AI",
      "Agent on the web.",
      ...NOT_THESE,
    ].join("\n");
  const callFirst = host.withheldFeatures.filter(
    (feature) => !planFirst.includes(feature)
  );
  return [
    header,
    ...planFirstLines(planFirst),
    ...(callFirst.length > 0
      ? [
          `When the user asks ${callFirst
            .map((feature) => {
              const ask = CALL_FIRST_ASK[feature.feature];
              return ask != null ? `you to ${ask}` : `for ${feature.name}`;
            })
            .join(" or ")}, call this first, before you`,
          'write anything: no preamble, no "let me check", nothing about what this chat lacks. It says which plan includes it',
          "and where, at what price, with the link and how to word your reply; the app offers them the upgrade.",
        ]
      : []),
    ...NOT_THESE,
  ].join("\n");
};

/** The schema both the app and the phone take. */
export const paidFeatureSchema = (
  features: readonly PaidFeature[],
  /** The free plan's image, video and voice-over asks name their step. */
  steps = false
): Record<string, unknown> => ({
  type: "object",
  properties: {
    ...(steps
      ? {
          step: {
            type: "string",
            enum: [...PAID_FEATURE_STEPS],
            description:
              "plan: a new ask, or a change to your plan; generate: they asked to generate what you planned. Required for an image, video or voice-over.",
          },
        }
      : {}),
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
    inputSchema: (_channel, host) =>
      paidFeatureSchema(
        host.withheldFeatures,
        host.freePlan === true &&
          host.withheldFeatures.some((feature) =>
            PLAN_FIRST_FEATURES.has(feature.feature)
          )
      ),
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
