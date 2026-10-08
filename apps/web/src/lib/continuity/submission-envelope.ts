import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import type { UIMessage } from "@tanstack/ai-client";

export interface SubmissionEnvelope {
  runId: string;
  messageId: string;
  userText?: UserTextTags;
  parts: UIMessage["parts"];
  forwardedProps?: Record<string, unknown>;
}
