/**
 * What the agent actually reads, and what it aims with.
 *
 * `formatTree` is the page as the model sees it and `extractRefMap` is the
 * table every later click resolves through. A mistake in either is invisible at
 * the time: the snapshot still renders, the ref still resolves, and the click
 * lands somewhere nobody asked for.
 *
 * The walker itself runs in the page and needs real layout — `offsetParent`,
 * non-zero rects, computed `cursor` — so it is not exercised here. These are
 * the two halves of it that are pure.
 */
import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  diffRefs,
  extractRefMap,
  filterSnapshot,
  formatOverlays,
  formatPageSummary,
  formatTree,
  GET_ELEMENT_CENTER_JS,
  SNAPSHOT_BUILD_JS,
} from "./browser-snapshot";
import type { SnapshotNode } from "./browser-snapshot";

const refMapOf = (tree: unknown): Map<string, string> => {
  const map = new Map<string, string>();
  extractRefMap(tree as SnapshotNode, map);

  return map;
};

describe("the ref map every click resolves through", () => {
  it("records a ref against the selector the walker verified", () => {
    const map = refMapOf({ ref: "@e1", selector: "#go", tag: "button" });

    expect(map.get("@e1")).toBe("#go");
  });

  it("collects refs from every depth", () => {
    const map = refMapOf({
      tag: "main",
      children: [
        { ref: "@e1", selector: "#a", tag: "a" },
        {
          tag: "form",
          children: [{ ref: "@e2", selector: 'input[name="q"]', tag: "input" }],
        },
      ],
    });

    expect([...map.entries()]).toEqual([
      ["@e1", "#a"],
      ["@e2", 'input[name="q"]'],
    ]);
  });

  it("holds no entry for an element the walker could not address", () => {
    // The walker emits `unreachable` instead of a ref when neither selector
    // form finds the element again — inside a shadow root, or nested past the
    // cap. A ref here would resolve to whatever the truncated selector happened
    // to match, which is how a click landed on the wrong element.
    const map = refMapOf({
      tag: "div",
      children: [
        { tag: "button", unreachable: true, name: "Buy" },
        { ref: "@e1", selector: "#real", tag: "button" },
      ],
    });

    expect(map.size).toBe(1);
    expect(map.get("@e1")).toBe("#real");
  });

  it("skips a ref that arrived without a selector rather than mapping it to undefined", () => {
    const map = refMapOf({ ref: "@e4", tag: "button" });

    expect(map.size).toBe(0);
  });

  it("survives an empty tree", () => {
    expect(refMapOf(null).size).toBe(0);
  });
});

describe("rendering the page for the model", () => {
  it("leads with the ref, so the thing to copy is first on the line", () => {
    expect(formatTree({ ref: "@e1", tag: "button", name: "Search" }, 0)).toBe(
      '@e1 [button] "Search"'
    );
  });

  it("marks read-only content, which is context rather than a target", () => {
    expect(
      formatTree({ ref: "@e2", tag: "h1", name: "Results", readonly: true }, 0)
    ).toContain("(text)");
  });

  it("marks offscreen elements, which need scrolling before they can be clicked", () => {
    expect(formatTree({ ref: "@e3", tag: "a", offscreen: true }, 0)).toContain(
      "[offscreen]"
    );
  });

  it("says outright when an element has no ref coming", () => {
    // Without this the model sees a button with no ref and keeps re-snapshotting
    // to get one.
    const line = formatTree(
      { tag: "button", name: "Buy", unreachable: true },
      0
    );

    expect(line).toContain("no ref");
    expect(line).not.toContain("@e");
  });

  it("indents children by depth", () => {
    const rendered = formatTree(
      {
        tag: "form",
        children: [{ ref: "@e1", tag: "input", placeholder: "Email" }],
      },
      0
    );

    expect(rendered).toBe('[form]\n  @e1 [input] placeholder="Email"');
  });

  it("shows a checkbox state either way round", () => {
    expect(
      formatTree(
        { ref: "@e1", tag: "input", type: "checkbox", checked: true },
        0
      )
    ).toContain("[checked]");
    expect(
      formatTree(
        { ref: "@e1", tag: "input", type: "checkbox", checked: false },
        0
      )
    ).toContain("[unchecked]");
  });

  it("shows the value an input already holds, which is what a form check reads", () => {
    expect(
      formatTree({ ref: "@e1", tag: "input", value: "Delhi" }, 0)
    ).toContain('value="Delhi"');
  });

  it("shows where a link goes", () => {
    expect(
      formatTree({ ref: "@e1", tag: "a", name: "Next", href: "/page/2" }, 0)
    ).toContain("/page/2");
  });

  it("shows an unchecked radio as well as an unchecked box", () => {
    expect(
      formatTree({ ref: "@e1", tag: "input", type: "radio", checked: false }, 0)
    ).toContain("[unchecked]");
  });

  it("does not label a plain input unchecked just because it has no value", () => {
    expect(
      formatTree({ ref: "@e1", tag: "input", type: "email", checked: false }, 0)
    ).not.toContain("[unchecked]");
  });

  it("shows disabled, which is the reason a click will do nothing", () => {
    expect(
      formatTree({ ref: "@e1", tag: "button", disabled: true }, 0)
    ).toContain("[disabled]");
  });

  it("renders an empty tree as an empty string rather than throwing", () => {
    expect(formatTree(null, 0)).toBe("");
  });
});

