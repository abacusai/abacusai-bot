import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  BootLocalDeviceResult,
  BuildAndRunLocalDeviceResult,
  CaptureDeviceScreenshotResult,
  CreateLocalDeviceResult,
  DeviceBuildPhase,
  DeviceProjectInfo,
  DeviceStatus,
  DeviceStreamChunk,
  GetSimulatorWindowSourceResult,
  InstallMaestroResult,
  InteractLocalDeviceResult,
  LocalDeviceInfo,
  StartDeviceStreamResult,
} from "../contracts";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

const Platform = v.picklist(["ios", "android"]);

export const CaptureDeviceScreenshotRequestSchema = v.object({
  platform: Platform,
  deviceId: v.optional(v.string()),
});

export const BootLocalDeviceRequestSchema = v.object({
  platform: Platform,
  deviceId: v.optional(v.string()),
  focus: v.optional(v.boolean()),
});

export const CreateLocalDeviceRequestSchema = v.object({ platform: Platform });

export const InteractLocalDeviceRequestSchema = v.object({
  platform: Platform,
  deviceId: v.optional(v.string()),
  action: v.picklist([
    "tap",
    "long_press",
    "swipe",
    "scroll",
    "type",
    "press_key",
  ]),
  x: v.optional(v.number()),
  y: v.optional(v.number()),
  text: v.optional(v.string()),
  key: v.optional(v.string()),
  direction: v.optional(v.picklist(["up", "down", "left", "right"])),
  amount: v.optional(v.number()),
});

export const BuildAndRunLocalDeviceRequestSchema = v.object({
  platform: Platform,
  deviceId: v.optional(v.string()),
});

export const StartDeviceStreamRequestSchema = v.object({
  deviceId: v.pipe(v.string(), v.nonEmpty()),
  platform: v.optional(Platform),
});

export const StreamDeviceTouchRequestSchema = v.object({
  platform: Platform,
  deviceId: v.pipe(v.string(), v.nonEmpty()),
  phase: v.picklist(["down", "move", "up", "tap"]),
  x: v.number(),
  y: v.number(),
  deviceWidth: v.optional(v.number()),
  deviceHeight: v.optional(v.number()),
});

export const StreamDeviceKeyRequestSchema = v.object({
  platform: Platform,
  deviceId: v.pipe(v.string(), v.nonEmpty()),
  code: v.string(),
  key: v.string(),
  shift: v.optional(v.boolean()),
  ctrl: v.optional(v.boolean()),
  alt: v.optional(v.boolean()),
  meta: v.optional(v.boolean()),
});

export const GetSimulatorWindowSourceRequestSchema = v.object({
  deviceName: v.optional(v.string()),
});

export type DevicesEvent =
  /** First yield on (re)open: where a build stands and the toolchain status. */
  | {
      type: "snapshot";
      status: DeviceStatus;
      buildPhase: DeviceBuildPhase | null;
    }
  | { type: "status"; status: DeviceStatus }
  | { type: "build-state"; phase: DeviceBuildPhase; error?: string };

export const devices = {
  status: query.input(NoInput).output(type<DeviceStatus>()),
  list: query.input(NoInput).output(type<LocalDeviceInfo[]>()),
  screenshot: mutation
    .input(CaptureDeviceScreenshotRequestSchema)
    .output(type<CaptureDeviceScreenshotResult>()),
  boot: mutation
    .input(BootLocalDeviceRequestSchema)
    .output(type<BootLocalDeviceResult>()),
  create: mutation
    .input(CreateLocalDeviceRequestSchema)
    .output(type<CreateLocalDeviceResult>()),
  refresh: mutation.input(NoInput).output(type<DeviceStatus>()),
  setEnabled: mutation
    .input(v.object({ enabled: v.boolean() }))
    .output(type<DeviceStatus>()),
  setApproval: mutation
    .input(v.object({ approval: v.picklist(["ask", "always"]) }))
    .output(type<DeviceStatus>()),
  projectInfo: query.input(NoInput).output(type<DeviceProjectInfo>()),
  interact: mutation
    .input(InteractLocalDeviceRequestSchema)
    .output(type<InteractLocalDeviceResult>()),
  /** Progress arrives on `events` as `build-state`. */
  buildAndRun: mutation
    .input(BuildAndRunLocalDeviceRequestSchema)
    .output(type<BuildAndRunLocalDeviceResult>()),
  stream: {
    /** Window-scoped: the chunks belong to the caller's window. */
    start: mutation
      .input(StartDeviceStreamRequestSchema)
      .output(type<StartDeviceStreamResult>()),
    /** A stale `streamId` is ignored. */
    stop: mutation
      .input(v.optional(v.object({ streamId: v.optional(v.number()) })))
      .output(type<void>()),
    /** Fire-and-forget. */
    touch: mutation.input(StreamDeviceTouchRequestSchema).output(type<void>()),
    /** Fire-and-forget. */
    key: mutation.input(StreamDeviceKeyRequestSchema).output(type<void>()),
    chunks: subscription
      .input(v.object({ streamId: v.number() }))
      .output(eventIterator(type<DeviceStreamChunk>())),
  },
  simulatorWindowSource: query
    .input(GetSimulatorWindowSourceRequestSchema)
    .output(type<GetSimulatorWindowSourceResult>()),
  installMaestro: mutation.input(NoInput).output(type<InstallMaestroResult>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<DevicesEvent>())),
};
