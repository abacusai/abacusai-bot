/**
 * The kit configurations (spec 02 §5.1), created once at module scope
 * (`createChatUI` binds widgets once). No interrupts (F13), no `queue`
 * component (the host queue renders in `QueueSlot`, F1).
 */
import { createChatUI } from "@tanstack/ai-react/ui";

import { ChatLayout, ComposerSlot } from "./layout";
import { BotMessage, SessionMessage } from "./message";
import { DocumentView, ImageView, TextPartDispatch, ThinkingView, UnknownPart, VideoView } from "./parts";
import { subagentWidgets } from "./subagents/subagent-card";
import { botToolWidgets, sessionToolWidgets } from "./tools/tool-widgets";

const options = {} as const;

const partsComponents = {
  text: TextPartDispatch,
  thinking: ThinkingView,
  image: ImageView,
  video: VideoView,
  document: DocumentView,
  fallback: UnknownPart,
};

export const SessionUI = createChatUI(options, {
  components: { layout: ChatLayout, message: SessionMessage, input: ComposerSlot },
  partsComponents,
  toolsComponents: sessionToolWidgets,
  subagentsComponents: subagentWidgets,
});

export const BotUI = createChatUI(options, {
  components: { layout: ChatLayout, message: BotMessage, input: ComposerSlot },
  partsComponents,
  toolsComponents: botToolWidgets,
  subagentsComponents: subagentWidgets,
});
