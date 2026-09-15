/** Which files a settled tool call adds to the artifacts ledger. */
import { describe, expect, it } from "vitest";

import { artifactPathLine } from "#shared/deliverables";

import { extractArtifacts } from "./session-artifacts.utils";

const WORKSPACE = "/tmp/routine";
const REPORT = `${WORKSPACE}/report.md`;
const GHOST = `${WORKSPACE}/user@example.com_user@example.com`;

const presentCall = (
  items: { path: string; label?: string }[],
  output: string
): unknown => ({
  type: "event",
  event: {
    type: "tool_result",
    toolCall: { name: "present_deliverable", args: { items } },
    result: { output },
  },
});

describe("present_deliverable", () => {
  it("files what the tool declared, in its order, with the call's labels", () => {
    const drafts = extractArtifacts(
      presentCall(
        [
          { path: REPORT, label: "Morning Brief — 15 Sep 2026" },
          { path: "https://example.com/app", label: "The app" },
        ],
        `${artifactPathLine(REPORT)}\n${artifactPathLine("https://example.com/app")}`
      ),
      WORKSPACE
    );

    expect(
      drafts.map((draft) => [draft.kind, draft.title, draft.location])
    ).toEqual([
      ["file", "Morning Brief — 15 Sep 2026", REPORT],
      ["link", "The app", "https://example.com/app"],
    ]);
  });

  it("does not file an item the tool turned away", () => {
    const drafts = extractArtifacts(
      presentCall(
        [
          { path: REPORT, label: "Morning Brief — 15 Sep 2026" },
          { path: GHOST, label: "placeholder" },
        ],
        `Not presented, because there is no file at these paths: ${GHOST}\n\n${artifactPathLine(REPORT)}`
      ),
      WORKSPACE
    );

    expect(drafts.map((draft) => draft.title)).toEqual([
      "Morning Brief — 15 Sep 2026",
    ]);
  });

  it("still reads a result from before the tool declared its items", () => {
    const drafts = extractArtifacts(
      presentCall([{ path: "report.md" }], "Listed in the chat."),
      WORKSPACE
    );

    expect(drafts.map((draft) => draft.location)).toEqual([REPORT]);
  });

  it("files nothing from a call the tool refused", () => {
    const drafts = extractArtifacts(
      {
        type: "event",
        event: {
          type: "tool_result",
          toolCall: {
            name: "present_deliverable",
            args: { items: [{ path: GHOST }] },
          },
          result: { error: "Nothing could be presented." },
        },
      },
      WORKSPACE
    );

    expect(drafts).toEqual([]);
  });
});