describe("escapes inside the page script", () => {
  // The walker is a JavaScript program written inside a TypeScript template
  // literal, and a template literal eats escapes it does not recognise: a lone
  // \s reaches the page as the letter s. It has bitten twice — once turning a
  // character class into an unterminated one, once turning /\s+/g into /s+/g,
  // which silently replaced every "s" in every label with a space. Neither
  // failed loudly; the second produced "A li t item".
  //
  // So: inside the template, a backslash must either be doubled (which is how
  // one reaches the page) or be an escape the template itself defines.
  const TEMPLATE_ESCAPES = new Set([
    "\\",
    "`",
    "$",
    "n",
    "t",
    "r",
    "b",
    "f",
    "v",
    "0",
    "u",
    "x",
    "'",
    '"',
    "\n",
  ]);

  const templateBody = (source: string, name: string): string => {
    const start = source.indexOf("`", source.indexOf(`${name} = `));
    let index = start + 1;

    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === "`") return source.slice(start + 1, index);
      index += 1;
    }

    throw new Error(`could not find the end of ${name}`);
  };

  it("leaves no escape for the template literal to swallow", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "browser-snapshot.ts"),
      "utf8"
    );
    const body = templateBody(source, "SNAPSHOT_BUILD_JS");
    const swallowed: string[] = [];

    for (let index = 0; index < body.length; index += 1) {
      if (body[index] !== "\\") continue;
      const next = body[index + 1] ?? "";
      // A doubled backslash is the correct way to put one into the page.
      if (next === "\\") {
        index += 1;
        continue;
      }
      if (!TEMPLATE_ESCAPES.has(next))
        swallowed.push(body.slice(Math.max(0, index - 40), index + 20));
    }

    expect(
      swallowed,
      `these backslashes will not survive the template literal:\n${swallowed.join("\n")}`
    ).toEqual([]);
  });

  it("keeps the whitespace regex a whitespace regex", () => {
    // The specific casualty, pinned: /\s+/g became /s+/g.
    expect(SNAPSHOT_BUILD_JS).toContain("replace(/\\s+/g");
    expect(SNAPSHOT_BUILD_JS).not.toContain("replace(/s+/g");
  });
});

