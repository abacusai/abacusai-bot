import { PAID_FEATURE_TOOL, PAID_FEATURES } from "@abacus-ai/contract/toolsets";

import { paidFeatureSchema } from "../paid-features";
import type { PhoneToolDefinition } from "./definition";

/** The phone never makes media: each kind is the plan's, in Abacus AI Agent on the web. */
const PHONE_MEDIA = PAID_FEATURES.filter((feature) => !feature.inApp);

export const PHONE_MEDIA_TOOLS: PhoneToolDefinition[] = [
  {
    surface: "phone",
    name: PAID_FEATURE_TOOL,
    toolsets: "always",
    offered: (host) => host.withheldFeatures.some((feature) => !feature.inApp),
    description: [
      "Making images, editing a photo, making a video, or making speech or audio: the user's Abacus plan does these in",
      "Abacus AI Agent on the web. Call this whenever they ask for one, first, before you write anything, and never say",
      "you cannot. It says which plan includes it, its price and their link; send them that, as",
      "one short WhatsApp message in their language that opens with what the plan makes. Never make one through a",
      "connector (Canva, Hugging Face) instead, unless they named that app. Reading or describing a photo or video they",
      "sent is not one of these.",
    ].join("\n"),
    inputSchema: paidFeatureSchema(PHONE_MEDIA),
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
