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
    const candidates = [...document.querySelectorAll('a,button,[role="button"]')];
    const matchesBot = node => visible(node) && node.textContent.includes(fixture.botName);
    const bot = candidates.find(node => node.getAttribute('data-id')?.startsWith('bot-item-') && matchesBot(node)) ?? candidates.find(node => node.tagName === 'A' && matchesBot(node)) ?? candidates.find(matchesBot);
    const name = !!bot;
    const composer = [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);
    if (!state.interactiveAt && fixture.initialSessionName && !state.sessionSelectedAt) {
      const section = candidates.find(node => node.tagName !== 'A' && visible(node) && /^Sessions(?:[0-9]+)?$/.test(node.textContent.trim()));
      if (section && section.getAttribute('aria-expanded') === 'false') section.click();
      if (!section) {
        const link = candidates.find(node => node.tagName === 'A' && visible(node) && ['/sessions','/sessions/','/sessions/new'].includes((node.getAttribute('href') ?? '').split('#')[1]));
        if (link && !location.hash.startsWith('#/sessions')) link.click();
      }
      const session = candidates.find(node => visible(node) && node.textContent.includes(fixture.initialSessionName));
      if (session) { state.sessionSelectedAt = absoluteNow(); session.click(); }
    } else if (!state.interactiveAt && !fixture.initialSessionName && !composer && bot && (!state.botSelectedAt || absoluteNow() - state.botSelectedAt > 2000)) { state.botSelectedAt = absoluteNow(); bot.click(); }
    const initialMessage = fixture.initialSessionId ? 'Fixture final message ' + fixture.initialSessionId : null;
    const initialVisible = !initialMessage || [...document.querySelectorAll('p,[data-message-id],.prose')].some(node => visible(node) && node.textContent.includes(initialMessage));
    const initialReady = fixture.initialSessionName ? state.sessionSelectedAt && initialVisible && absoluteNow() - state.sessionSelectedAt > 100 : name;
    if (!state.interactiveAt && initialReady && composer && !composer.disabled) {
      composer.focus({ preventScroll: true });
      if (document.activeElement === composer) { state.interactiveAt = absoluteNow(); state.initialRoute = location.hash; }
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
  if (window.__cutoverProbe.threadClickedAt) return true;
  const section = [...document.querySelectorAll('button,[role="button"]')].find(node => node.getClientRects().length && /^Sessions(?:[0-9]+)?$/.test(node.textContent.trim()));
  if (section && section.getAttribute('aria-expanded') === 'false') section.click();
  if (!section) {
    const link = [...document.querySelectorAll('a')].find(node => node.getClientRects().length && ['/sessions','/sessions/','/sessions/new'].includes((node.getAttribute('href') ?? '').split('#')[1]));
    if (link && !location.hash.startsWith('#/sessions')) link.click();
  }
  const node = [...document.querySelectorAll('a,button,[role="button"]')].find(node => node.getClientRects().length && node.textContent.includes(${JSON.stringify(fixture.longSessionName)}));
  if (!node) return false;
  window.__cutoverProbe.threadClickedAt = performance.timeOrigin + performance.now(); node.click();
  return true;
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
