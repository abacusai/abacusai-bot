/**
 * The scripts that run inside the page, as builders. They decide whether an
 * interaction actually happened, and live apart from the server so they can
 * run against a stand-in element rather than a scripted reply. Values are
 * interpolated as JSON literals, never as bare source.
 */

/** Click, unless the control is disabled. */
export const clickScript = (selector: string): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { status: 'not_found' };
  // A disabled control accepts .click() and does nothing with it, so
  // the tool used to report a click that the page never saw and the
  // agent went on waiting for a result that was not coming.
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
    return { status: 'disabled', tag: el.tagName.toLowerCase() };
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  const r = el.getBoundingClientRect();
  return { status: 'ok', tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 50), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()`;

/** Replace an element's value, whatever kind of element it turns out to be. */
export const fillScript = (
  selector: string,
  text: string
): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { status: 'not_found' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  const value = ${JSON.stringify(text)};
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return { status: 'ok' };
  }
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
    : (el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
    : (el instanceof HTMLInputElement) ? HTMLInputElement.prototype
    : null;
  if (!proto) return { status: 'not_fillable', tag: el.tagName.toLowerCase() };
  if (el.disabled || el.readOnly) return { status: 'not_editable', tag: el.tagName.toLowerCase() };
  const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSet) nativeSet.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { status: el.value === value ? 'ok' : 'rejected' };
})()`;

/**
 * Append to an element's value. `target` is an expression: with no ref it is
 * `document.activeElement`.
 */
export const typeScript = (
  target: string,
  text: string
): string => `(function() {
  const el = ${target};
  // document.activeElement is <body> on a page nothing is focused in,
  // and the value setter below then threw "Illegal invocation".
  if (!el || el === document.body || el === document.documentElement) return { status: 'not_found' };
  if (el !== document.activeElement) el.focus();
  const suffix = ${JSON.stringify(text)};
  if (el.isContentEditable) {
    el.textContent = (el.textContent || '') + suffix;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return { status: 'ok' };
  }
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
    : (el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
    : (el instanceof HTMLInputElement) ? HTMLInputElement.prototype
    : null;
  if (!proto) return { status: 'not_fillable', tag: el.tagName.toLowerCase() };
  if (el.disabled || el.readOnly) return { status: 'not_editable', tag: el.tagName.toLowerCase() };
  const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const newVal = (el.value || '') + suffix;
  if (nativeSet) nativeSet.call(el, newVal);
  else el.value = newVal;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { status: el.value === newVal ? 'ok' : 'rejected' };
})()`;

/** Choose an option, and refuse to call anything else a selection. */
export const selectScript = (
  selector: string,
  value: string
): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el || el.tagName !== 'SELECT') return { status: 'not_found' };
  const wanted = ${JSON.stringify(value)};
  const byLabel = Array.from(el.options).find(o => o.text.trim() === wanted);
  el.value = wanted;
  // Models read the visible option text out of a snapshot far more
  // often than the underlying value attribute, so a label match is
  // accepted rather than failed.
  if (el.selectedIndex === -1 && byLabel) el.value = byLabel.value;
  if (el.selectedIndex === -1) {
    return { status: 'no_match', options: Array.from(el.options).slice(0, 20).map(o => o.value) };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { status: 'ok', selected: el.value };
})()`;

/** Set a checkbox, and report the state it actually ended in. */
export const checkScript = (
  selector: string,
  want: boolean
): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'not_found';
  if (el.checked !== ${JSON.stringify(want)}) el.click();
  // Report the state the element actually ended in. A click a
  // framework intercepted or reverted is not a success.
  return el.checked === ${JSON.stringify(want)} ? 'ok' : 'unchanged';
})()`;

/**
 * Structured data out of the page without the model writing JavaScript: one
 * row per match, with a column per `fields` entry; a `<table>` as its cells.
 */
export const extractScript = (
  selector: string,
  fields: Record<string, string>,
  limit: number
): string => `(function() {
  const clean = (t) => String(t ?? '').replace(/\\s+/g, ' ').trim();
  const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  if (els.length === 0) return { status: 'not_found' };
  const fields = ${JSON.stringify(fields)};
  const limit = ${JSON.stringify(limit)};
  const rows = [];
  for (const el of els) {
    if (rows.length >= limit) break;
    if (el.tagName === 'TABLE') {
      for (const tr of el.querySelectorAll('tr')) {
        if (rows.length >= limit) break;
        const cells = Array.from(tr.querySelectorAll('th,td')).map(c => clean(c.innerText).slice(0, 120));
        if (cells.some(Boolean)) rows.push(cells);
      }
      continue;
    }
    const row = { text: clean(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 300) };
    const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
    if (link) row.href = link.href;
    for (const name of Object.keys(fields)) {
      let target = null;
      try { target = el.querySelector(fields[name]); } catch { row[name] = 'invalid selector'; continue; }
      row[name] = target ? clean(target.innerText || target.value || target.getAttribute('aria-label') || target.getAttribute('href') || '').slice(0, 200) : null;
    }
    rows.push(row);
  }
  return { status: 'ok', total: els.length, rows: rows };
})()`;

/**
 * Resolves once the page has stopped changing for `quietMs`, or after `maxMs`.
 * Gives a click its consequences before the tool reports on them.
 */
export const settleScript = (quietMs: number, maxMs: number): string =>
  `new Promise((resolve) => {
  const start = Date.now();
  let last = start;
  const observer = new MutationObserver(() => { last = Date.now(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  const tick = setInterval(() => {
    const now = Date.now();
    if (now - last >= ${JSON.stringify(quietMs)} || now - start >= ${JSON.stringify(maxMs)}) {
      clearInterval(tick);
      observer.disconnect();
      resolve(now - start);
    }
  }, 50);
})`;

/** The current value of a field, after the page has had its say. */
export const valueScript = (selector: string): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  return String(el.isContentEditable ? el.textContent : (el.value ?? '')).slice(0, 200);
})()`;
