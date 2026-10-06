/**
 * The phone loop: the forever-chat engine running the phone profile. See
 * forever/engine.ts for the loop and phone-profile.ts for what makes it the
 * user's lifelong WhatsApp conversation.
 */
import { defaultModelFor, loadConfig } from "../config.js";
import { ForeverEngine, type ForeverEngineOptions } from "../forever/engine.js";
import type { PagePublisher } from "./phone-page-tool.js";
import { createPhoneProfile } from "./phone-profile.js";

export type { PagePublisher, PhonePage } from "./phone-page-tool.js";
export { PHONE_BUBBLE_MARKER } from "./phone-prompts.js";

export interface PhoneSessionOptions extends ForeverEngineOptions {
  /** How `page` publishes; the hosted app wires it to its server endpoint. */
  pagePublisher?: PagePublisher;
}

export class PhoneSession extends ForeverEngine {
  constructor({ pagePublisher, ...options }: PhoneSessionOptions) {
    super(
      options,
      createPhoneProfile({
        // The same choice the engine makes when it resolves the start model.
        model: options.model ?? loadConfig().defaultModel ?? defaultModelFor(),
        ...(pagePublisher != null ? { pagePublisher } : {}),
      })
    );
  }
}
