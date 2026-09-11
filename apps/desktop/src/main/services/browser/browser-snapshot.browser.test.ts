/**
 * The snapshot walker, run in a real browser.
 *
 * This is the part of the browser tools nothing else could reach. The walker
 * asks questions only layout can answer — `offsetParent`, `getBoundingClientRect`,
 * the computed `cursor` — and jsdom answers all of them with zero, which makes
 * every element invisible and every tree empty. So these fixtures load in
 * Electron, which the repo already depends on, and the assertions are about
 * what the walker actually made of a rendered page.
 *
 * Three bugs came out of writing it, all of the same kind — the walker quietly
 * saw less than the page had:
 *
 *   - Anything more than twelve elements below `<body>` was dropped. That is an
 *     ordinary app shell, not a deep page.
 *   - `visibility: hidden` came back as a clickable ref, because such an
 *     element keeps its layout box and the old check only looked at style when
 *     it had none.
 *   - Refs were numbered on the way back up, so `@e2` appeared above `@e1`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { extractScript } from "./browser-page-scripts";
import {
  PAGE_SUMMARY_JS,
  renderTree,
  SNAPSHOT_BUILD_JS,
} from "./browser-snapshot";
import {
  byName,
  flatten,
  harnessAvailability,
  runSnapshotFixtures,
  type SnapshotResult,
} from "./browser-snapshot-harness";

/** The harness window, so a fixture can put something below the fold on purpose. */
const VIEWPORT_HEIGHT = 768;

/**
 * Fixtures are loaded from a file, and a root-relative `href` resolved against
 * a `file://` URL picks up whatever the platform's root is — on Windows
 * `/products/42` becomes `/C:/products/42`, which is the drive letter leaking
 * into an assertion about paths. A base URL gives every fixture the same
 * origin everywhere, which is what the walker is being asked about.
 */
const BASE = "http://fixture.test/";

