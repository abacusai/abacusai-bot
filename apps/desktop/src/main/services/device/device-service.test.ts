/**
 * The parts of device control that need no device.
 *
 * device-service.ts is mostly adb and Xcode orchestration, which a test cannot
 * reach without hardware. But the decisions inside it are pure, and they are
 * the ones that fail confusingly: a JDK chosen for Gradle that Gradle refuses,
 * and a UI snapshot the model taps against by index.
 */
import { describe, expect, it } from "vitest";

import {
  filterLogLines,
  pickGradleJdk,
  renderAndroidSnapshot,
  upsertIniLine,
} from "./device-service";

const jdk = (version: number) => ({ home: `/opt/jdk-${version}`, version });

describe("choosing a JDK for Gradle", () => {
  it("prefers the newest in the range AGP and Gradle both accept", () => {
    expect(pickGradleJdk([jdk(11), jdk(17), jdk(21)])?.version).toBe(21);
    expect(pickGradleJdk([jdk(21), jdk(17)])?.version).toBe(21);
  });

  it("ignores a newer JDK that Gradle refuses when a supported one exists", () => {
    // Newest-wins is exactly the bug this function exists to prevent.
    expect(pickGradleJdk([jdk(26), jdk(21)])?.version).toBe(21);
  });

  it("picks the runnable JDK over a newer one Gradle rejects", () => {
    // The ordinary Homebrew state: plain `openjdk` is whatever shipped last
    // week, `openjdk@22` is a common pin. 22 runs, 26 does not — taking the
    // newest regardless produced "Unsupported class file major version" with a
    // working JDK sitting right there.
    expect(pickGradleJdk([jdk(22), jdk(26)])?.version).toBe(22);
    expect(pickGradleJdk([jdk(22), jdk(24), jdk(26)])?.version).toBe(22);
  });

  it("falls back to the newest when nothing is usable at all", () => {
    // Both fail, so there is no right answer — but it must still return one
    // rather than leaving the caller with nothing to report.
    expect(pickGradleJdk([jdk(11), jdk(26)])?.version).toBe(26);
    expect(pickGradleJdk([jdk(24), jdk(26)])?.version).toBe(26);
  });

  it("returns undefined when no JDK was found", () => {
    expect(pickGradleJdk([])).toBeUndefined();
  });
});

describe("rewriting an AVD config.ini", () => {
  it("replaces the key in place", () => {
    expect(
      upsertIniLine("a=1\nhw.keyboard=no\nb=2\n", "hw.keyboard", "yes")
    ).toBe("a=1\nhw.keyboard=yes\nb=2\n");
  });

  it("keeps CRLF endings instead of mixing them", () => {
    // The emulator writes config.ini with CRLF on Windows; a bare "\n" split
    // left a stray \r on every line and mixed endings after the rewrite.
    expect(
      upsertIniLine("a=1\r\nhw.keyboard=no\r\n", "hw.keyboard", "yes")
    ).toBe("a=1\r\nhw.keyboard=yes\r\n");
  });

  it("appends a missing key without a stray blank line", () => {
    expect(upsertIniLine("a=1\r\n", "hw.keyboard", "yes")).toBe(
      "a=1\r\nhw.keyboard=yes\r\n"
    );
    expect(upsertIniLine("a=1", "hw.keyboard", "yes")).toBe(
      "a=1\nhw.keyboard=yes\n"
    );
  });
});

const NODE = (attrs: Record<string, string>, children = ""): string =>
  `<node ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>${children}</node>`;

