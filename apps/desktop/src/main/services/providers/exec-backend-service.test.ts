/**
 * The docker backend runs commands in a Linux container with the workspace
 * bind-mounted at its host path — which only works when that path is a POSIX
 * one. On Windows it must be reported unsupported, not probed for a binary
 * that would make it look ready.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  backendStatuses,
  clearBackendProbeCache,
  resolveBackend,
} from "./exec-backend-service";

describe("the docker backend on a Windows host", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    clearBackendProbeCache();
  });

  it("is reported unsupported, whatever binaries are installed", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    clearBackendProbeCache();

    const docker = backendStatuses().find((status) => status.id === "docker");

    expect(docker).toEqual({
      id: "docker",
      ready: false,
      blocker: { kind: "unsupported-platform" },
    });
  });

  it("leaves the local backend ready", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    clearBackendProbeCache();

    const local = backendStatuses().find((status) => status.id === "local");

    expect(local?.ready).toBe(true);
  });

  it("falls a stored docker choice back to local", () => {
    // A setting written on another machine, or before this rule existed, must
    // not leave every command failing.
    Object.defineProperty(process, "platform", { value: "win32" });
    clearBackendProbeCache();

    expect(resolveBackend("docker")).toBe("local");
  });
});
