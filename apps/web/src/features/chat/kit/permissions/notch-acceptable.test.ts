import { describe, expect, it, vi } from "vitest";

import type { PermissionRequest } from "@abacus-ai/contract/agent-types";

import { descriptor } from "../../fixtures/builders";
import { notchAcceptable } from "./notch-acceptable";
const request = (value: unknown) => descriptor(value as PermissionRequest);
describe("R6-T18 permission safety table", () => {
  it.each([
    [
      {
        type: "run_terminal",
        command: "rm /tmp/a",
        cwd: "/work",
        background: true,
      },
      ["rm /tmp/a", "/work", "in the background"],
    ],
    [{ type: "delete", filePath: "/work/file" }, ["/work/file"]],
    [
      { type: "read_outside_directory", resolvedPath: "/other/file" },
      ["/other/file"],
    ],
    [
      { type: "fetch_url", url: "https://example.com/a-secret-path" },
      ["https://example.com/a-secret-path"],
    ],
    [
      { type: "network_host", host: "example.com", port: 443 },
      ["example.com:443"],
    ],
    [
      {
        type: "sandbox_denied",
        command: "cat file",
        denials: [{ kind: "read", path: "/private/file" }],
        note: "Read the entire note",
      },
      ["cat file", "read: /private/file", "Read the entire note"],
    ],
    [
      {
        type: "browser_action",
        action: "navigate",
        url: "https://example.com/path",
        description: "Sign in",
      },
      ["navigate", "https://example.com/path", "Sign in"],
    ],
  ])("renders all deciding fields: %j", (r, lines) => {
    const measure = vi.fn(() => true);
    expect(notchAcceptable(request(r), measure)).toEqual({ ok: true, lines });
    expect(measure).toHaveBeenCalledWith(lines);
    expect(notchAcceptable(request(r), () => false)).toEqual({
      ok: false,
      reason: "overflow",
    });
  });
  it.each([
    "edit",
    "apply_patch",
    "write",
    "generic",
    "ask_user_question",
    "send_email",
    "send_message",
    "connector",
    "unknown",
    "create_file",
    "install_skill",
    "computer_action",
  ])("%s stays Review only", (type) => {
    expect(notchAcceptable(request({ type }), () => true)).toEqual({
      ok: false,
      reason: "review",
    });
  });
  it.each([
    { credentialPaths: ["/secret"] },
    { unmatchedPatterns: ["danger"] },
  ])("terminal warnings never accept", (extra) => {
    expect(
      notchAcceptable(
        request({ type: "run_terminal", command: "x", cwd: "/", ...extra }),
        () => true
      ).ok
    ).toBe(false);
  });
  it("more than two denials stays Review only", () => {
    expect(
      notchAcceptable(
        request({
          type: "sandbox_denied",
          command: "x",
          denials: Array(3).fill({ kind: "read", path: "x" }),
        }),
        () => true
      ).ok
    ).toBe(false);
  });
});
