/**
 * Every activation goes through the Pay guard: the browser server performs a
 * click, a check, a select or a key only inside its guarded primitives, which
 * run the guard first. A new call site that reaches the raw page script or
 * the trusted key directly would skip it, so this holds the file to that.
 */
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(import.meta.dirname, "mcp-browser-server.ts"),
  "utf8"
);

/** The raw activations, and the only methods each may appear in. */
const RAW: Record<string, readonly string[]> = {
  "clickScript(": ["guardedClick"],
  "checkScript(": ["guardedCheck"],
  "selectScript(": ["guardedSelect"],
  "this.dispatchTrustedKey(": ["guardedPress"],
  // The trusted key itself, and the page-side activations a script can do.
  "Input.dispatchKeyEvent": ["dispatchTrustedKey"],
  "Input.dispatchMouseEvent": [],
  "Input.dispatchTouchEvent": [],
  "userGesture: true": ["evalJS", "guardedClick"],
  ".click(": [],
  requestSubmit: ["guardedPress"],
  ".submit(": ["guardedPress"],
  // Writes that can set a <select>: each checks for one first and routes it to the guard.
  "fillScript(": ["interactStep", "pick"],
  "typeScript(": ["interactStep"],
};

/** Whether the offset is on a comment line. */
const inComment = (offset: number): boolean => {
  const lineStart = SOURCE.lastIndexOf("\n", offset) + 1;
  const line = SOURCE.slice(lineStart, SOURCE.indexOf("\n", offset));
  return /^\s*(?:\/\/|\*|\/\*)/.test(line);
};

/** The class method a source offset sits in. */
const methodAt = (offset: number): string | null => {
  const before = SOURCE.slice(0, offset);
  const declarations = [
    ...before.matchAll(
      /^ {2}(?:private |protected |public )?(?:static )?(?:async )?(\w+)\s*\(/gm
    ),
  ];
  return declarations.at(-1)?.[1] ?? null;
};

describe("the browser server's activations", () => {
  it("are performed only inside the guarded primitives", () => {
    const strays: string[] = [];
    for (const [call, owners] of Object.entries(RAW)) {
      for (const match of SOURCE.matchAll(
        new RegExp(call.replace(/[.(]/g, "\\$&"), "g")
      )) {
        if (inComment(match.index)) continue;
        const method = methodAt(match.index);
        if (method == null || !owners.includes(method))
          strays.push(`${call} in ${method ?? "(top level)"}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("route a write into a <select> through the guard first", () => {
    for (const [owner, writer] of [
      ["pick", "fillScript("],
      ["interactStep", "fillScript("],
      ["interactStep", "typeScript("],
    ] as const) {
      const start = SOURCE.indexOf(
        owner === "pick" ? "private async pick(" : "private async interactStep("
      );
      const body = SOURCE.slice(start, SOURCE.indexOf("\n  }\n", start));
      const write = body.indexOf(writer);
      expect(
        body.lastIndexOf("this.isSelect(", write),
        `${owner} ${writer}`
      ).toBeGreaterThan(0);
    }
  });

  it("guard first in each primitive", () => {
    for (const owner of [
      "guardedClick",
      "guardedCheck",
      "guardedSelect",
      "guardedPress",
    ]) {
      const start = SOURCE.indexOf(`private async ${owner}(`);
      expect(start, owner).toBeGreaterThan(0);
      const body = SOURCE.slice(start, SOURCE.indexOf("\n  }\n", start));
      const guard = body.indexOf("this.guardActivation(");
      const act = Math.min(
        ...[
          "clickScript(",
          "checkScript(",
          "selectScript(",
          "this.dispatchTrustedKey(",
        ]
          .map((call) => body.indexOf(call))
          .filter((index) => index >= 0)
      );
      expect(guard, owner).toBeGreaterThan(0);
      expect(guard, owner).toBeLessThan(act);
    }
  });

  it("run inside the session's one queue, which every browser call takes in executeTool", () => {
    const callers = [...SOURCE.matchAll(/this\.inSessionOrder\(/g)].map(
      (match) => methodAt(match.index)
    );
    // Taken at the entry points only (a tool call, the chat's own screenshot),
    // never by a primitive inside one, which would wait on itself.
    expect(
      callers.filter(
        (caller) => caller !== "executeTool" && caller !== "screenshotForChat"
      )
    ).toEqual([]);
    expect(callers).toContain("executeTool");
  });
});
