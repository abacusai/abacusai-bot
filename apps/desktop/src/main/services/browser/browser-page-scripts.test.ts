/**
 * The page-side checks, actually run.
 *
 * These are the lines that decide whether an interaction happened: whether the
 * `<select>` took the value, whether the click landed on a disabled control,
 * whether the element handed to `fill` has a value to set. Scripting the
 * server's *reply* proves none of it — delete the check inside the script and
 * such a test still passes, which is exactly what a mutation run showed. So
 * each script is compiled and executed here against a stand-in element.
 *
 * The stand-ins model the parts of the DOM these scripts actually lean on, and
 * the parts that bite: a `<select>` whose `selectedIndex` goes to -1 when an
 * unmatched value is assigned, and native value setters that refuse an element
 * of the wrong type the way the real ones do.
 */
import { describe, expect, it } from "vitest";

import {
  checkScript,
  clickScript,
  fillScript,
  selectScript,
  typeScript,
} from "./browser-page-scripts";

/** Stands in for the value setters the scripts pull off the prototypes. */
class FakeNode {
  tagName: string;
  /**
   * Declared on the prototype rather than as a field, so FakeSelect can
   * override it with the accessor a real <select> has: a field would land as
   * an own data property and shadow the accessor entirely.
   */
  get value(): string {
    return this.valueStore;
  }
  set value(next: string) {
    this.valueStore = next;
  }
  protected valueStore = "";
  textContent = "";
  isContentEditable = false;
  disabled: unknown = undefined;
  readOnly = false;
  checked = false;
  innerText = "";
  clicks = 0;
  events: string[] = [];
  focused = 0;
  scrolled = 0;
  attributes: Record<string, string> = {};
  /** A control whose framework snaps the value back on input. */
  rejectsValue = false;

  constructor(tagName: string, init: Partial<FakeNode> = {}) {
    this.tagName = tagName;
    Object.assign(this, init);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  focus(): void {
    this.focused += 1;
  }
  scrollIntoView(): void {
    this.scrolled += 1;
  }
  click(): void {
    this.clicks += 1;
    if (!this.disabled) this.checked = !this.checked;
  }
  getBoundingClientRect(): Record<string, number> {
    return { left: 0, top: 0, width: 10, height: 10 };
  }
  dispatchEvent(event: { type: string }): void {
    this.events.push(event.type);
    if (this.rejectsValue && event.type === "input") this.value = "";
  }
}

class FakeOption {
  constructor(
    public value: string,
    public text: string
  ) {}
}

/** A `<select>`: assigning an unmatched value clears the selection, as in a browser. */
class FakeSelect extends FakeNode {
  options: FakeOption[];
  selectedIndex = 0;

  constructor(options: Array<[string, string]>) {
    super("SELECT");
    this.options = options.map(([value, text]) => new FakeOption(value, text));
  }

  get value(): string {
    return this.selectedIndex >= 0
      ? this.options[this.selectedIndex]!.value
      : "";
  }
  set value(next: string) {
    this.selectedIndex = this.options.findIndex(
      (option) => option.value === next
    );
  }
}

/**
 * Compile a script and run it with a document that resolves one selector.
 *
 * The globals handed in are the ones the scripts reach for. `HTMLInputElement`
 * and friends carry a real `value` setter that throws on the wrong receiver,
 * which is the "Illegal invocation" the scripts have to avoid.
 */
const run = (
  source: string,
  element: FakeNode | null,
  activeElement: FakeNode | null = null
): unknown => {
  const nativeSetter = (accepts: (node: unknown) => boolean) => ({
    set(this: unknown, next: string) {
      if (!accepts(this)) throw new TypeError("Illegal invocation");
      (this as FakeNode).value = next;
    },
  });

  class HTMLInputElement {}
  class HTMLTextAreaElement {}
  class HTMLSelectElement {}

  Object.defineProperty(
    HTMLInputElement.prototype,
    "value",
    nativeSetter((node) => node instanceof FakeNode && node.tagName === "INPUT")
  );
  Object.defineProperty(
    HTMLTextAreaElement.prototype,
    "value",
    nativeSetter(
      (node) => node instanceof FakeNode && node.tagName === "TEXTAREA"
    )
  );
  Object.defineProperty(
    HTMLSelectElement.prototype,
    "value",
    nativeSetter((node) => node instanceof FakeSelect)
  );

  // The scripts branch on `el instanceof HTMLTextAreaElement` and friends, so
  // the stand-ins have to answer those the way the real elements would.
  const tagged = (Ctor: unknown, tag: string): void => {
    Object.defineProperty(Ctor, Symbol.hasInstance, {
      value: (node: unknown) =>
        node instanceof FakeNode && node.tagName === tag,
    });
  };
  tagged(HTMLInputElement, "INPUT");
  tagged(HTMLTextAreaElement, "TEXTAREA");
  tagged(HTMLSelectElement, "SELECT");

  const document = {
    querySelector: () => element,
    activeElement,
    body: new FakeNode("BODY"),
    documentElement: new FakeNode("HTML"),
  };

  class FakeEvent {
    constructor(public type: string) {}
  }

  return new Function(
    "document",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Event",
    "InputEvent",
    `return ${source}`
  )(
    document,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    FakeEvent,
    FakeEvent
  );
};

describe("clicking", () => {
  it("clicks a live element and reports where it was", () => {
    const button = new FakeNode("BUTTON", { innerText: "Go" });
    const result = run(clickScript("#go"), button) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "ok",
      tag: "button",
      text: "Go",
      x: 5,
      y: 5,
    });
    expect(button.clicks).toBe(1);
    expect(button.scrolled).toBe(1);
  });

