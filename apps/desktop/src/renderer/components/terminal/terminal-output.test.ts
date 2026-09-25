/**
 * What the transcript makes of a finished bash call.
 *
 * Two things happen to command output on its way to the screen, and both had
 * teeth. The result parser decided whether the output was shown at all, and
 * threw it away for any command that printed JSON. The ANSI translation writes
 * its result into the page as raw HTML, so it is also the place where a
 * command's output could stop being data and start being markup.
 */
import { describe, expect, it } from "vitest";

import {
  ansiToHtml,
  formatDurationMs,
  parseBashResult,
  tailLines,
} from "./terminal-output";

describe("reading a bash result", () => {
  it("shows the output of a command that printed JSON", () => {
    // The regression. `cat package.json` parses as JSON, has no `output` field,
    // and used to render as "(no output)" over a perfectly good result.
    const raw = '{"name":"abacusai-bot","version":"1.2.0"}';

    expect(parseBashResult(raw).output).toBe(raw);
  });

  it("shows the output of a command that printed a JSON array", () => {
    // `gh api /repos/.../issues`, `jq` over a list: an array is an object to
    // `typeof`, which is how it fell into the same hole.
    const raw = '[{"number":1},{"number":2}]';

    expect(parseBashResult(raw).output).toBe(raw);
  });

  it.each([
    ["a bare number", "42"],
    ["a quoted string", '"done"'],
    ["a boolean", "true"],
    ["null", "null"],
  ])("shows the output of a command that printed %s", (_label, raw) => {
    expect(parseBashResult(raw).output).toBe(raw);
  });

  it("shows plain text unchanged", () => {
    const raw =
      "Error: Cannot find module '/src/agent.js'\n  code: MODULE_NOT_FOUND";

    expect(parseBashResult(raw)).toEqual({
      output: raw,
      exitCode: null,
      durationMs: null,
    });
  });

  it("reads a real envelope", () => {
    const raw = JSON.stringify({
      output: "hello\n",
      exitCode: 0,
      duration: 1234,
    });

    expect(parseBashResult(raw)).toEqual({
      output: "hello\n",
      exitCode: 0,
      durationMs: 1234,
    });
  });

  it("reads an envelope that only carries an exit code", () => {
    // A command that failed silently: no output, but the code still matters.
    expect(parseBashResult(JSON.stringify({ exitCode: 1 }))).toEqual({
      output: "",
      exitCode: 1,
      durationMs: null,
    });
  });

  it("keeps a non-zero exit code from an envelope", () => {
    expect(
      parseBashResult(JSON.stringify({ output: "boom", exitCode: 127 }))
        .exitCode
    ).toBe(127);
  });

  it("does not mistake JSON output for an envelope just because it has an exit code field", () => {
    // A command printing its own report with a string `exitCode` is data, not
    // an envelope; the fields have to have the right types too.
    const raw = '{"exitCode":"zero","output":42}';

    expect(parseBashResult(raw).output).toBe(raw);
  });

  it("treats an empty result as empty", () => {
    expect(parseBashResult("")).toEqual({
      output: "",
      exitCode: null,
      durationMs: null,
    });
  });

  it("survives truncated JSON", () => {
    const raw = '{"output":"half a resu';

    expect(parseBashResult(raw).output).toBe(raw);
  });
});

describe("turning terminal output into markup", () => {
  it("escapes markup in command output", () => {
    // The output goes through dangerouslySetInnerHTML, so anything a command
    // prints has to arrive as text.
    const html = ansiToHtml("<script>alert(1)</script>");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes ampersands so entities are not invented", () => {
    expect(ansiToHtml("a && b")).toContain("a &amp;&amp; b");
  });

  it("colours a standard ANSI sequence", () => {
    const html = ansiToHtml("\x1b[31merror\x1b[0m");

    expect(html).toContain("color:#ff5555");
    expect(html).toContain("error");
  });

  it("closes every span it opens", () => {
    const html = ansiToHtml("\x1b[31mred \x1b[1mbold");
    const opened = html.match(/<span/g)?.length ?? 0;
    const closed = html.match(/<\/span>/g)?.length ?? 0;

    expect(opened).toBe(closed);
  });

  it("cannot be talked into an attribute by a malformed colour code", () => {
    // Every colour is built from parsed numbers, so there is no path from
    // command output into the style attribute.
    const html = ansiToHtml("\x1b[38;2;255;0;0mred\x1b[0m");

    expect(html).toContain("color:rgb(255,0,0)");
    expect(html).not.toMatch(/style="[^"]*"[^>]*on\w+=/);
  });

  it("drops cursor movement instead of printing it", () => {
    expect(ansiToHtml("\x1b[2Kdone")).toBe("done");
  });

  it("strips carriage returns that would blank the line", () => {
    expect(ansiToHtml("progress\rdone")).toBe("progressdone");
  });

  it("leaves ordinary text alone", () => {
    expect(ansiToHtml("plain output")).toBe("plain output");
  });
});

describe("reporting how long a command took", () => {
  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [59_999, "60.0s"],
    [60_000, "1m 0s"],
    [605_000, "10m 5s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });
});

/**
 * Which end of a long command's output the card keeps.
 *
 * Everything worth reading is at the bottom: the failing assertion, the stack
 * trace, and the `Command exited with code N` pi appends last. The card used to
 * keep the FIRST lines, so expanding a noisy build showed its opening banner
 * and hid the reason it failed.
 */
describe("trimming a long command output", () => {
  const build = (count: number): string =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps the end, where the error is", () => {
    const { shown, hidden } = tailLines(build(1_000), 300);

    expect(shown.split("\n")).toHaveLength(300);
    expect(shown.endsWith("line 1000")).toBe(true);
    expect(hidden).toBe(700);
  });

  it("keeps the exit status a failing command signs off with", () => {
    const output = `${build(500)}\n\nCommand exited with code 1`;

    expect(tailLines(output, 300).shown).toContain(
      "Command exited with code 1"
    );
  });

  it("does not drop the last line of a stack trace", () => {
    const output = `${build(400)}\n  at Module._load (node:internal/modules/cjs/loader:1215:15)`;

    expect(tailLines(output, 300).shown).toContain("at Module._load");
  });

  it("leaves a short output entirely alone", () => {
    const output = build(10);

    expect(tailLines(output, 300)).toEqual({ shown: output, hidden: 0 });
  });

  it("hides nothing at exactly the cap", () => {
    expect(tailLines(build(300), 300).hidden).toBe(0);
  });

  it("hides one line at one over the cap", () => {
    const { shown, hidden } = tailLines(build(301), 300);

    expect(hidden).toBe(1);
    expect(shown.startsWith("line 2")).toBe(true);
  });

  it("handles an empty output", () => {
    expect(tailLines("", 300)).toEqual({ shown: "", hidden: 0 });
  });
});
