/**
 * Fitting pages, done in code because no model did it reliably (round 1: blank
 * and footer-only pages, a letter's sign-off alone on page 2, a flyer whose
 * contact line ran off the page, from DeepSeek and from Opus alike).
 *
 * Two halves:
 * - In the window, before printing: a floor on text size, posters and slides
 *   shrunk until nothing overflows (`fitInWindow`, serialised into the page).
 * - After printing: the printed pages read back and judged (`judgePages`);
 *   the caller shrinks the type scale (`--fit`) and prints again.
 */

export type PageIssue =
  | { kind: "blank"; page: number }
  | { kind: "spill"; page: number; chars: number }
  | { kind: "over-one-page"; pages: number }
  | { kind: "underfilled"; page: number; used: number }
  | { kind: "chart-alone"; page: number };

/** A page's own text, without the printed page number ("2/3", "Page 2 of 3"). */
export const pageBody = (text: string): string =>
  text
    .replace(/(^|\s)(page\s+)?\d+\s*(\/|of)\s*\d+(\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What is wrong with the printed pages: a page with nothing on it; a last page
 * holding only a few lines (a spill: a sign-off, a total row, one closing
 * bullet); more than one page when one was asked for.
 */
export const judgePages = (
  pages: string[],
  opts: {
    onePage: boolean;
    usedHeight?: number[];
    /**
     * Each element the author put after a forced page break, in order: its
     * opening text, and what the break is for. Only the page before an answer
     * key, or a cover, may be left short (round 5: the model's own breaks
     * between ordinary sections left pages 46% full).
     */
    forcedStarts?: Array<{ text: string; kind: "cover" | "key" | "section" }>;
    /** Each chart's printed pieces of text: its labels and its caption. */
    figureTexts?: string[][];
  }
): PageIssue[] => {
  const issues: PageIssue[] = [];
  const spill = 260;
  pages.forEach((text, index) => {
    if (pageBody(text).length < 12)
      issues.push({ kind: "blank", page: index + 1 });
  });
  const last =
    pages.length > 1 ? pageBody(pages[pages.length - 1] ?? "") : null;
  if (last != null && last.length >= 12) {
    const before = pages
      .slice(0, -1)
      .map((p) => pageBody(p).length)
      .sort((a, b) => a - b);
    const median = before[Math.floor(before.length / 2)] ?? 0;
    // A few lines on their own, or a last page that is short beside the
    // others; when known, how far down the last page the text reaches.
    const used = opts.usedHeight?.[pages.length - 1];
    if (
      last.length < spill ||
      (used == null && last.length < 700 && last.length < median * 0.25) ||
      (used != null && used < 0.3)
    )
      issues.push({ kind: "spill", page: pages.length, chars: last.length });
  }
  // A page before the last that stops under 60% of the way down: a block that
  // would not fit moved whole to the next page (round 4: a 47% gap on page 2
  // of the lecture notes passed the old 40% line).
  const norm = (t: string): string =>
    t.replace(/\s+/g, " ").trim().toLowerCase();
  // Compared without spaces: a letter-spaced kicker reads "O A K L I N E" in
  // the PDF and "OAKLINE" in the page.
  const tight = (t: string): string => t.replace(/\s+/g, "").toLowerCase();
  // Each forced break starts a page, in the page's order: the pages that open
  // with the next forced start, in turn, are the ones the author began. (By
  // order, not by counting the heading earlier on: the PDF's text order is not
  // the page's, and a repeated heading is not a forced start.)
  const forced = (opts.forcedStarts ?? [])
    .map((f) => ({ text: tight(f.text).slice(0, 32), kind: f.kind }))
    .filter((f) => f.text.length > 0);
  // true for a page that starts after a cover or begins an answer key.
  const startsForced: boolean[] = pages.map(() => false);
  let k = 0;
  pages.forEach((text, i) => {
    if (i === 0 || k >= forced.length) return;
    const head = tight(pageBody(text)).slice(0, 240);
    const at = forced.findIndex(
      (f, j) => j >= k && j <= k + 1 && head.includes(f.text)
    );
    if (at < 0) return;
    // A page after a cover, or before an answer key, is a part's end.
    startsForced[i] = forced[at]!.kind !== "section";
    k = at + 1;
  });
  opts.usedHeight?.slice(0, -1).forEach((used, i) => {
    // A section the author ended with a page break is not a gap, unless the
    // page holds just a few lines: live F2b's answer key left 3 bullets alone
    // on a page before its next forced break.
    if (used >= 0.2 && startsForced[i + 1]) return;
    if (used >= 0.05 && used < 0.6 && pages.length > 1)
      issues.push({
        kind: "underfilled",
        page: i + 1,
        used: Math.round(used * 100) / 100,
      });
  });
  // A chart alone on its page, cut off from the text it belongs to.
  const figs = (opts.figureTexts ?? [])
    .map((f) => f.map(norm).filter((t) => t.length > 0))
    .filter((f) => f.length > 0);
  if (figs.length > 0 && pages.length > 1)
    pages.forEach((text, index) => {
      const body = norm(pageBody(text));
      let rest = body;
      let had = false;
      for (const f of figs) {
        const found = f.filter((t) => body.includes(t));
        if (found.length < Math.max(1, f.length * 0.6)) continue;
        had = true;
        for (const t of [...found].sort((a, b) => b.length - a.length))
          rest = rest.split(t).join(" ");
      }
      if (had && rest.replace(/\s+/g, "").length < 60)
        issues.push({ kind: "chart-alone", page: index + 1 });
    });
  if (opts.onePage && pages.length > 1)
    issues.push({ kind: "over-one-page", pages: pages.length });
  return issues;
};

/** In words the model can act on, for the one send-back. */
export const describeIssues = (issues: PageIssue[]): string[] =>
  issues.map((issue) =>
    issue.kind === "blank"
      ? `Page ${issue.page} printed empty.`
      : issue.kind === "spill"
        ? `The last page (${issue.page}) holds only ${issue.chars} characters.`
        : issue.kind === "underfilled"
          ? `Page ${issue.page} is only ${Math.round(issue.used * 100)}% full.`
          : issue.kind === "chart-alone"
            ? `Page ${issue.page} holds only a chart; keep it with its text.`
            : `It printed on ${issue.pages} pages; one was asked for.`
  );

/**
 * In the window. Raises any text below the floor (9 pt = 12 px on a page,
 * 18 px on a slide), then shrinks `--fit` on each poster and each slide whose
 * content runs past its box, down to `minFit`. Returns what it did.
 * Self-contained: serialised with Function.prototype.toString.
 */
export function fitInWindow(
  doc: Document,
  opts: { minFit: number; maxFit: number }
): {
  shrunk: Array<{ box: string; fit: number; fits: boolean }>;
} {
  const win = doc.defaultView!;
  const isDeck = doc.querySelector("section.slide") != null;
  const floor = isDeck ? 18 : 12;
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (el.closest("svg")) continue;
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || "").trim() !== ""
    );
    if (!hasText) continue;
    const size = parseFloat(win.getComputedStyle(el).fontSize);
    if (size > 0 && size < floor - 0.1) {
      el.style.fontSize = `${floor}px`;
    }
  }

  // Content past the box, judged from content boxes only: decoration placed
  // absolutely (round 3's cover circles run off the edge on purpose) and the
  // box's own scroll size, which counts that decoration, are left out.
  const overflows = (box: HTMLElement): boolean => {
    const r = box.getBoundingClientRect();
    // A slide's content must stay above its bottom padding, where the footer sits
    // (round 3: body text ran into "Tiffinly 3").
    const limit = box.matches("section.slide")
      ? r.bottom - parseFloat(win.getComputedStyle(box).paddingBottom) + 4
      : r.bottom + 1;
    const placed = (el: HTMLElement): boolean => {
      for (
        let e: HTMLElement | null = el;
        e && e !== box;
        e = e.parentElement
      ) {
        const pos = win.getComputedStyle(e).position;
        if (pos === "absolute" || pos === "fixed") return true;
      }
      return false;
    };
    return Array.from(box.querySelectorAll<HTMLElement>("*")).some((el) => {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return false;
      const e = el.getBoundingClientRect();
      return (
        e.height > 0 &&
        // The top too: a band that sits its title at its foot pushed a long
        // title up off the page (a wedding invite lost its first line).
        (e.bottom > limit || e.right > r.right + 1 || e.top < r.top - 1) &&
        !placed(el)
      );
    });
  };

  // Big values (tiles, hero panels, compare columns) shrink until they fit
  // their box on one line (round 3: "£186,400" ran into the next tile,
  // "R$ 11.760,00" broke over two lines).
  for (const v of Array.from(
    doc.querySelectorAll<HTMLElement>(
      ".tile .value, .panel .value, .col .value, .hero-figure .value"
    )
  )) {
    v.style.whiteSpace = "nowrap";
    const box = v.parentElement!;
    const room =
      box.clientWidth -
      parseFloat(win.getComputedStyle(box).paddingLeft) -
      parseFloat(win.getComputedStyle(box).paddingRight);
    let size = parseFloat(win.getComputedStyle(v).fontSize);
    // Down to the text floor: a word in a value ("Rice & bread") stopped at
    // 55% and ran under the chart beside it (round 4).
    const min = Math.min(size, floor * 1.25);
    while (v.scrollWidth > room + 1 && size > min) {
      size = Math.round(size * 0.92 * 10) / 10;
      v.style.fontSize = `${size}px`;
    }
  }
  // A document's cover is one page (255 mm of printable height): more than
  // that spills onto a second, nearly empty page (live F2: page 2 of a quiz
  // 34% full). Its type shrinks until it fits, as a poster's does.
  const coverLimit = (255 * 96) / 25.4;
  for (const cover of Array.from(
    doc.querySelectorAll<HTMLElement>("body.doc .cover")
  )) {
    let f = 1;
    while (
      cover.getBoundingClientRect().height > coverLimit + 1 &&
      f > opts.minFit + 0.001
    ) {
      f = Math.round((f - 0.04) * 100) / 100;
      cover.style.setProperty("--fit", String(f));
    }
  }
  const shrunk: Array<{ box: string; fit: number; fits: boolean }> = [];
  const boxes = Array.from(
    doc.querySelectorAll<HTMLElement>("section.slide, .poster, .certificate")
  );
  boxes.forEach((box, i) => {
    let fit =
      parseFloat(win.getComputedStyle(box).getPropertyValue("--fit")) || 1;
    if (!overflows(box)) return;
    while (fit > opts.minFit + 0.001 && overflows(box)) {
      fit = Math.round((fit - 0.04) * 100) / 100;
      box.style.setProperty("--fit", String(fit));
    }
    shrunk.push({
      box: `${box.matches("section.slide") ? "slide" : box.matches(".certificate") ? "certificate" : "poster"} ${i + 1}`,
      fit,
      fits: !overflows(box),
    });
  });

  // Grow: a slide whose content ends above 70% of its height gets larger
  // type, step by step, while nothing overflows (round 1 and E: content in
  // the top half, the rest of the slide bare).
  // A footer is absolutely placed; neither it nor what is inside it is content.
  const inAbsolute = (el: HTMLElement, box: HTMLElement): boolean => {
    for (let e: HTMLElement | null = el; e && e !== box; e = e.parentElement) {
      const pos = win.getComputedStyle(e).position;
      if (pos === "absolute" || pos === "fixed") return true;
    }
    return false;
  };
  // How much of the slide its content covers, top of the first line to the
  // bottom of the last: text, charts and images only (round 3 layouts stretch
  // their containers to the foot, so containers say nothing).
  const contentExtent = (box: HTMLElement): number => {
    const r = box.getBoundingClientRect();
    const leaves = Array.from(box.querySelectorAll<HTMLElement>("*")).filter(
      (el) =>
        !inAbsolute(el, box) &&
        !el.closest("svg") &&
        el.getBoundingClientRect().height > 0 &&
        (el.tagName.toLowerCase() === "svg" ||
          el.tagName.toLowerCase() === "img" ||
          Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent || "").trim() !== ""
          ))
    );
    if (leaves.length === 0) return 1;
    const top = Math.min(...leaves.map((el) => el.getBoundingClientRect().top));
    const bottom = Math.max(
      ...leaves.map((el) => el.getBoundingClientRect().bottom)
    );
    return (bottom - top) / r.height;
  };
  // Text wider than its own box (a value in a tile, a word in a card) clips
  // or runs into the next card: growing stops before it.
  const spills = (box: HTMLElement): boolean =>
    Array.from(box.querySelectorAll<HTMLElement>("*")).some(
      (el) =>
        !el.closest("svg") &&
        el.clientWidth > 0 &&
        el.scrollWidth > el.clientWidth + 1 &&
        Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent || "").trim() !== ""
        )
    );
  // Final round: slides still left the bottom third bare at 0.6-0.66; they
  // now grow until the content covers about four fifths of the slide.
  for (const box of boxes) {
    if (!box.matches("section.slide") || contentExtent(box) >= 0.72) continue;
    let fit =
      parseFloat(box.style.getPropertyValue("--fit")) ||
      parseFloat(win.getComputedStyle(box).getPropertyValue("--fit")) ||
      1;
    while (fit < opts.maxFit - 0.001) {
      const next = Math.round((fit + 0.06) * 100) / 100;
      box.style.setProperty("--fit", String(next));
      if (overflows(box) || spills(box) || contentExtent(box) > 0.88) {
        box.style.setProperty("--fit", String(fit));
        break;
      }
      fit = next;
      if (contentExtent(box) >= 0.78) break;
    }
  }
  // A poster or notice reads from across the room: its type grows until the
  // page is full (final round: a Bengali notice in 15 pt on a mostly blank
  // page). Its body spreads its lines out, so fullness is overflow, not extent.
  for (const box of boxes) {
    if (!box.matches(".poster")) continue;
    let fit = parseFloat(box.style.getPropertyValue("--fit")) || 1;
    while (fit < opts.maxFit - 0.001) {
      const next = Math.round((fit + 0.06) * 100) / 100;
      box.style.setProperty("--fit", String(next));
      if (overflows(box) || spills(box)) {
        box.style.setProperty("--fit", String(fit));
        break;
      }
      fit = next;
    }
  }
  return { shrunk };
}

