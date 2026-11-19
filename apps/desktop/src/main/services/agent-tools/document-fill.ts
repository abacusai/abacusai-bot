/**
 * One-page forms (a resume, a letter) grow to use their page. A form prints at
 * its base size whatever its content, so a short career filled half a page
 * and left the rest blank; it is zoomed up, a step at a time, until it fills
 * most of the page, never past it and never by more than 30%. One only just
 * over a page is set up to 12% smaller so it stays on one.
 */

/**
 * The zoom for a form whose printed height at a given zoom is `heightAt`, on a
 * page `page` high. Self-contained: it is also sent to the page as source.
 */
export function chooseFillZoom(
  heightAt: (zoom: number) => number,
  page: number,
  /** The smallest zoom this form may print at to stay on one page. */
  floor = 0.88
): number {
  const base = heightAt(1);

  // Only just over a page: a little smaller keeps it on one sheet, rather
  // than a few lines alone on a second.
  if (base > page * 0.97) {
    for (let step = 1; 1 - step * 0.01 >= floor - 1e-9; step += 1) {
      const zoom = Math.round((1 - step * 0.01) * 100) / 100;

      if (heightAt(zoom) <= page * 0.97) return zoom;
    }

    return 1;
  }

  if (base >= page * 0.75) return 1;

  let best = 1;

  for (let step = 1; step <= 15; step += 1) {
    const zoom = Math.round((1 + step * 0.02) * 100) / 100;

    if (heightAt(zoom) > page * 0.92) break;
    best = zoom;
  }

  return best;
}

/** A4's printable area at the margins `exportDocumentPdf` prints with, in CSS px. */
const A4_PRINTABLE = { width: (8.27 - 1.5) * 96, height: (11.69 - 1.3) * 96 };

/**
 * Runs in the page before it prints: measures a `[data-fill-page]` form at the
 * printed width and sets its zoom. Returns the zoom chosen.
 */
export const FILL_PAGE = `(() => {
  const form = document.querySelector('[data-fill-page]')
  if (!form) return 1
  const root = document.documentElement
  const width = root.style.width
  root.style.width = '${Math.floor(A4_PRINTABLE.width)}px'
  const heightAt = (zoom) => {
    form.style.zoom = String(zoom)
    return document.body.getBoundingClientRect().height
  }
  const floor = Number(form.getAttribute('data-fill-min')) || 0.88
  const zoom = (${chooseFillZoom.toString()})(heightAt, ${Math.floor(A4_PRINTABLE.height)}, floor)
  form.style.zoom = String(zoom)
  root.style.width = width
  return zoom
})()`;
