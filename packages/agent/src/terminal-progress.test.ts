/** What a person sees of terminal output, and how far along it says it is. */
import { describe, expect, it } from "vitest";

import { collapseProgress, lastLine, progressOf } from "./terminal-progress.js";

describe("collapseProgress", () => {
  it.each([
    ["plain lines stay as they are", "a\nb\n", "a\nb\n"],
    [
      "a redrawn line keeps its last state",
      "10%\r55%\r100%\ndone\n",
      "100%\ndone\n",
    ],
    ["Windows line ends are not redraws", "one\r\ntwo\r\n", "one\ntwo\n"],
    [
      "a line ending in a return shows what was there",
      "50%\r\nnext",
      "50%\nnext",
    ],
    ["the unfinished last line keeps its pending return", "a\r40%\r", "40%\r"],
    ["empty segments are skipped", "\r\r12%\r\r", "12%\r"],
  ])("%s", (_case, input, expected) => {
    expect(collapseProgress(input)).toBe(expected);
  });

  it("collapsing as output arrives gives the same as collapsing at the end", () => {
    const chunks = [
      "Get",
      "ting\r 1%",
      "\r 2",
      "0%\r",
      " 99%\r\n",
      "Done\r",
      "\n",
    ];
    let live = "";
    for (const chunk of chunks) live = collapseProgress(live + chunk);
    expect(live).toBe(collapseProgress(chunks.join("")));
    expect(live).toBe(" 99%\nDone\n");
  });
});

describe("progressOf", () => {
  it.each([
    ["curl --progress-bar", "######################                 45.2%", 45],
    [
      "curl's meter",
      "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n" +
        "                                 Dload  Upload   Total   Spent    Left  Speed\n" +
        "\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0" +
        "\r 45 1781M   45  801M    0     0  10.2M      0  0:02:54  0:01:18  0:01:36 11.5M",
      45,
    ],
    ["git", "Receiving objects:  45% (450/1000), 12.00 MiB | 3.00 MiB/s", 45],
    [
      "pip",
      "   ━━━━━━━━━━━━━━━━━━━━╺━━━━━━━━━━━━ 4.5/10.0 MB 2.1 MB/s eta 0:00:03",
      45,
    ],
    ["winget", "  ██████████████▒▒▒▒▒▒  801 MB / 1.74 GB", 46],
    ["an amount of a total, mixed units", "Downloaded 512 KB of 2 MB", 26],
    ["colour codes", "\u001b[32m 73%\u001b[0m", 73],
    ["the last state of a redrawn line", "10%\r20%\r30%", 30],
    ["only the last line counts", "50% done\nInstalling…", null],
    ["no progress said", "npm warn deprecated inflight@1.0.6", null],
    ["no output", "", null],
    ["a percentage over 100 is not progress", "CPU 250%", null],
    ["a count with no unit is not an amount", "3/5 tests", null],
  ])("%s", (_case, output, expected) => {
    expect(progressOf(output)).toBe(expected);
  });
});

describe("lastLine", () => {
  it("is the last non-empty line, collapsed and without colour", () => {
    expect(lastLine("first\n\u001b[1msecond\u001b[0m\r third \n\n")).toBe(
      "third"
    );
  });
});