  it("reports an element that is not there", () => {
    expect(run(clickScript("#gone"), null)).toMatchObject({
      status: "not_found",
    });
  });

  it("refuses to click a disabled control, which would swallow it silently", () => {
    const button = new FakeNode("BUTTON", { disabled: true });
    const result = run(clickScript("#go"), button) as Record<string, unknown>;

    expect(result).toMatchObject({ status: "disabled", tag: "button" });
    expect(button.clicks).toBe(0);
  });

  it("honours aria-disabled, which is how a custom control says the same thing", () => {
    const div = new FakeNode("DIV", {
      attributes: { "aria-disabled": "true" },
    });

    expect(run(clickScript("#go"), div)).toMatchObject({ status: "disabled" });
    expect(div.clicks).toBe(0);
  });

  it('clicks a control that is merely aria-disabled="false"', () => {
    const div = new FakeNode("DIV", {
      attributes: { "aria-disabled": "false" },
    });

    expect(run(clickScript("#go"), div)).toMatchObject({ status: "ok" });
  });
});

describe("filling", () => {
  it("sets an input through its own native setter and fires input and change", () => {
    const input = new FakeNode("INPUT");
    const result = run(fillScript("#q", "Delhi"), input);

    expect(result).toMatchObject({ status: "ok" });
    expect(input.value).toBe("Delhi");
    expect(input.events).toEqual(["input", "change"]);
    expect(input.focused).toBe(1);
  });

  it("sets a textarea through the textarea setter, not the input one", () => {
    const area = new FakeNode("TEXTAREA");

    expect(run(fillScript("#body", "hello"), area)).toMatchObject({
      status: "ok",
    });
    expect(area.value).toBe("hello");
  });

  it("writes into a contenteditable, which has no value at all", () => {
    // A rich-text editor is a div. The old script reached for the input value
    // setter and threw "Illegal invocation" from inside the page.
    const editor = new FakeNode("DIV", { isContentEditable: true });

    expect(run(fillScript("#editor", "hi"), editor)).toMatchObject({
      status: "ok",
    });
    expect(editor.textContent).toBe("hi");
    expect(editor.events).toEqual(["input"]);
  });

  it("refuses an element with nothing to fill, rather than throwing", () => {
    const section = new FakeNode("SECTION");

    expect(run(fillScript("#x", "hi"), section)).toMatchObject({
      status: "not_fillable",
      tag: "section",
    });
  });

  it("refuses a disabled or read-only field instead of reporting a fill", () => {
    expect(
      run(fillScript("#x", "hi"), new FakeNode("INPUT", { disabled: true }))
    ).toMatchObject({
      status: "not_editable",
    });
    expect(
      run(fillScript("#x", "hi"), new FakeNode("INPUT", { readOnly: true }))
    ).toMatchObject({
      status: "not_editable",
    });
  });

  it("notices a framework that snapped the value back", () => {
    const controlled = new FakeNode("INPUT", { rejectsValue: true });

    expect(run(fillScript("#x", "hi"), controlled)).toMatchObject({
      status: "rejected",
    });
  });

  it("reports an element that is not there", () => {
    expect(run(fillScript("#gone", "hi"), null)).toMatchObject({
      status: "not_found",
    });
  });
});