describe("rendering an Android screen for the model", () => {
  it("numbers tappable elements and gives each one a centre point", () => {
    // The model taps by index, so the numbering and the points have to line up
    // exactly — an off-by-one here taps the wrong control.
    const xml = `<hierarchy>${NODE({
      class: "android.widget.Button",
      text: "Reverse",
      clickable: "true",
      bounds: "[0,0][100,50]",
    })}${NODE({
      class: "android.widget.Button",
      text: "Clear",
      clickable: "true",
      bounds: "[0,60][100,110]",
    })}</hierarchy>`;

    const { lines, points } = renderAndroidSnapshot(xml);

    expect(points).toEqual([
      { x: 50, y: 25 },
      { x: 50, y: 85 },
    ]);
    expect(lines[0]).toContain("@e1");
    expect(lines[0]).toContain('"Reverse"');
    expect(lines[1]).toContain("@e2");
    expect(lines[1]).toContain('"Clear"');
  });

  it("shortens the class name to its last segment", () => {
    const xml = `<hierarchy>${NODE({ class: "android.widget.EditText", text: "x", clickable: "true", bounds: "[0,0][10,10]" })}</hierarchy>`;

    expect(renderAndroidSnapshot(xml).lines[0]).toContain("EditText");
    expect(renderAndroidSnapshot(xml).lines[0]).not.toContain("android.widget");
  });

  it("lists non-tappable text without giving it a tap index", () => {
    const xml = `<hierarchy>${NODE({ class: "android.widget.TextView", text: "Result", clickable: "false" })}</hierarchy>`;
    const { lines, points } = renderAndroidSnapshot(xml);

    expect(points).toHaveLength(0);
    expect(lines[0]).toContain("(text)");
    expect(lines[0]).toContain('"Result"');
  });

  it("falls back to the content description when there is no text", () => {
    const xml = `<hierarchy>${NODE({ class: "android.widget.ImageButton", text: "", "content-desc": "Navigate up", clickable: "true", bounds: "[0,0][40,40]" })}</hierarchy>`;

    expect(renderAndroidSnapshot(xml).lines[0]).toContain('"Navigate up"');
  });

  it("labels a clickable row with the text underneath it", () => {
    // A tappable container is usually empty itself; without borrowing its
    // children's text the model gets a row it can only identify by position.
    const xml = `<hierarchy>${NODE(
      {
        class: "android.widget.LinearLayout",
        text: "",
        clickable: "true",
        bounds: "[0,0][200,80]",
      },
      NODE({
        class: "android.widget.TextView",
        text: "Settings",
        clickable: "false",
      })
    )}</hierarchy>`;

    expect(renderAndroidSnapshot(xml).lines[0]).toContain("Settings");
  });

  it("keeps only the last segment of a resource id", () => {
    const xml = `<hierarchy>${NODE({ class: "android.widget.Button", text: "Go", clickable: "true", bounds: "[0,0][10,10]", "resource-id": "com.example.app:id/go_button" })}</hierarchy>`;

    const line = renderAndroidSnapshot(xml).lines[0];

    expect(line).toContain("id=go_button");
    expect(line).not.toContain("com.example.app");
  });

  it("returns nothing for input it cannot parse, rather than throwing", () => {
    // The hierarchy comes off a device over adb and can arrive truncated.
    for (const xml of [
      "",
      "not xml",
      "<hierarchy>",
      "<hierarchy></hierarchy>",
    ]) {
      expect(() => renderAndroidSnapshot(xml), xml).not.toThrow();
      expect(renderAndroidSnapshot(xml).points, xml).toEqual([]);
    }
  });
});

// The vitest budget matches the deadline handed to filterLogLines below: a
// loaded CI runner can spend seconds just starting the worker thread.
describe("filtering device logs", { timeout: 30_000 }, () => {
  const lines = ["alpha ERROR one", "beta warn two", "gamma ERROR three"];

  // The budget is generous because it covers starting the worker, not just the
  // match. Three lines and a literal pattern take no time at all; a cold or
  // loaded machine can spend most of a second getting the thread up, and on the
  // default budget this asserted how fast the runner was rather than what the
  // filter returned. The deadline itself is exercised below, where it is set
  // small on purpose.
  it("matches a pattern case-insensitively, per line", async () => {
    expect(await filterLogLines(lines, "error", 30_000)).toEqual([
      "alpha ERROR one",
      "gamma ERROR three",
    ]);
    expect(await filterLogLines(lines, "^beta", 30_000)).toEqual([
      "beta warn two",
    ]);
  });

  it("reports a pattern that is not a valid regex", async () => {
    await expect(filterLogLines(lines, "ERROR (")).rejects.toThrow(
      /Invalid filter regex/
    );
  });

  it.each([
    ["ambiguous alternation", "(.|.)*z"],
    ["a chain of quantifiers", `${"a*".repeat(20)}b`],
  ])("gives up on %s instead of running forever", async (_name, pattern) => {
    // Both take exponential time on ordinary input, so this is what an
    // unremarkable log line does to them.
    const haystack = Array.from({ length: 50 }, () => "a".repeat(40));
    let ticked = false;
    const tick = setTimeout(() => {
      ticked = true;
    }, 10);

    await expect(filterLogLines(haystack, pattern, 300)).rejects.toThrow(
      /did not finish/
    );

    clearTimeout(tick);
    // The match ran somewhere the main thread could keep working.
    expect(ticked).toBe(true);
  });

  it("returns the matches for a pattern that finishes in time", async () => {
    expect(await filterLogLines(lines, "warn", 5000)).toEqual([
      "beta warn two",
    ]);
  });
});