/**
 * In the window: each element that starts after a page break the author
 * forced, in order, with what the break is for. After a cover, or before an
 * answer key, a short page is a part's end; any other forced break is a
 * section break, and with `drop` it is taken out so the text flows on (round
 * 5: the model's breaks before ordinary sections left pages 46% full).
 * Self-contained: serialised with Function.prototype.toString.
 */
export function forcedStartsIn(
  doc: Document,
  drop: boolean
): Array<{ text: string; kind: "cover" | "key" | "section" }> {
  const win = doc.defaultView!;
  const KEY =
    /\b(answer key|answers|mark scheme|marking scheme|solutions|appendix|teacher'?s? copy)\b/i;
  const textOf = (e: Element): string =>
    ((e as HTMLElement).innerText ?? e.textContent ?? "").trim();
  const out: Array<{ text: string; kind: "cover" | "key" | "section" }> = [];
  const seen = new Set<Element>();
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    const cs = win.getComputedStyle(el);
    const before = cs.breakBefore === "page";
    const after = !before && cs.breakAfter === "page";
    if (!before && !after) continue;
    let n: Element | null = el;
    if (after) {
      let x: Element | null = el;
      while (x && x !== doc.body && !x.nextElementSibling) x = x.parentElement;
      n = x && x !== doc.body ? x.nextElementSibling : null;
    }
    let t = n ? textOf(n) : "";
    while (n && !t && (n = n.nextElementSibling)) t = textOf(n);
    if (!n || !t || seen.has(n)) continue;
    const kind =
      after && el.matches(".cover")
        ? "cover"
        : KEY.test(t.slice(0, 120))
          ? "key"
          : "section";
    if (kind === "section" && drop) {
      if (before) el.style.breakBefore = "auto";
      else el.style.breakAfter = "auto";
      continue;
    }
    seen.add(n);
    out.push({ text: t.slice(0, 60), kind });
  }
  return out;
}
