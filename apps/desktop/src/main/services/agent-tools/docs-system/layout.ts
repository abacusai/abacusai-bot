/**
 * Text drawn over text or a chart, text running out of its box, and text on a
 * slide outside the layout's slots: measured after layout, in the window, and
 * a hard failure for the print (live F2: the bot's deck printed a paragraph
 * across the cards and the chart on four slides, and nothing caught it).
 *
 * Self-contained: serialised with Function.prototype.toString.
 */
export function layoutProblems(doc: Document): string[] {
  const out: string[] = [];
  const say = (s: string): void => {
    if (!out.includes(s)) out.push(s);
  };
  const short = (t: string): string => {
    const s = t.replace(/\s+/g, " ").trim();
    return s.length > 48 ? `${s.slice(0, 45)}…` : s;
  };
  // What may sit directly on a slide; anything else with text is loose.
  const SLOTS =
    ".kicker, h1, h2, .lead, .body, .meta, .foot, .notes, .panel, .side, .title, figure, style, script";
  const BOXES = ".card, .tile, .col, .panel, .callout";
  const boxName = (el: Element): string =>
    el.matches(".card")
      ? "card"
      : el.matches(".tile")
        ? "tile"
        : el.matches(".col")
          ? "column"
          : el.matches(".panel")
            ? "panel"
            : "callout";

  const slides = Array.from(doc.querySelectorAll("section.slide"));
  const frames: Element[] = slides.length > 0 ? slides : [doc.body];
  frames.forEach((frame, index) => {
    const where = slides.length > 0 ? `Slide ${index + 1}` : "The page";

    if (slides.length > 0)
      for (const child of Array.from(frame.children)) {
        if (child.matches(SLOTS)) continue;
        const text = (child.textContent || "").trim();
        if (text && child.getClientRects().length > 0)
          say(
            `${where}: "${short(text)}" sits outside the layout; put it in the slide's .body, or in <aside class="notes"> if it is for the speaker.`
          );
      }

    type Item = { el: Element; name: string; chart: boolean };
    const entries: Array<{ item: Item; r: DOMRect }> = [];
    for (const el of Array.from(frame.querySelectorAll("*"))) {
      if (el.closest(".notes")) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === "svg" || tag === "img") {
        if (el.parentElement?.closest("svg")) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0)
          entries.push({
            item: {
              el,
              name: tag === "svg" ? "a chart" : "an image",
              chart: true,
            },
            r,
          });
        continue;
      }
      if (el.closest("svg")) continue;
      const texts = Array.from(el.childNodes).filter(
        (n) => n.nodeType === 3 && (n.textContent || "").trim() !== ""
      );
      if (texts.length === 0) continue;
      const item = {
        el,
        name: `"${short(el.textContent || "")}"`,
        chart: false,
      };
      for (const node of texts) {
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects()))
          if (r.width > 0.5 && r.height > 0.5) entries.push({ item, r });
      }
    }

    // Text running out of the box it belongs to.
    for (const { item, r } of entries) {
      if (item.chart) continue;
      const box = item.el.closest(BOXES);
      if (!box || !frame.contains(box)) continue;
      const b = box.getBoundingClientRect();
      if (
        r.bottom > b.bottom + 4 ||
        r.right > b.right + 4 ||
        r.left < b.left - 4 ||
        r.top < b.top - 4
      )
        say(`${where}: ${item.name} runs out of its ${boxName(box)}.`);
    }

    // Two things drawn in the same place: overlapping by more than a sliver.
    entries.sort((a, b) => a.r.top - b.r.top);
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]!;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j]!;
        if (b.r.top >= a.r.bottom) break;
        if (a.item.el === b.item.el) continue;
        if (a.item.chart && b.item.chart) continue;
        if (a.item.el.contains(b.item.el) || b.item.el.contains(a.item.el))
          continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        const lower = Math.min(
          a.item.chart ? Infinity : a.r.height,
          b.item.chart ? Infinity : b.r.height
        );
        if (w <= 3 || h <= Math.max(3, lower * 0.35)) continue;
        // Name the later one in the page as the one drawn over the other.
        const [over, under] =
          a.item.el.compareDocumentPosition(b.item.el) &
          Node.DOCUMENT_POSITION_FOLLOWING
            ? [b.item, a.item]
            : [a.item, b.item];
        const top = over.chart ? under : over;
        const bottom = over.chart ? over : under;
        say(`${where}: ${top.name} is drawn over ${bottom.name}.`);
      }
    }
  });
  return out;
}

/**
 * The same number in two of a slide's big-number slots (tiles, columns, the
 * hero panel, figures): sent back (round 5: 64% in a tile and again beside
 * it). Self-contained: serialised with Function.prototype.toString.
 */
