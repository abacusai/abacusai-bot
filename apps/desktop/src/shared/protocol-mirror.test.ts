/**
 * The two copies of the wire protocol, checked against each other.
 *
 * `packages/agent/src/protocol.ts` and this directory's `agent-types.ts` are
 * the same contract written twice — the agent package builds on its own and
 * cannot import from the app's source tree, so the duplication is deliberate.
 * Both files say "change both together", and nothing enforced it: the agent
 * started emitting `subtask_start` / `subtask_end` and the app's copy never
 * learned about them, which the renderer only survived by casting the event to
 * `Record<string, unknown>` on the way past.
 *
 * A type-level check is not available across a package boundary this package
 * cannot import, so this compares the sets of `type:` discriminants as text.
 * Crude, and it catches the whole class: a message one side can send and the
 * other has never heard of.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const AGENT_COPY = path.join(ROOT, "packages", "agent", "src", "protocol.ts");
const APP_COPY = path.join(
  ROOT,
  "apps",
  "desktop",
  "src",
  "shared",
  "agent-types.ts"
);

/** Every `type: 'name'` discriminant declared in a protocol file. */
function discriminants(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const found = new Set<string>();

  for (const match of source.matchAll(/type:\s*['"]([a-z_]+)['"]/g)) {
    if (match[1] != null) found.add(match[1]);
  }

  return [...found].sort();
}

describe("the wire protocol", () => {
  it("declares the same messages on both sides", () => {
    expect(discriminants(APP_COPY)).toEqual(discriminants(AGENT_COPY));
  });

  it("still has the events the sub-agent brackets depend on", () => {
    // Named rather than left to the set comparison: these were the drift, and
    // a regression that dropped them from both copies at once would otherwise
    // pass.
    expect(discriminants(AGENT_COPY)).toEqual(
      expect.arrayContaining(["subtask_start", "subtask_end"])
    );
    expect(discriminants(APP_COPY)).toEqual(
      expect.arrayContaining(["subtask_start", "subtask_end"])
    );
  });

  it("still has the host service pair, which is one message answering another", () => {
    for (const copy of [AGENT_COPY, APP_COPY]) {
      expect(discriminants(copy)).toEqual(
        expect.arrayContaining([
          "host_service_request",
          "host_service_response",
        ])
      );
    }
  });

  it("still declares the outside-the-workspace approvals both front ends render", () => {
    for (const copy of [AGENT_COPY, APP_COPY]) {
      expect(discriminants(copy)).toEqual(
        expect.arrayContaining([
          "read_outside_directory",
          "write_outside_directory",
          "edit_outside_directory",
          "notebook_edit_outside_directory",
        ])
      );
    }
  });
});
