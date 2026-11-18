/**
 * Only the app's own fonts on a printed page. Live F printed page numbers in
 * DejaVuSans and quiz circles in LiberationSans: fonts this VM has and a
 * user's machine does not, so the PDF depends on where it was printed.
 */

/** Font names (as a PDF records them) the app ships with the design system. */
const BUNDLED_FONTS = [
  "Inter",
  "SourceSerif4",
  "JetBrainsMono",
  "NotoSansBengali",
  "NotoSansDevanagari",
  "NotoSansMath",
  "NotoSansSymbols2",
  // The document designs' faces (resources/docs-system/designs.css).
  "PlayfairDisplay",
  "DMSerifDisplay",
  "Fraunces",
  "BricolageGrotesque",
  "BebasNeue",
  "Caveat",
  "CormorantGaramond",
  "LibreBaskerville",
  "DMSans",
  "Lora",
  "SpaceGrotesk",
  "Manrope",
  "ArchivoBlack",
];

/** The fonts a PDF names (`/BaseFont /ABCDEF+Inter-Bold` → `Inter-Bold`). */
export const fontsInPdf = (pdf: Buffer): string[] => {
  const text = pdf.toString("latin1");
  const names = new Set<string>();
  for (const m of text.matchAll(
    /\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/<>[\]()]+)/g
  ))
    names.add(m[1]!);
  return [...names];
};

/** The names that are not one of the bundled faces. */
export const foreignFonts = (names: string[]): string[] =>
  names.filter(
    (n) =>
      !BUNDLED_FONTS.some((b) =>
        n.replace(/[\s_]/g, "").toLowerCase().startsWith(b.toLowerCase())
      )
  );

/**
 * In the window: any font the model named itself (in a <style>, an inline
 * style or an SVG attribute) that is not bundled becomes the matching bundled
 * stack. Self-contained: serialised with Function.prototype.toString.
 */
export function bundledOnly(doc: Document): number {
  const ours =
    /^(["']?)(Inter|Source Serif 4|JetBrains Mono|Noto Sans (Bengali|Devanagari|Math|Symbols 2))\1$|^var\(--/i;
  const swap = (family: string): string | null => {
    const first = (family.split(",")[0] || "").trim();
    if (first === "" || ours.test(first)) return null;
    const all = family.toLowerCase();
    if (/mono|courier|consolas|menlo/.test(all)) return "var(--mono)";
    if (/serif/.test(all) && !/sans-serif/.test(all)) return "var(--serif)";
    if (/georgia|times|garamond|cambria|palatino|baskerville/.test(all))
      return "var(--serif)";
    return "var(--sans)";
  };
  let changed = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      if (!style || !style.fontFamily) continue;
      if ((rule as CSSRule).constructor.name === "CSSFontFaceRule") continue;
      const next = swap(style.fontFamily);
      if (next) {
        style.fontFamily = next;
        changed++;
      }
    }
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    const next = el.style.fontFamily ? swap(el.style.fontFamily) : null;
    if (next) {
      el.style.fontFamily = next;
      changed++;
    }
  }
  for (const el of Array.from(doc.querySelectorAll("[font-family]"))) {
    const next = swap(el.getAttribute("font-family") || "");
    if (next) {
      el.setAttribute(
        "font-family",
        "Inter, Noto Sans Math, Noto Sans Symbols 2"
      );
      changed++;
    }
  }
  // Sub- and superscript characters (₁ ₂ ⁻¹): no bundled font has the
  // block, so they become <sub>/<sup> drawn in the page's own font (live F2:
  // "Q₁, Q₂" printed in LiberationSans). ¹ ² ³ are in Inter and stay.
  const SUPS = "¹²³⁰ⁱ⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ";
  const SUPP = "1230i456789+\u2212=()n";
  const SUBS = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₙₜ";
  const SUBP = "0123456789+\u2212=()aeoxnt";
  const runs =
    /[\u00B9\u00B2\u00B3\u2070\u2071\u2074-\u207F]*[\u2070\u2071\u2074-\u207F][\u00B9\u00B2\u00B3\u2070\u2071\u2074-\u207F]*|[\u2080-\u209C]+/g;
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement;
    if (
      parent &&
      !parent.closest("svg, style, script") &&
      runs.test(n.textContent || "")
    )
      nodes.push(n as Text);
    runs.lastIndex = 0;
  }
  for (const node of nodes) {
    const text = node.textContent || "";
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(runs)) {
      if (m.index! > last)
        frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      const sub = m[0].charCodeAt(0) >= 0x2080;
      const el = doc.createElement(sub ? "sub" : "sup");
      el.textContent = Array.from(m[0])
        .map((c) => (sub ? SUBP[SUBS.indexOf(c)] : SUPP[SUPS.indexOf(c)]) ?? c)
        .join("");
      frag.appendChild(el);
      last = m.index! + m[0].length;
    }
    if (last < text.length)
      frag.appendChild(doc.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
  return changed;
}

/**
 * Margins and the page number for a document, drawn by the page itself (a CSS
 * margin box) in the bundled Inter: the same margins Chromium's footer used.
 */
export const PAGE_NUMBERS_CSS =
  '@page { size: A4; margin: 0.7in 0.75in 0.6in; @bottom-right { content: counter(page) "/" counter(pages); font-family: "Inter"; font-size: 9px; color: #8b9099; } }';