export function repeatedNumbers(doc: Document): string[] {
  const out: string[] = [];
  Array.from(doc.querySelectorAll("section.slide")).forEach((slide, i) => {
    const seen = new Map<string, string>();
    for (const v of Array.from(
      slide.querySelectorAll(
        ".tile .value, .col .value, .panel .value, .figures .value, .hero-figure .value"
      )
    )) {
      if (v.closest(".notes")) continue;
      const shown = (v.textContent || "").trim();
      const key = shown.replace(/\s+/g, "");
      if (!/\d/.test(key)) continue;
      const msg = `Slide ${i + 1} shows ${seen.get(key) ?? shown} twice.`;
      if (seen.has(key)) {
        if (!out.includes(msg)) out.push(msg);
      } else seen.set(key, shown);
    }
  });
  return out;
}

/**
 * Words run together across an inline element ("Presented by<b>Group 4</b>"
 * printed "Presented byGroup 4", round 5): a space goes in where a lowercase
 * letter meets a capital, or a letter meets a digit. Sub- and superscripts,
 * punctuation and a word split by markup ("<b>un</b>likely") are left alone.
 * Self-contained: serialised with Function.prototype.toString.
 */
export function spaceGluedWords(doc: Document): number {
  const glued = (a: string, b: string): boolean =>
    (/\p{Ll}$/u.test(a) && /^[\p{Lu}\p{N}]/u.test(b)) ||
    (/\p{N}$/u.test(a) && /^\p{L}/u.test(b)) ||
    (/\p{L}$/u.test(a) && /^\p{N}/u.test(b));
  const win = doc.defaultView!;
  let fixed = 0;
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (el.closest("svg, sub, sup, .notes, style, script")) continue;
    if (win.getComputedStyle(el).display !== "inline") continue;
    const text = el.textContent || "";
    if (!text.trim()) continue;
    const before = el.previousSibling;
    const inlineBefore =
      before?.nodeType === 1 &&
      win.getComputedStyle(before as Element).display === "inline";
    if (
      (before?.nodeType === 3 || inlineBefore) &&
      glued(before!.textContent || "", text)
    ) {
      el.before(doc.createTextNode(" "));
      fixed++;
    }
    const after = el.nextSibling;
    if (after?.nodeType === 3 && glued(text, after.textContent || "")) {
      el.after(doc.createTextNode(" "));
      fixed++;
    }
  }
  return fixed;
}

/**
 * Comparison columns ("—", "n/a — not supplied" or blank): one empty in every
 * row is noise (round 5) and goes, header, footnote marks and the footnote they
 * leave pointing at nothing included; one empty in most rows but holding a
 * figure or two is sent back, since dropping it lost real Q2 figures (showcase
 * u05). Not the first column, a priced table (data-currency) or merged cells.
 * Self-contained: serialised with Function.prototype.toString.
 */
export function tableColumns(doc: Document): {
  dropped: string[];
  sparse: string[];
} {
  const dropped: string[] = [];
  const sparse: string[] = [];
  const empty = (t: string): boolean =>
    /^(|[-–—]+|n\/?a\b.*|not (supplied|given|recorded|available|known)\b.*)$/i.test(
      t.replace(/\s+/g, " ").trim()
    );
  // A cell's own text, without its footnote marks ("—<sup>1</sup>" is a dash).
  const own = (cell: Element | undefined): string => {
    if (!cell) return "";
    const copy = cell.cloneNode(true) as Element;
    for (const s of Array.from(copy.querySelectorAll("sup"))) s.remove();
    return copy.textContent ?? "";
  };
  const text = (c: Element): string =>
    (c.textContent ?? "").replace(/\s+/g, " ").trim();
  const marks = new Set<string>();
  for (const table of Array.from(doc.querySelectorAll("table.data"))) {
    if (table.hasAttribute("data-currency")) continue;
    const rows = Array.from(table.querySelectorAll("tr"));
    if (
      rows.some((r) =>
        Array.from(r.cells).some((c) => c.colSpan > 1 || c.rowSpan > 1)
      )
    )
      continue;
    const head = rows[0]?.cells[0]?.tagName === "TH" ? rows[0] : null;
    const body = rows.filter((r) => r !== head);
    if (body.length < 3) continue;
    const blanksIn = (col: number): number =>
      body.filter((r) => empty(own(r.cells[col]))).length;
    const width = (): number => Math.max(...rows.map((r) => r.cells.length));
    const gone: string[] = [];
    for (let col = width() - 1; col >= 1; col--) {
      if (blanksIn(col) < body.length) continue;
      gone.unshift(
        (head?.cells[col]?.textContent ?? `column ${col + 1}`).trim()
      );
      for (const r of rows) {
        for (const s of Array.from(r.cells[col]?.querySelectorAll("sup") ?? []))
          marks.add((s.textContent ?? "").trim());
        r.cells[col]?.remove();
      }
    }
    dropped.push(...gone);
    const few: string[] = [];
    for (let col = 1; col < width(); col++) {
      const blanks = blanksIn(col);
      if (blanks * 2 <= body.length) continue;
      const name = head?.cells[col]
        ? text(head.cells[col])
        : `column ${col + 1}`;
      few.push(`${name} (${blanks} of ${body.length})`);
    }
    if (few.length === 0) continue;
    const label = head
      ? Array.from(head.cells).map(text).join(" / ")
      : text(body[0]!.cells[0]!);
    sparse.push(
      `The table "${label.length > 60 ? `${label.slice(0, 57)}…` : label}" has columns empty in most rows: ${few.join(", ")}. Keep a column only where most rows have a value; give the few comparisons in a small table of their own or in the text.`
    );
  }
  // A footnote ("<sup>1</sup> Q2 not provided") whose mark no longer appears.
  for (const mark of marks) {
    if (!mark) continue;
    const still = Array.from(doc.querySelectorAll("sup")).filter(
      (s) => (s.textContent ?? "").trim() === mark
    );
    const notes = still.filter((s) => {
      const p = s.parentElement;
      return (
        p?.matches("p, li, div.note, small") &&
        p.firstChild === s &&
        !p.closest("table")
      );
    });
    if (notes.length === still.length)
      for (const s of notes) s.parentElement?.remove();
  }
  return { dropped, sparse };
}

