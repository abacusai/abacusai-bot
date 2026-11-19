/**
 * Short content grows into its slide. A template marks the block under a
 * slide's heading `data-deck-grow`; when the filler's text leaves that block
 * using little of the room above the slide's bottom padding, it is zoomed up
 * a step at a time, to at most 1.6, while it still fits and does not spill
 * sideways. The mirror of the shrink-to-fit pass, which runs after it.
 */

/**
 * The zoom for a block whose height at a given zoom is `heightAt` (Infinity
 * once it spills sideways), with `room` to grow into. Self-contained: it is
 * also sent to the page as source.
 */
export function chooseGrowZoom(
  heightAt: (zoom: number) => number,
  room: number
): number {
  if (!(room > 0)) return 1;
  if (heightAt(1) >= room * 0.8) return 1;

  let best = 1;

  for (let step = 1; step <= 12; step += 1) {
    const zoom = Math.round((1 + step * 0.05) * 100) / 100;

    if (heightAt(zoom) > room * 0.95) break;
    best = zoom;
  }

  return best;
}

/** Runs in the page before printing; returns how many blocks grew. */
export const GROW_SLIDES = `(() => {
  const choose = ${chooseGrowZoom.toString()}
  let grown = 0
  for (const slide of document.querySelectorAll('[data-deck-slide]')) {
    const blocks = slide.querySelectorAll('[data-deck-grow]')
    if (blocks.length === 0) continue
    const style = getComputedStyle(slide)
    const edge = slide.getBoundingClientRect()
    const bottom = edge.bottom - Math.max(parseFloat(style.paddingBottom) || 0, edge.height * 0.06)
    const right = edge.right - (parseFloat(style.paddingRight) || 0) + 1
    for (const block of blocks) {
      const top = block.getBoundingClientRect().top
      const heightAt = (zoom) => {
        block.style.zoom = String(zoom)
        const box = block.getBoundingClientRect()
        if (box.right > right || block.scrollWidth > block.clientWidth + 2) return Infinity
        // Something inside that clips (a card, a figure box) would cut its own
        // content: status-report's "3,200" outgrew its KPI card.
        for (const el of block.querySelectorAll('*')) {
          const cs = getComputedStyle(el)
          const clips = /hidden|clip/.test(cs.overflow + ' ' + cs.overflowX + ' ' + cs.overflowY)
          if (clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) return Infinity
          // Text that runs past the card it is drawn in (a fill or border).
          const fill = cs.backgroundColor
          const drawn = (fill && fill !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(fill)) || (/solid|dashed|dotted|double/.test(cs.borderLeftStyle) && parseFloat(cs.borderLeftWidth) > 0)
          if (drawn && zoom > 1) {
            const card = el.getBoundingClientRect()
            for (const inner of el.querySelectorAll('*')) {
              if (![...inner.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
              if (inner.getBoundingClientRect().right > card.right + 1) return Infinity
            }
          }
        }
        // The content's own extent, from what is drawn: text, and boxes with
        // a fill or border. A grid or column stretched to fill the slide is
        // as tall as its room whatever it holds, so it does not count.
        let end = box.top
        for (const el of block.querySelectorAll('*')) {
          const r = el.getBoundingClientRect()
          if (r.height === 0 || r.height >= box.height * 0.98) continue
          const cs = getComputedStyle(el)
          const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)
          const drawn = text || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0
          if (drawn) end = Math.max(end, r.bottom)
        }
        return end - box.top
      }
      const room = bottom - top
      const zoom = choose(heightAt, room)
      const used = heightAt(zoom)
      block.style.zoom = String(zoom)
      if (zoom > 1) grown++
      // Still under a third of its room once grown (one decision, one risk):
      // set a third of the way down rather than stuck under the heading.
      // Padding is in the block's own pixels, which the zoom scales.
      if (Number.isFinite(used) && used < room / 3)
        block.style.paddingTop = Math.round((room - used) / 3 / zoom) + 'px'
    }
  }
  return grown
})()`;