const wrap = (body: string, head = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><base href="${BASE}">${head}</head><body>${body}</body></html>`;

const nest = (depth: number, inner: string): string =>
  "<div>".repeat(depth) + inner + "</div>".repeat(depth);

const FIXTURES: Record<string, string> = {
  // ── What counts as visible ────────────────────────────────────────────────
  visibility: wrap(`
    <button id="shown">Shown</button>
    <button id="none" style="display:none">Display none</button>
    <button id="hidden" style="visibility:hidden">Visibility hidden</button>
    <button id="zero" style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero size</button>
    <div style="display:none"><button id="inside-none">Inside a hidden parent</button></div>
    <div style="position:fixed;top:0"><button id="fixed">Fixed</button></div>
  `),
  // A parent turns visibility off and a child turns it back on: the child is on
  // screen, so it must survive.
  visibilityRestored: wrap(`
    <div style="visibility:hidden">
      <button id="off">Hidden by the parent</button>
      <button id="on" style="visibility:visible">Visible again</button>
    </div>
  `),
  // ── How deep it looks ─────────────────────────────────────────────────────
  shallow: wrap(nest(5, "<button>Five deep</button>")),
  appShell: wrap(nest(20, "<button>Twenty deep</button>")),
  veryDeep: wrap(nest(50, "<button>Fifty deep</button>")),
  tooDeep: wrap(nest(70, "<button>Seventy deep</button>")),
  // ── Viewport ──────────────────────────────────────────────────────────────
  fold: wrap(`
    <button>Above the fold</button>
    <div style="height:${VIEWPORT_HEIGHT * 3}px"></div>
    <button>Below the fold</button>
  `),
  // ── What counts as interactive ────────────────────────────────────────────
  interactive: wrap(`
    <a href="/somewhere">A link</a>
    <button>A button</button>
    <input name="text-field">
    <textarea name="notes"></textarea>
    <select name="choice"><option value="a">Apple</option><option value="b">Banana</option></select>
    <div role="button">Role button</div>
    <div role="checkbox">Role checkbox</div>
    <div onclick="void 0">Has onclick</div>
    <div tabindex="0">Has tabindex</div>
    <div contenteditable="true">Editable</div>
    <div style="cursor:pointer">Pointer cursor</div>
    <p>Plain prose that nothing should offer to click</p>
  `),
  // A pointer cursor inherits, so every child of a clickable card would
  // otherwise become its own ref. Only the outermost one should.
  cursorInheritance: wrap(`
    <div id="card" style="cursor:pointer">
      <span id="inner-a">Inner A</span>
      <span id="inner-b">Inner B</span>
    </div>
  `),
  // ── What counts as content ────────────────────────────────────────────────
  content: wrap(`
    <h1>A heading</h1>
    <h3>A smaller heading</h3>
    <ul><li>A list item</li></ul>
    <table><tr><th>A header cell</th><td>A data cell</td></tr></table>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="An image with alt text" width="10" height="10">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10">
  `),
  // ── Labels ────────────────────────────────────────────────────────────────
  labels: wrap(`
    <button aria-label="Labelled by aria">Ignored text</button>
    <label for="named">Label for a field</label><input id="named" name="named">
    <input id="placeheld" placeholder="Type here">
    <label><input type="checkbox" name="terms"> I agree to the terms</label>
    <button title="A title attribute"><span></span></button>
    <button>${"Very long label ".repeat(20)}</button>
    <a href="/products/42?ref=home">A product</a>
  `),
  multiLineLabels: wrap(`
    <button>Line one<br>Line two</button>
    <select name="fruit"><option>Apple</option><option>Banana</option></select>
  `),
  // ── Field detail ──────────────────────────────────────────────────────────
  fields: wrap(`
    <input name="email" type="email" placeholder="you@example.com">
    <input name="filled" value="already here">
    <input name="long" value="${"x".repeat(80)}">
    <input name="agree" type="checkbox" checked>
    <input name="decline" type="checkbox">
    <select name="country"><option value="us">United States</option><option value="in" selected>India</option></select>
    <button disabled>Disabled button</button>
  `),
  // ── Selectors ─────────────────────────────────────────────────────────────
  selectors: wrap(`
    <button id="by-id">By id</button>
    <button data-id="by-data-id">By data-id</button>
    <button data-testid="by-testid">By testid</button>
    <input name="by-name">
    <div><span><button>No handle of its own</button></span></div>
    <div><button>Sibling one</button><button>Sibling two</button></div>
  `),
  // Two elements sharing an id: querySelector returns the first, so the second
  // must not be handed a selector that resolves to the first.
  duplicateIds: wrap(`
    <button id="dupe">First</button>
    <button id="dupe">Second</button>
  `),
  // Ids that are not valid CSS identifiers on their own.
  awkwardIds: wrap(`
    <button id="1-leading-digit">Leading digit</button>
    <button id="has spaces">Has spaces</button>
    <button id="has.dots">Has dots</button>
  `),
  // ── Shape ─────────────────────────────────────────────────────────────────
  landmarks: wrap(`
    <nav><a href="/a">Nav link</a></nav>
    <main><h1>Main heading</h1></main>
    <footer><a href="/b">Footer link</a></footer>
  `),
  // A ref'd element containing another: the only shape that tells the two
  // numbering orders apart. Post-order gives the inner button the lower ref.
  readingOrder: wrap(`
    <ul>
      <li>First row<button>Act on the first</button></li>
      <li>Second row<button>Act on the second</button></li>
    </ul>
  `),
  // ── What it cannot see ────────────────────────────────────────────────────
  shadowDom: wrap(`
    <div id="host"></div>
    <script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
        '<button>Inside a shadow root</button>';
    </script>
  `),
  empty: wrap("<div><span>Nothing to click here</span></div>"),
  // ── Size ──────────────────────────────────────────────────────────────────
  huge: wrap(
    `<ul>${Array.from(
      { length: 900 },
      (_, i) =>
        `<li><a href="/item/${i}">Item ${i}</a><button>Buy ${i}</button></li>`
    ).join("")}</ul>`
  ),
};

const availability = harnessAvailability();
// Never a silent skip: on macOS and Windows a hidden window lays out with no
// display server, so there the harness must work and a failure is a failure.
// Only a Linux host with neither DISPLAY nor xvfb-run is excused, and it says so.
const describeInBrowser = availability.usable ? describe : describe.skip;

if (!availability.usable) {
  console.warn(
    `[browser-snapshot] skipping the walker suite — ${availability.reason}`
  );
}

describeInBrowser("the snapshot walker, against real layout", () => {
  let pages: Record<string, SnapshotResult>;

  const refs = (name: string): string[] =>
    flatten(pages[name]!.tree)
      .filter((node) => node.ref != null)
      .map((node) => node.name ?? node.tag ?? "");

  beforeAll(() => {
    // One Electron start for the whole file: about a second, then milliseconds
    // per fixture.
    pages = runSnapshotFixtures(SNAPSHOT_BUILD_JS, FIXTURES);
  }, 180_000);

  describe("what it treats as visible", () => {
    it("offers a plain visible control", () => {
      expect(refs("visibility")).toContain("Shown");
    });

    it("drops display:none, and everything under it", () => {
      expect(refs("visibility")).not.toContain("Display none");
      expect(refs("visibility")).not.toContain("Inside a hidden parent");
    });

    it("drops visibility:hidden, which kept its layout box and slipped through", () => {
      // The bug: such an element has an offsetParent and a real rect, and the
      // old check only consulted the computed style when offsetParent was
      // null. Closed dropdowns and hidden menus came back as clickable refs.
      expect(refs("visibility")).not.toContain("Visibility hidden");
    });

    it("drops an element collapsed to nothing", () => {
      expect(refs("visibility")).not.toContain("Zero size");
    });

    it("keeps a fixed-position element, which legitimately has no offsetParent", () => {
      expect(refs("visibility")).toContain("Fixed");
    });

    it("keeps a child that turns visibility back on", () => {
      // visibility is inherited and can be overridden, unlike display.
      expect(refs("visibilityRestored")).toContain("Visible again");
      expect(refs("visibilityRestored")).not.toContain("Hidden by the parent");
    });
  });

  describe("how deep it looks", () => {
    it("finds a control five elements down", () => {
      expect(refs("shallow")).toContain("Five deep");
    });

    it("finds one twenty down, which is an ordinary app shell", () => {
      // The bug: the cap was twelve. root > provider > layout > main > section
      // > card > row passes that without trying, and everything beyond it was
      // dropped in silence — the snapshot came back nearly empty and the tool
      // blamed the page.
      expect(refs("appShell")).toContain("Twenty deep");
    });

    it("finds one fifty down", () => {
      expect(refs("veryDeep")).toContain("Fifty deep");
    });

    it("still stops somewhere, so a pathological page cannot run away with it", () => {
      expect(refs("tooDeep")).not.toContain("Seventy deep");
    });
  });

  describe("the viewport", () => {
    it("marks what is below the fold, and counts it separately", () => {
      const page = pages.fold!;
      const below = byName(page.tree, "Below the fold");
      const above = byName(page.tree, "Above the fold");

      expect(above?.offscreen).toBeUndefined();
      expect(below?.offscreen).toBe(true);
      expect(page.visibleCount).toBe(1);
      expect(page.offscreenCount).toBe(1);
    });
  });

  describe("what it treats as interactive", () => {
    it("offers the natively interactive tags", () => {
      const names = refs("interactive");

      expect(names).toEqual(expect.arrayContaining(["A link", "A button"]));
      const tags = flatten(pages.interactive!.tree)
        .filter((n) => n.ref)
        .map((n) => n.tag);
      expect(tags).toEqual(
        expect.arrayContaining(["a", "button", "input", "textarea", "select"])
      );
    });

    it("offers ARIA roles", () => {
      expect(refs("interactive")).toEqual(
        expect.arrayContaining(["Role button", "Role checkbox"])
      );
    });

    it("offers the custom controls a site builds out of divs", () => {
      expect(refs("interactive")).toEqual(
        expect.arrayContaining([
          "Has onclick",
          "Has tabindex",
          "Editable",
          "Pointer cursor",
        ])
      );
    });

    it("does not offer prose as something to click", () => {
      const prose = byName(
        pages.interactive!.tree,
        "Plain prose that nothing should offer to click"
      );

      expect(prose?.ref).toBeUndefined();
    });

    it("offers a clickable card once, not once per child", () => {
      // cursor:pointer inherits, so without the parent check every span inside
      // a clickable card becomes its own ref and the tree triples in size.
      const clickable = flatten(pages.cursorInheritance!.tree).filter(
        (node) => node.ref != null
      );

      expect(clickable).toHaveLength(1);
      expect(clickable[0]?.name).toContain("Inner A");
    });
  });

  describe("what it treats as readable content", () => {
    it("offers headings, list items and table cells, marked read-only", () => {
      const content = flatten(pages.content!.tree).filter(
        (node) => node.readonly === true
      );
      const names = content.map((node) => node.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "A heading",
          "A smaller heading",
          "A list item",
          "A header cell",
          "A data cell",
        ])
      );
    });

    it("keeps a heading level, rather than flattening it to its role", () => {
      expect(byName(pages.content!.tree, "A heading")?.tag).toBe("h1");
      expect(byName(pages.content!.tree, "A smaller heading")?.tag).toBe("h3");
    });

    it("offers an image that has alt text and skips one that does not", () => {
      expect(
        byName(pages.content!.tree, "An image with alt text")?.ref
      ).toBeDefined();
      expect(
        flatten(pages.content!.tree).filter((n) => n.tag === "img")
      ).toHaveLength(1);
    });
  });

  describe("naming things", () => {
    it("prefers an aria-label over the visible text", () => {
      expect(refs("labels")).toContain("Labelled by aria");
      expect(refs("labels")).not.toContain("Ignored text");
    });

    it("finds the label element pointing at a field", () => {
      expect(byName(pages.labels!.tree, "Label for a field")).toBeDefined();
    });

    it("leaves a placeholder to the placeholder field rather than doubling it as a name", () => {
      const field = flatten(pages.labels!.tree).find(
        (node) => node.placeholder === "Type here"
      );

      expect(field).toBeDefined();
      expect(field?.name).toBeUndefined();
    });

    it("reads the text wrapped around a checkbox", () => {
      expect(refs("labels")).toContain("I agree to the terms");
    });

    it("falls back to a title attribute when there is no text", () => {
      expect(refs("labels")).toContain("A title attribute");
    });

    it("truncates a very long label rather than pasting a paragraph into the tree", () => {
      const long = flatten(pages.labels!.tree).find((node) =>
        node.name?.startsWith("Very long label")
      );

      expect(long?.name?.length).toBeLessThanOrEqual(80);
    });

    it("never puts a newline in a name, which would split the node across lines", () => {
      // The tree's structure is its indentation, so half a node arriving on a
      // line of its own reads as a node at the top level.
      for (const page of Object.values(pages)) {
        for (const node of flatten(page.tree)) {
          expect(node.name ?? "").not.toContain("\n");
        }
      }
    });

    it("collapses a two-line button and a select's options onto one line", () => {
      const names = flatten(pages.multiLineLabels!.tree).map(
        (node) => node.name
      );

      expect(names).toContain("Line one Line two");
      expect(names).toContain("Apple Banana");
    });

    it("shows a link by its path, without the query", () => {
      expect(byName(pages.labels!.tree, "A product")?.href).toBe(
        "/products/42"
      );
    });
  });

  describe("field detail", () => {
    const field = (name: string): Record<string, unknown> | undefined =>
      flatten(pages.fields!.tree).find(
        (node) => node.placeholder === name || node.value === name
      ) as never;

    it("reports an input type that is not plain text", () => {
      const email = flatten(pages.fields!.tree).find(
        (node) => node.placeholder === "you@example.com"
      );

      expect(email?.type).toBe("email");
    });

    it("reports the value a field already holds", () => {
      expect(field("already here")).toBeDefined();
    });

    it("truncates a long value", () => {
      const long = flatten(pages.fields!.tree).find((node) =>
        node.value?.startsWith("xxx")
      );

      expect(long?.value?.length).toBeLessThanOrEqual(40);
      expect(long?.value?.endsWith("...")).toBe(true);
    });

    it("reports a checkbox either way round", () => {
      const boxes = flatten(pages.fields!.tree).filter(
        (node) => node.type === "checkbox"
      );

      expect(boxes.map((box) => box.checked).sort()).toEqual([false, true]);
    });

    it("reports the option a select is showing, by its text", () => {
      const select = flatten(pages.fields!.tree).find(
        (node) => node.tag === "select"
      );

      expect(select?.value).toBe("India");
    });

    it("reports a disabled control, which is why clicking it will do nothing", () => {
      expect(byName(pages.fields!.tree, "Disabled button")?.disabled).toBe(
        true
      );
    });
  });

  describe("the selectors it hands out", () => {
    const selectorFor = (page: string, name: string): string | undefined =>
      byName(pages[page]!.tree, name)?.selector;

    it("uses an id when there is one", () => {
      expect(selectorFor("selectors", "By id")).toBe("#by-id");
    });

    it("uses data-id and data-testid, which survive a re-render", () => {
      expect(selectorFor("selectors", "By data-id")).toBe(
        '[data-id="by-data-id"]'
      );
      expect(selectorFor("selectors", "By testid")).toBe(
        '[data-testid="by-testid"]'
      );
    });

    it("uses a form field name", () => {
      const input = flatten(pages.selectors!.tree).find(
        (node) => node.tag === "input"
      );

      expect(input?.selector).toBe('input[name="by-name"]');
    });

    it("builds a path for an element with no handle of its own", () => {
      const selector = selectorFor("selectors", "No handle of its own");

      expect(selector).toBeDefined();
      expect(selector).toContain("button");
    });

    it("distinguishes siblings of the same tag", () => {
      expect(selectorFor("selectors", "Sibling one")).not.toBe(
        selectorFor("selectors", "Sibling two")
      );
    });

    it("never hands out a selector that resolves to a different element", () => {
      // Two elements with the same id: querySelector returns the first, so the
      // second cannot be described by it. The walker verifies before issuing.
      const first = byName(pages.duplicateIds!.tree, "First");
      const second = byName(pages.duplicateIds!.tree, "Second");

      expect(first?.selector).toBe("#dupe");
      expect(second?.selector).not.toBe("#dupe");
      expect(second?.selector).toBeDefined();
    });

    it("escapes an id that is not a valid CSS identifier", () => {
      for (const name of ["Leading digit", "Has spaces", "Has dots"]) {
        expect(byName(pages.awkwardIds!.tree, name)?.selector).toBeDefined();
      }
    });

    it("gives every ref a selector, or no ref at all", () => {
      // The contract the ref map depends on: a ref in the tree always resolves.
      for (const page of Object.values(pages)) {
        for (const node of flatten(page.tree)) {
          if (node.ref != null) expect(node.selector, node.ref).toBeTruthy();
        }
      }
    });
  });

  describe("the shape of the tree", () => {
    it("numbers refs down the page, so @e1 is the first thing read", () => {
      // They used to be assigned on the way back up, so a row's button was
      // numbered before the row containing it and the tree read @e2 above @e1.
      const ordered = flatten(pages.readingOrder!.tree)
        .filter((node) => node.ref != null)
        .map((node) => `${node.ref}:${node.name}`);

      expect(ordered).toEqual([
        "@e1:First row",
        "@e2:Act on the first",
        "@e3:Second row",
        "@e4:Act on the second",
      ]);
    });

    it("keeps landmarks as structure, without giving them refs", () => {
      const tags = flatten(pages.landmarks!.tree).map((node) => node.tag);

      expect(tags).toEqual(expect.arrayContaining(["nav", "main", "footer"]));
      const nav = flatten(pages.landmarks!.tree).find(
        (node) => node.tag === "nav"
      );
      expect(nav?.ref).toBeUndefined();
    });

    it("collapses wrappers that add nothing", () => {
      // Twenty nested divs around one button must not become twenty nodes.
      expect(flatten(pages.appShell!.tree)).toHaveLength(1);
    });
  });

  describe("what it cannot reach, said plainly", () => {
    it("does not see into a shadow root", () => {
      // Nor could document.querySelector, which is why the empty-snapshot
      // message names shadow roots and iframes rather than only suggesting
      // browser_execute.
      expect(pages.shadowDom!.refCount).toBe(0);
    });

    it("reports a page with nothing to click as empty rather than inventing refs", () => {
      expect(pages.empty!.refCount).toBe(0);
    });
  });

  describe("a page too large to describe", () => {
    it("finds everything on it", () => {
      expect(pages.huge!.refCount).toBeGreaterThan(1_000);
    });

    it("bounds what is rendered, and says what was left out", () => {
      const rendered = renderTree(pages.huge!.tree);

      expect(rendered.text.length).toBeLessThan(21_000);
      expect(rendered.omittedRefs).toBeGreaterThan(0);
      expect(rendered.text).toContain("more elements not shown");
      expect(rendered.text).toContain("browser_execute");
    });

    it("cuts on a line boundary, so no ref is half written", () => {
      const rendered = renderTree(pages.huge!.tree);
      const lastRefLine = rendered.text
        .split("\n")
        .filter((line) => line.includes("@e"))
        .pop();

      expect(lastRefLine).toMatch(/@e\d+ \[/);
    });
  });
});

/**
 * The other scripts the tools send into the page, and the walker's stable refs.
 * Same harness, same reason: they read layout and the live DOM.
 */
describeInBrowser("the tools' page scripts, against real layout", () => {
  type Loose = Record<string, any>;
  let stable: Loose;
  let overlays: Loose;
  let extracted: Loose;
  let summary: Loose;

  beforeAll(() => {
    const twice = `(() => {
      const first = ${SNAPSHOT_BUILD_JS};
      document.body.insertAdjacentHTML('afterbegin', '<button id="late">Late</button>');
      const second = ${SNAPSHOT_BUILD_JS};
      return { first, second };
    })()`;
    stable = runSnapshotFixtures(twice, {
      page: wrap(`<button id="a">A</button><button id="b">B</button>`),
    }) as unknown as Loose;

    overlays = runSnapshotFixtures(SNAPSHOT_BUILD_JS, {
      banner: wrap(`
        <main><button id="go">Go</button></main>
        <div style="position:fixed;bottom:0;left:0;right:0;padding:12px;background:#eee">
          We use cookies to improve your experience.
          <button id="accept">Accept all</button><button id="reject">Reject</button>
        </div>
      `),
      dialog: wrap(`
        <button id="go">Go</button>
        <div role="dialog" aria-modal="true" style="position:absolute;top:10px;left:10px;width:300px;height:100px;background:#fff">
          Sign in to continue <button id="close">Close</button>
        </div>
      `),
      plain: wrap(`<button id="go">Go</button>`),
    }) as unknown as Loose;

    extracted = runSnapshotFixtures(
      extractScript("li.row, table", { price: ".p" }, 10),
      {
        list: wrap(`
          <ul>
            <li class="row"><a href="/p/1">USB-C cable</a> <span class="p">₹299</span></li>
            <li class="row">HDMI cable <span class="p">₹499</span></li>
            <li class="other">Not a row</li>
          </ul>
        `),
        table: wrap(`
          <table><tr><th>Airline</th><th>Price</th></tr><tr><td>IndiGo</td><td>₹8,240</td></tr></table>
        `),
        none: wrap(`<p>Nothing here</p>`),
      }
    ) as unknown as Loose;

    summary = runSnapshotFixtures(PAGE_SUMMARY_JS, {
      page: wrap(`
        <h1>Flights</h1><h2>Best departing</h2>
        <main>12 results found for your search.</main>
        <div role="dialog">Sign in to continue</div>
        <input id="to" placeholder="Where to?" autofocus>
      `),
    }) as unknown as Loose;
  });

  it("keeps a ref on the same element across snapshots, and gives a newcomer a new one", () => {
    const { first, second } = stable.page;
    const refOfB = (result: SnapshotResult): string | undefined =>
      byName(result.tree, "B")?.ref;

    expect(refOfB(first)).toBeDefined();
    expect(refOfB(second)).toBe(refOfB(first));

    const late = byName(second.tree, "Late")?.ref;
    const firstRefs = flatten(first.tree).map((node) => node.ref);

    expect(late).toBeDefined();
    expect(firstRefs).not.toContain(late);
  });

  it("reports a fixed cookie banner with the refs of its buttons", () => {
    const found = overlays.banner.overlays as Array<{
      kind: string;
      text: string;
      buttons: Array<{ ref: string; name: string }>;
    }>;

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("banner");
    expect(found[0]!.text).toContain("cookies");
    expect(found[0]!.buttons.map((button) => button.name)).toEqual([
      "Accept all",
      "Reject",
    ]);
    // The button refs are the walker's own, so `dismiss` can click them.
    expect(byName(overlays.banner.tree, "Accept all")?.ref).toBe(
      found[0]!.buttons[0]!.ref
    );
  });

  it("reports a modal dialog, and nothing on a plain page", () => {
    expect(overlays.dialog.overlays).toMatchObject([
      { kind: "dialog", buttons: [{ name: "Close" }] },
    ]);
    expect(overlays.plain.overlays).toEqual([]);
  });

  it("extracts list rows with their link and named fields", () => {
    expect(extracted.list).toMatchObject({
      status: "ok",
      total: 2,
      rows: [
        { text: "USB-C cable ₹299", href: `${BASE}p/1`, price: "₹299" },
        { text: "HDMI cable ₹499", price: "₹499" },
      ],
    });
  });

  it("extracts a table as rows of cells", () => {
    expect(extracted.table).toMatchObject({
      status: "ok",
      rows: [
        ["Airline", "Price"],
        ["IndiGo", "₹8,240"],
      ],
    });
  });

  it("says when the selector matched nothing", () => {
    expect(extracted.none).toEqual({ status: "not_found" });
  });

  it("summarises where the page is", () => {
    expect(summary.page).toMatchObject({
      headings: ["Flights", "Best departing"],
      dialogs: ["Sign in to continue"],
      focused: 'input "Where to?"',
    });
    expect(summary.page.text).toContain("12 results found");
  });
});
