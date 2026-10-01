import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

export interface NotchLayout {
  displayId: number;
  mode: "notch" | "plain" | "capsule";
  notch: { width: number; height: number } | null;
  growth: "down" | "up";
  maxShape: { width: number; height: number };
}
export type NotchEvent =
  | { type: "layout"; layout: NotchLayout }
  | { type: "app"; mainVisible: boolean; mainFocused: boolean }
  | { type: "reaction"; sessionId: string; reaction: "wink" }
  | { type: "shortcut" }
  | { type: "preview" }
  | { type: "visibility-request"; epoch: number };
const id = v.pipe(v.string(), v.nonEmpty());
export const OpenTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("bot"), botId: id, sessionId: v.optional(id) }),
  v.object({ kind: v.literal("session"), sessionId: id }),
  v.object({ kind: v.literal("routine-run"), routineId: id, sessionId: id }),
]);
export type OpenTarget = v.InferOutput<typeof OpenTargetSchema>;
export interface OpenCommand {
  id: string;
  target: OpenTarget;
  at: number;
}
export interface NotchStatus {
  available: boolean;
  reason?:
    | "platform"
    | "generation"
    | "disabled"
    | "failed"
    | "metrics-unavailable";
  displays: number;
  shortcut: "registered" | "unavailable" | "off";
}
export const ShapeSchema = v.object({
  phase: v.picklist(["envelope", "final"]),
  width: v.pipe(v.number(), v.finite(), v.minValue(0)),
  height: v.pipe(v.number(), v.finite(), v.minValue(0)),
  visible: v.boolean(),
  audio: v.boolean(),
});
export type NotchShape = v.InferOutput<typeof ShapeSchema>;
export const notch = {
  layout: query.input(NoInput).output(type<NotchLayout>()),
  events: subscription.input(NoInput).output(eventIterator(type<NotchEvent>())),
  setShape: mutation.input(ShapeSchema).output(type<NotchLayout>()),
  visibility: mutation
    .input(
      v.object({
        documentVisible: v.boolean(),
        epoch: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      })
    )
    .output(type<void>()),
  setInteractive: mutation
    .input(v.object({ interactive: v.boolean() }))
    .output(type<void>()),
  focus: mutation.input(v.object({ focus: v.boolean() })).output(type<void>()),
  haptic: mutation
    .input(v.object({ pattern: v.literal("alignment"), key: id }))
    .output(type<void>()),
  openInApp: mutation.input(OpenTargetSchema).output(type<{ id: string }>()),
  presented: mutation
    .input(v.object({ dedupeKey: id, documentVisible: v.boolean() }))
    .output(type<void>()),
  status: query.input(NoInput).output(type<NotchStatus>()),
  preview: mutation.input(NoInput).output(type<void>()),
  retry: mutation.input(NoInput).output(type<NotchStatus>()),
  openCommands: subscription
    .input(NoInput)
    .output(eventIterator(type<OpenCommand>())),
  ackOpen: mutation.input(v.object({ id })).output(type<void>()),
};
