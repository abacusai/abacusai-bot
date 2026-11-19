/**
 * The last resort for a number nobody gave and the code did not compute: the
 * smallest block that holds it (a tile, a list item, a table row, a
 * paragraph) is left out. Round 2 printed a wrong derived figure in a pitch.
 * Self-contained: serialised with Function.prototype.toString.
 */
export function dropNumbers(doc: Document, numbers: string[]): string[] {
  const dropped: string[] = [];
  const squash = (s: string): string => s.replace(/[  ]/g, " ");
  for (const n of numbers) {
    // The number whole: "30" is not the end of "£58,300" (live u05).
    const escaped = squash(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const whole = new RegExp(`(?<![\\d.,])${escaped}(?![\\d]|[.,]\\d)`);
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const hits: Element[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (whole.test(squash(node.textContent || "")) && node.parentElement)
        hits.push(node.parentElement);
    }
    for (const el of hits) {
      const block =
        el.closest(".tile, li, tr, p, figcaption, .card, h3, h2, td, div") ??
        el;
      if (block === doc.body || !block.isConnected) continue;
      dropped.push(
        (block.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
      );
      block.remove();
    }
  }
  // A heading left with nothing under it goes too: a CV printed "Profile"
  // over an empty space once its only paragraph was dropped.
  if (dropped.length > 0)
    for (const h of Array.from(doc.body.querySelectorAll("h2, h3"))) {
      let next = h.nextElementSibling;
      while (
        next != null &&
        (next.textContent || "").trim() === "" &&
        !next.querySelector("img, svg")
      )
        next = next.nextElementSibling;
      if (next == null || /^H[1-3]$/.test(next.tagName)) h.remove();
    }
  return dropped;
}