describe("the scripts sent into the page", () => {
  it("encodes the selector as a JSON string, so quotes cannot end the script", () => {
    const script = GET_ELEMENT_CENTER_JS(`a[title="he said \\"hi\\""]`);

    expect(script).toContain(JSON.stringify(`a[title="he said \\"hi\\""]`));
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it("parses as JavaScript, so a snapshot cannot fail on a syntax error", () => {
    // The walker is one long template literal edited by hand; a stray brace in
    // it takes out every snapshot at once.
    expect(() => new Function(`return ${SNAPSHOT_BUILD_JS}`)).not.toThrow();
  });

  it("returns null rather than a selector it could not verify", () => {
    // The contract walk() depends on: a falsy return means "no ref for this
    // element". Asserted on the source because the function needs real layout
    // to run.
    expect(SNAPSHOT_BUILD_JS).toContain("return null;");
    expect(SNAPSHOT_BUILD_JS).toContain("node.unreachable = true");
  });
});

describe("cutting a snapshot down to what was asked for", () => {
  const tree: SnapshotNode = {
    tag: "main",
    children: [
      { ref: "@e1", tag: "h1", name: "Flights", readonly: true },
      { ref: "@e2", tag: "input", name: "From", placeholder: "Where from?" },
      { ref: "@e3", tag: "button", name: "Search flights" },
      { ref: "@e4", tag: "li", name: "Delhi", readonly: true },
      {
        tag: "div",
        children: [
          { ref: "@e5", tag: "a", name: "Delhi deals", href: "/deals" },
        ],
      },
    ],
  };

  it("lists only the elements whose label matches, flat, with their refs", () => {
    const { text, count } = filterSnapshot(tree, { find: "delhi" });

    expect(count).toBe(2);
    expect(text).toContain('@e4 [li] (text) "Delhi"');
    expect(text).toContain('@e5 [a] "Delhi deals"');
    expect(text).not.toContain("@e2");
  });

  it("matches placeholders too, since that is what a model reads off a form", () => {
    expect(filterSnapshot(tree, { find: "where from" }).count).toBe(1);
  });

  it("drops plain text when only clickable things are wanted", () => {
    const { text } = filterSnapshot(tree, { interactiveOnly: true });

    expect(text).toContain("@e2");
    expect(text).toContain("@e3");
    expect(text).toContain("@e5");
    expect(text).not.toContain("@e1");
    expect(text).not.toContain("@e4");
  });

  it("says how many more there were past the cap", () => {
    const { text } = filterSnapshot(tree, {}, 2);

    expect(text).toContain("3 more matches not shown");
  });
});

describe("what changed between two snapshots", () => {
  it("reports the refs that appeared and how many went away", () => {
    const before = new Map([
      ["@e1", "#a"],
      ["@e2", "#b"],
    ]);
    const after: SnapshotNode = {
      tag: "main",
      children: [
        { ref: "@e2", tag: "button", name: "Still here" },
        { ref: "@e7", tag: "li", name: "New York" },
        { ref: "@e8", tag: "li", name: "Newark" },
      ],
    };

    const { added, removed } = diffRefs(before, after);

    expect(added.map((node) => node.ref)).toEqual(["@e7", "@e8"]);
    expect(removed).toBe(1);
  });

  it("is empty when nothing moved", () => {
    const before = new Map([["@e1", "#a"]]);
    const after: SnapshotNode = {
      tag: "main",
      children: [{ ref: "@e1", tag: "button" }],
    };

    expect(diffRefs(before, after)).toEqual({ added: [], removed: 0 });
  });
});

describe("describing what sits on top of the page", () => {
  it("names each overlay with the refs of its buttons", () => {
    const text = formatOverlays([
      {
        kind: "banner",
        text: "We use cookies",
        buttons: [
          { ref: "@e3", name: "Accept all" },
          { ref: "@e4", name: "Reject" },
        ],
      },
    ]);

    expect(text).toContain("(banner)");
    expect(text).toContain('@e3 "Accept all"');
    expect(text).toContain("Dismiss it");
  });

  it("says nothing when there is nothing on top", () => {
    expect(formatOverlays([])).toBe("");
    expect(formatOverlays(undefined)).toBe("");
  });
});

describe("describing where the page is", () => {
  it("leads with the title and URL, then what a reader would want to know", () => {
    const text = formatPageSummary({
      title: "Results",
      url: "https://a.test/r",
      headings: ["Flights", "Best departing"],
      focused: 'input "Where to?"',
      dialogs: ["Sign in to continue"],
      text: "12 results found",
      scrolled: 800,
      pageHeight: 3000,
      viewportHeight: 768,
    });

    expect(text.split("\n")[0]).toBe("Page: Results");
    expect(text).toContain("Dialog on top: Sign in to continue");
    expect(text).toContain("Headings: Flights · Best departing");
    expect(text).toContain('Focused: input "Where to?"');
    expect(text).toContain("Scroll: screen 2 of 4");
    expect(text).toContain("12 results found");
  });
});
