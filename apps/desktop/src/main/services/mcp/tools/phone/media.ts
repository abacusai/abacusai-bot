import {
  CHATLLM_APP_ATTACHMENT_REASON,
  PAID_FEATURE_TOOL,
  PAID_FEATURES,
} from "@abacus-ai/contract/toolsets";

import { paidFeatureSchema } from "../paid-features";
import type { PhoneToolDefinition } from "./definition";

/**
 * The phone never makes media, nor reads a video: each is the plan's, in
 * Abacus AI Agent on the web or in the ChatLLM mobile app.
 */
const PHONE_MEDIA = PAID_FEATURES.filter(
  (feature) => !feature.inApp || feature.chatLlmAppKind != null
);

/** The server's marker for what only the ChatLLM app reads, and the feature it is. */
const chatLlmAppLines = PAID_FEATURES.flatMap((feature) =>
  feature.chatLlmAppKind == null
    ? []
    : [
        `- A \`[attachment not read: kind=${feature.chatLlmAppKind} reason=${CHATLLM_APP_ATTACHMENT_REASON}]\` line, or a ${feature.chatLlmAppKind} link`,
        `  they want you to watch: call this with feature ${feature.feature}, first, before you write anything.`,
      ]
);

export const PHONE_MEDIA_TOOLS: PhoneToolDefinition[] = [
  {
    surface: "phone",
    name: PAID_FEATURE_TOOL,
    toolsets: "always",
    offered: (host) =>
      host.withheldFeatures.some((feature) => PHONE_MEDIA.includes(feature)),
    description: [
      "Making images, editing a photo, making a video, or making speech or audio: the user's Abacus plan does these in",
      "Abacus AI Agent on the web. Call this whenever they ask for one, first, before you write anything, and never say",
      "you cannot. It says which plan includes it, its price and their link; send them that, as",
      "one short WhatsApp message in their language that opens with what the plan makes. Never make one through a",
      "connector (Canva, Hugging Face) instead, unless they named that app. Reading or describing a photo they sent is",
      "not one of these. A video is: the ChatLLM mobile app reads it on a paid plan, never this chat.",
      ...chatLlmAppLines,
    ].join("\n"),
    inputSchema: paidFeatureSchema(PHONE_MEDIA),
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
