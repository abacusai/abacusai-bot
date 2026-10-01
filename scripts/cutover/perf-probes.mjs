// One injected implementation for both shipped and candidate renderers.
export const probeSource = (fixture) => `(() => {
  if (window.__cutoverProbe) return;
  const fixture = ${JSON.stringify(fixture)};
  const state = window.__cutoverProbe = { interactiveAt: null, paintAt: null, longThreadAt: null, resources: [] };
  const absoluteNow = () => performance.timeOrigin + performance.now();
  const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') state.paintAt = performance.timeOrigin + entry.startTime;
  }).observe({ type: 'paint', buffered: true });
  const check = () => {
    const name = [...document.querySelectorAll('a,button,[role="button"]')].some(node => visible(node) && node.textContent.includes(fixture.botName));
    const composer = [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);
    if (!state.interactiveAt && name && composer && !composer.disabled) {
      composer.focus({ preventScroll: true });
      if (document.activeElement === composer) state.interactiveAt = absoluteNow();
    }
    if (state.threadClickedAt && !state.longThreadAt) {
      const last = [...document.querySelectorAll('p,[data-message-id],.prose')].find(node => visible(node) && node.textContent.includes(fixture.lastMessage));
      if (last) { const rect = last.getBoundingClientRect(); if (rect.bottom > 0 && rect.top < innerHeight) state.longThreadAt = absoluteNow(); }
    }
    state.resources = performance.getEntriesByType('resource').filter(entry => /\\.(js|css)(?:[?#]|$)/.test(entry.name)).map(entry => ({ url: entry.name, loadedAt: performance.timeOrigin + entry.responseEnd }));
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
})()`;

export const clickLongThreadSource = (fixture) => `(() => {
  const node = [...document.querySelectorAll('a,button,[role="button"]')].find(node => node.getClientRects().length && node.textContent.includes(${JSON.stringify(fixture.longSessionName)}));
  if (!node) throw new Error('Fixture long-session control is absent');
  window.__cutoverProbe.threadClickedAt = performance.timeOrigin + performance.now(); node.click();
})()`;
export function summarize(samples) {
  if (!samples.length || samples.some((value) => !Number.isFinite(value)))
    throw new Error("Missing or non-finite samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    samples,
  };
}
