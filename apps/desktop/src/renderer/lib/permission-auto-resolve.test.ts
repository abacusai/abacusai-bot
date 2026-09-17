import { describe, expect, it } from "vitest";

import { AgentMode } from "#shared/agent-types";

import type { PermissionRequest } from "../conversation/agent-types";
import { autoResolution, modeAfterDecision } from "./permission-auto-resolve";

const tool = { id: "t1", name: "bash", type: "tool", input: {}, args: {} };

const terminal = (extra: Partial<PermissionRequest> = {}): PermissionRequest =>
  ({
    type: "run_terminal",
    tool,
    displayName: "Run command",
    command: "ls",
    cwd: "/w",
    background: false,
    unmatchedPatterns: [],
    ...extra,
  }) as unknown as PermissionRequest;

describe("what a chosen mode answers on the user's behalf", () => {
  it("lets Full access settle an ordinary tool approval", () => {
    expect(autoResolution(terminal(), AgentMode.Yolo)).toBe("allowYolo");
  });

  it("lets Auto through once, never as the switch that drops the sandbox", () => {
    expect(autoResolution(terminal(), AgentMode.Auto)).toBe("accept");
  });

  it("lets Auto-Accept settle an edit and nothing else", () => {
    const edit = {
      type: "edit_file",
      tool,
      displayName: "Edit",
      filePath: "a",
      originalContent: "",
      newContent: "",
    } as unknown as PermissionRequest;
    expect(autoResolution(edit, AgentMode.AcceptEdits)).toBe("accept");
    expect(autoResolution(terminal(), AgentMode.AcceptEdits)).toBeNull();
    expect(autoResolution(edit, AgentMode.Normal)).toBeNull();
  });

  it("never answers a sandbox card, whatever the mode", () => {
    // Bypass skips the tool approvals, not the sandbox: these are the OS
    // refusing something dangerous, and the user answers them.
    const denied = {
      type: "sandbox_denied",
      tool,
      displayName: "Allow what the sandbox refused",
      command: "rm x",
      denials: [{ kind: "write", path: "/Users/dev/Desktop/x" }],
    } as unknown as PermissionRequest;
    const host = {
      type: "network_host",
      tool,
      displayName: "Reach a host",
      host: "example.com",
      port: 443,
    } as unknown as PermissionRequest;
    const credential = terminal({
      credentialPaths: ["/Users/dev/.ssh/id_rsa"],
    } as unknown as Partial<PermissionRequest>);

    for (const mode of [
      AgentMode.Yolo,
      AgentMode.Auto,
      AgentMode.AcceptEdits,
      AgentMode.Normal,
    ]) {
      expect(autoResolution(denied, mode)).toBeNull();
      expect(autoResolution(host, mode)).toBeNull();
      expect(autoResolution(credential, mode)).toBeNull();
    }
  });
});

describe("what a card's answer does to the mode", () => {
  const denied = {
    type: "sandbox_denied",
    tool,
    displayName: "Allow what the sandbox refused",
    command: "touch ~/Desktop/x",
    denials: [{ kind: "write", path: "/Users/dev/Desktop/x" }],
  } as unknown as PermissionRequest;
  const host = {
    type: "network_host",
    tool,
    displayName: "Reach a host",
    host: "example.com",
    port: 443,
  } as unknown as PermissionRequest;
  const credential = terminal({
    credentialPaths: ["/Users/dev/.netrc"],
  } as unknown as Partial<PermissionRequest>);

  it("moves the mode on a tool approval, as the buttons say", () => {
    expect(modeAfterDecision(terminal(), "allowAlways")).toBe(
      AgentMode.AcceptEdits
    );
    expect(modeAfterDecision(terminal(), "allowYolo")).toBe(AgentMode.Yolo);
    expect(modeAfterDecision(terminal(), "accept")).toBeNull();
  });

  it("never from a sandbox card: 'always' there keeps the grant, not the asking", () => {
    // The bug: "Always allow these this session" on a refused write flipped
    // the picker from Auto to Auto-Accept, and the session with it.
    for (const request of [denied, host, credential]) {
      expect(modeAfterDecision(request, "allowAlways")).toBeNull();
      expect(modeAfterDecision(request, "allowYolo")).toBeNull();
    }
  });
});