/**
 * Images that did not load: a broken icon in print, while the bot says the
 * picture is in (showcase O3). Self-contained, like the rest of this file.
 */
export function brokenImages(doc: Document): string[] {
  const out: string[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    if (img.closest(".notes")) continue;
    if (img.complete && img.naturalWidth > 0) continue;
    const src = img.getAttribute("src") ?? "";
    const name =
      (img.getAttribute("alt") ?? "").trim() ||
      src.split(/[\\/]/).pop() ||
      "an image";
    const short = name.length > 48 ? `${name.slice(0, 45)}…` : name;
    const s = `The image "${short}" (${src.startsWith("data:") ? "inline data" : src}) did not load.`;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * An agenda's numbers as text (<span class="n">01</span>), not CSS counters,
 * so the .pptx carries them (overnight sample deck). Self-contained.
 */
export function numberAgenda(doc: Document): number {
  let added = 0;
  for (const ol of Array.from(
    doc.querySelectorAll("section.slide.agenda ol")
  )) {
    Array.from(ol.children).forEach((li, i) => {
      if (li.tagName !== "LI" || li.querySelector(":scope > .n")) return;
      const n = doc.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1).padStart(2, "0");
      li.insertBefore(n, li.firstChild);
      added++;
    });
  }
  return added;
}

/**
 * The stylesheet owns type, colour and spacing: the model's own inline sizes,
 * colours, paddings and margins go (final round, Bengali notice: inline 11 to
 * 22 pt type and "background:none" turned the poster into a near-empty page).
 * Page breaks, widths and anything else it set stay. Self-contained.
 */
export function ownStylesOnly(doc: Document): number {
  const owned =
    /^(font(-size|-weight|-family|-style)?|line-height|letter-spacing|color|background(-color|-image)?|padding(-\w+)?|margin(-\w+)?|border(-\w+)*|border-radius|max-width|text-transform|opacity)$/;
  let removed = 0;
  for (const el of Array.from(
    doc.body.querySelectorAll<HTMLElement>("[style]")
  )) {
    if (el.closest("svg")) continue;
    for (const prop of Array.from(el.style)) {
      if (!owned.test(prop)) continue;
      el.style.removeProperty(prop);
      removed++;
    }
    if (el.style.length === 0) el.removeAttribute("style");
  }
  return removed;
}

/**
 * A CV written in one column gets its side column: education, skills,
 * certificates and the like move beside the experience (final round: a
 * one-column CV left the right third of the page empty). Self-contained.
 */
export function cvAside(doc: Document): number {
  const side =
    /education|skill|certif|licen|qualif|language|award|training|interest|tool|membership|course|achievement|reference/i;
  let moved = 0;
  for (const body of Array.from(
    doc.querySelectorAll<HTMLElement>(".cv-body")
  )) {
    if (body.querySelector(":scope > aside")) continue;
    const main =
      body.querySelector<HTMLElement>(":scope > main") ??
      (body.children.length > 0 ? body : null);
    if (main == null) continue;
    const aside = doc.createElement("aside");
    for (const h2 of Array.from(
      main.querySelectorAll<HTMLElement>(":scope > h2")
    )) {
      if (!side.test(h2.textContent || "")) continue;
      const part: Element[] = [h2];
      for (
        let n = h2.nextElementSibling;
        n != null && n.tagName !== "H2";
        n = n.nextElementSibling
      )
        part.push(n);
      for (const el of part) aside.append(el);
      moved++;
    }
    if (moved > 0) body.append(aside);
  }
  return moved;
}
