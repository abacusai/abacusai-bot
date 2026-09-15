/** The tool's declaration, not the model's request, decides what was handed over. */
import { describe, expect, it } from "vitest";

import {
  artifactPathLine,
  declaredArtifactTargets,
  presentedDeliverables,
} from "./deliverables";

const REPORT = "/w/routines/job-1/report.md";

describe("presentedDeliverables", () => {
  it("is the declared items, in the tool's order, with the call's labels", () => {
    const items = presentedDeliverables(
      {
        items: [
          { path: REPORT, label: "Morning Brief — 15 Sep 2026" },
          { path: "http://localhost:5173", label: "The app" },
        ],
      },
      `Listed.\n${artifactPathLine(REPORT)}\n${artifactPathLine("http://localhost:5173")}`
    );

    expect(items).toEqual([
      { path: REPORT, label: "Morning Brief — 15 Sep 2026", isUrl: false },
      { path: "http://localhost:5173", label: "The app", isUrl: true },
    ]);
  });

  it("leaves out an item the tool did not declare", () => {
    const items = presentedDeliverables(
      {
        items: [
          { path: REPORT, label: "Morning Brief" },
          { path: "/w/a@b.com_c@d.com", label: "placeholder" },
        ],
      },
      `${artifactPathLine(REPORT)}\n\nNot presented, because there is no file at these paths: /w/a@b.com_c@d.com`
    );

    expect(items.map((item) => item.label)).toEqual(["Morning Brief"]);
  });

  it("labels a relative request by the absolute path the tool resolved it to", () => {
    const items = presentedDeliverables(
      { items: [{ path: "./report.md", label: "Brief" }] },
      artifactPathLine(REPORT)
    );

    expect(items).toEqual([{ path: REPORT, label: "Brief", isUrl: false }]);
  });

  it("falls back to the request when the result declares nothing", () => {
    // Results written before the tool declared its items.
    const items = presentedDeliverables(
      { items: [{ path: "/w/a.pdf" }, { path: "bad", label: "" }] },
      "Listed in the chat as a files card."
    );

    expect(items).toEqual([
      { path: "/w/a.pdf", isUrl: false },
      { path: "bad", isUrl: false },
    ]);
  });

  it("reads the model's items defensively", () => {
    expect(
      presentedDeliverables({ items: [null, 3, { path: "" }] }, "")
    ).toEqual([]);
    expect(presentedDeliverables({}, undefined)).toEqual([]);
  });
});

describe("declaredArtifactTargets", () => {
  it("reads every marker line and nothing else", () => {
    expect(
      declaredArtifactTargets(
        `Saved to /x/a.png\n${artifactPathLine("/x/a.png")}\n  ${artifactPathLine("/x/b.png")}  \n[artifact]\nprose about [artifact] markers`
      )
    ).toEqual(["/x/a.png", "/x/b.png"]);
  });
});
