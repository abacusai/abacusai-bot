/**
 * What counts as on the page, as in-page JavaScript shared by the snapshot
 * walker and the vault's login scan, so a field the snapshot drops is never
 * one a fill types into, and the other way round.
 *
 * `__visibilityOf(el)` is one of four states. 'gone' takes the subtree with
 * it. 'invisible' is an element a user cannot see or click but whose
 * children may still be both: visibility, unlike display, is inherited and
 * can be turned back on. 'transparent' is an element with no box of its own
 * whose children are laid out as if it were not there: nothing to aim at,
 * everything inside it still on the page. 'visible' is the rest.
 *
 * visibility:hidden used to slip through entirely: such an element keeps its
 * layout box, so it has an offsetParent and a non-zero rect, and the old check
 * only looked at the computed style when offsetParent was null. Hidden menus
 * and closed dropdowns therefore came back as refs the agent could not click.
 *
 * Having no box used to mean 'gone', which held only for display:none. A
 * display:contents wrapper (a <slot>, a framework's layout element) never has
 * a box, so a sign-in form nested under two of them vanished whole and the
 * page read as its footer links. No box is now judged by what it does to the
 * children: display:contents, or a collapsed box in the flow that does not
 * clip its overflow, is transparent. A collapsed box that clips, or one taken
 * out of the flow (absolute or fixed), is gone, and so is anything positioned
 * wholly off the page where no scroll reaches it: that is how a page hides a
 * honeypot field from people and leaves it for bots.
 *
 * `__typeableNow(el)` is stricter, for a field about to take a value: it and
 * every ancestor are on the page, it is visible, nothing above it is fully
 * transparent, and it is not clipped to nothing (the "visually hidden" idiom).
 */
export const VISIBILITY_JS = `
  const __visibilityOf = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none') return 'gone';
    if (s.display === 'contents') return 'transparent';
    // offsetParent is HTML-only: an SVG element has none and is judged by its box.
    if ('offsetParent' in el && !el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML'
        && s.position !== 'fixed' && s.position !== 'sticky') return 'gone';
    const r = el.getBoundingClientRect();
    const outOfFlow = s.position === 'absolute' || s.position === 'fixed';
    if (r.width === 0 && r.height === 0) {
      if (outOfFlow) return 'gone';
      const clips = (v) => v !== 'visible';
      return clips(s.overflowX) || clips(s.overflowY) ? 'gone' : 'transparent';
    }
    if (s.position === 'fixed'
        && (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight)) return 'gone';
    if (s.position === 'absolute'
        && (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0)) return 'gone';
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'invisible';
    return 'visible';
  };
  const __typeableNow = (el) => {
    if (!el.isConnected) return false;
    for (let at = el; at && at.nodeType === 1; at = at.parentElement) {
      const state = __visibilityOf(at);
      if (state === 'gone' || (at === el && state !== 'visible')) return false;
      if (Number(getComputedStyle(at).opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    if (String(s.clip).startsWith('rect(0px, 0px, 0px, 0px)')) return false;
    const path = String(s.clipPath);
    if (path.includes('inset(50%') || path.includes('inset(100%')) return false;
    return true;
  };
`;
