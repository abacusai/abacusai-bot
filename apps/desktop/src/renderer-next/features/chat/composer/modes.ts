/**
 * The permission modes the mode chip offers (spec 02 §8.2, canvas
 * "Session, permission mode open"), in menu order.
 */
import { AgentMode } from "#shared/agent-types";

export const MODE_ORDER: readonly AgentMode[] = [
  AgentMode.Auto,
  AgentMode.Normal,
  AgentMode.AcceptEdits,
  AgentMode.PlanMode,
  AgentMode.Yolo,
];

export const MODE_LABEL_KEYS: Record<string, string> = {
  [AgentMode.Auto]: "chat.mode.AUTO",
  [AgentMode.Normal]: "chat.mode.DEFAULT",
  [AgentMode.AcceptEdits]: "chat.mode.ACCEPTEDITS",
  [AgentMode.PlanMode]: "chat.mode.PLAN",
  [AgentMode.Yolo]: "chat.mode.YOLO",
};

export const MODE_DESCRIPTION_KEYS: Record<string, string> = {
  [AgentMode.Auto]: "chat.mode.description.AUTO",
  [AgentMode.Normal]: "chat.mode.description.DEFAULT",
  [AgentMode.AcceptEdits]: "chat.mode.description.ACCEPTEDITS",
  [AgentMode.PlanMode]: "chat.mode.description.PLAN",
  [AgentMode.Yolo]: "chat.mode.description.YOLO",
};
