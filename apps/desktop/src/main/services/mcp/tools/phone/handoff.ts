import {
  CHATLLM_APP_ATTACHMENT_REASON,
  PAID_FEATURE_TOOL,
  PHONE_HANDOFF_FEATURES,
} from "@abacus-ai/contract/toolsets";

import { paidFeatureSchema } from "../paid-features";
import type { PhoneToolDefinition } from "./definition";

const { feature } = (
  paidFeatureSchema(PHONE_HANDOFF_FEATURES) as {
    properties: { feature: unknown };
  }
).properties;

/**
 * Everything the WhatsApp chat cannot do itself goes to the ChatLLM app
 * through this one tool: Basic's pitch and its upgrade link on the free plan,
 * the app's link on a paid one.
 */
export const PHONE_HANDOFF_TOOLS: PhoneToolDefinition[] = [
  {
    surface: "phone",
    name: PAID_FEATURE_TOOL,
    toolsets: "always",
    description: [
      "What this chat never does itself; the ChatLLM app on their phone does it fully. Call this first, before you write",
      "anything, whenever they ask for one of these:",
      "- app_build: build a website, landing page, web app, mobile app, game, bot or any code project (not a `page`: a",
      "  `page` is for reading, an itinerary, plan, guide or comparison; a site or app is theirs to show, run or install).",
      "- project_files: a file this chat cannot carry: a zip, apk, jar, exe or a whole project.",
      "- video: watching, analysing or summarising a video, one they sent included (you cannot watch videos here).",
      ...PHONE_HANDOFF_FEATURES.flatMap((entry) =>
        entry.chatLlmAppKind == null
          ? []
          : [
              `  A \`[attachment not read: kind=${entry.chatLlmAppKind} reason=${CHATLLM_APP_ATTACHMENT_REASON}]\` line, or a ${entry.chatLlmAppKind} link`,
              `  they want you to watch: call this with feature ${entry.feature}, first, before you write anything.`,
            ]
      ),
      "- image_gen, video_gen, tts: making or editing an image, making a video, making speech or audio.",
      "- routines: a reminder, a daily brief or anything on a schedule, when the cronjob tool says the plan does not",
      "  set them up here.",
      "Never for reading or describing a photo they sent. It says what to tell them with their one link: the upgrade on",
      "the free plan, which then takes them to the ChatLLM app, or straight to the app on a paid plan.",
      "Never say you cannot help, never promise to send or make it here, and never do it another way (serve, page,",
      "zip, a connector) unless they named that app.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { feature },
      required: ["feature"],
    },
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