describe("typing", () => {
  it("appends rather than replacing", () => {
    const input = new FakeNode("INPUT", { value: "Del" });

    expect(
      run(typeScript('document.querySelector("#q")', "hi"), input)
    ).toMatchObject({
      status: "ok",
    });
    expect(input.value).toBe("Delhi");
  });

  it("appends into a contenteditable", () => {
    const editor = new FakeNode("DIV", {
      isContentEditable: true,
      textContent: "Del",
    });

    expect(
      run(typeScript('document.querySelector("#e")', "hi"), editor)
    ).toMatchObject({
      status: "ok",
    });
    expect(editor.textContent).toBe("Delhi");
  });

  it("refuses the body, which is what document.activeElement is on a fresh page", () => {
    // The old script called the input value setter on <body> and threw
    // "Illegal invocation" — an error that said nothing about the real problem.
    const source = typeScript("document.activeElement", "hi");
    const document = { body: null };

    expect(run(source, null, null)).toMatchObject({ status: "not_found" });
    expect(document).toBeTruthy();
  });

  it("refuses an element with no value to append to", () => {
    expect(
      run(
        typeScript('document.querySelector("#x")', "hi"),
        new FakeNode("SECTION")
      )
    ).toMatchObject({ status: "not_fillable", tag: "section" });
  });

  it("refuses a read-only field", () => {
    expect(
      run(
        typeScript('document.querySelector("#x")', "hi"),
        new FakeNode("INPUT", { readOnly: true })
      )
    ).toMatchObject({ status: "not_editable" });
  });

  it("notices a framework that snapped the value back", () => {
    expect(
      run(
        typeScript('document.querySelector("#x")', "hi"),
        new FakeNode("INPUT", { rejectsValue: true })
      )
    ).toMatchObject({ status: "rejected" });
  });

  it("focuses an element that was not already focused", () => {
    const input = new FakeNode("INPUT");
    run(typeScript('document.querySelector("#q")', "x"), input);

    expect(input.focused).toBe(1);
  });

  it("leaves an already-focused element alone", () => {
    const input = new FakeNode("INPUT");
    run(typeScript('document.querySelector("#q")', "x"), input, input);

    expect(input.focused).toBe(0);
  });
});

describe("selecting", () => {
  const countries = (): FakeSelect =>
    new FakeSelect([
      ["us", "United States"],
      ["in", "India"],
    ]);

  it("selects by value and reports what took", () => {
    const select = countries();
    const result = run(selectScript("#country", "in"), select) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ status: "ok", selected: "in" });
    expect(select.selectedIndex).toBe(1);
    expect(select.events).toEqual(["input", "change"]);
  });

  it("accepts the visible label, which is what a snapshot shows the model", () => {
    const select = countries();

    expect(run(selectScript("#country", "India"), select)).toMatchObject({
      status: "ok",
      selected: "in",
    });
  });

  it("refuses a value no option has, and says what was available", () => {
    // The bug: assigning an unmatched value to a <select> clears the selection
    // and reports nothing, so "Selected zz" was a plain falsehood.
    const select = countries();
    const result = run(selectScript("#country", "zz"), select) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ status: "no_match", options: ["us", "in"] });
    expect(select.selectedIndex).toBe(-1);
    expect(select.events).toEqual([]);
  });

  it("refuses an element that is not a select at all", () => {
    expect(run(selectScript("#x", "in"), new FakeNode("INPUT"))).toMatchObject({
      status: "not_found",
    });
    expect(run(selectScript("#x", "in"), null)).toMatchObject({
      status: "not_found",
    });
  });

  it("lists at most twenty options, so a country list is not the whole reply", () => {
    const many = new FakeSelect(
      Array.from(
        { length: 50 },
        (_, i) => [`v${i}`, `Option ${i}`] as [string, string]
      )
    );
    const result = run(selectScript("#x", "nope"), many) as {
      options: string[];
    };

    expect(result.options).toHaveLength(20);
  });
});

describe("checking", () => {
  it("checks a box that was clear", () => {
    const box = new FakeNode("INPUT", { checked: false });

    expect(run(checkScript("#agree", true), box)).toBe("ok");
    expect(box.clicks).toBe(1);
  });

  it("leaves a box that is already right alone", () => {
    const box = new FakeNode("INPUT", { checked: true });

    expect(run(checkScript("#agree", true), box)).toBe("ok");
    expect(box.clicks).toBe(0);
  });

  it("unchecks", () => {
    const box = new FakeNode("INPUT", { checked: true });

    expect(run(checkScript("#agree", false), box)).toBe("ok");
    expect(box.checked).toBe(false);
  });

  it("reports a click a custom widget swallowed, rather than a success", () => {
    const inert = new FakeNode("INPUT", { checked: false, disabled: true });

    expect(run(checkScript("#agree", true), inert)).toBe("unchanged");
  });

  it("reports an element that is not there", () => {
    expect(run(checkScript("#gone", true), null)).toBe("not_found");
  });
});

describe("what goes into the page as source", () => {
  it("encodes every interpolated value as a JSON literal", () => {
    // A selector or a value carrying a quote must not be able to close the
    // string and become code.
    const nasty = `"); fetch("https://evil.test"); ("`;

    for (const source of [
      clickScript(nasty),
      fillScript(nasty, nasty),
      typeScript("document.activeElement", nasty),
      selectScript(nasty, nasty),
      checkScript(nasty, true),
    ]) {
      expect(() => new Function(`return ${source}`)).not.toThrow();
      expect(source).not.toContain('); fetch("https://evil.test"); (');
    }
  });
});
