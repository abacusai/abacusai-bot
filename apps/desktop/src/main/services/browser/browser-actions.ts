/**
 * The decisions the browser tools make before they touch a page, kept out of
 * `mcp-browser-server.ts` (which imports `electron`) so they can be tested
 * without a running app. A tool that errors is cheap; one that reports
 * success for something that did not happen costs the rest of the run.
 */

/**
 * What a tool call's `ref`/`selector` arguments resolved to. A stale ref and
 * no target at all must stay distinct: `type`, `scroll` and `wait` each give
 * "no target" a meaning of its own, and a stale ref (any page change
 * invalidates every ref) must not inherit it.
 */
export type TargetResolution =
  | { kind: "selector"; selector: string }
  | { kind: "stale-ref"; ref: string }
  | { kind: "no-target" };

/**
 * A `ref` is authoritative when present: falling back to `selector` for a
 * stale one would act on something the caller did not ask for.
 */
export function resolveTarget(
  args: { ref?: unknown; selector?: unknown },
  refMap: ReadonlyMap<string, string>
): TargetResolution {
  const ref =
    typeof args.ref === "string" && args.ref.length > 0 ? args.ref : null;

  if (ref != null) {
    const selector = refMap.get(ref);

    return selector != null
      ? { kind: "selector", selector }
      : { kind: "stale-ref", ref };
  }

  const selector =
    typeof args.selector === "string" && args.selector.length > 0
      ? args.selector
      : null;

  return selector != null
    ? { kind: "selector", selector }
    : { kind: "no-target" };
}

/** One session's view of the last snapshot it took. */
export interface SessionSnapshot {
  /** `@eN` to the selector the walker verified for it. */
  refMap: Map<string, string>;
  /** The URL the refs were captured on, to spot a page-initiated navigation. */
  url: string | null;
}

/**
 * Snapshot state per session. One browser server serves every session, and a
 * shared ref map lets one session's click resolve `@e5` against another's
 * page. The pane itself is still shared; `browser_task` holds a lock for that.
 */
export class SnapshotStore {
  private readonly bySession = new Map<string, SessionSnapshot>();

  /** An absent id is a client with no session tag: one shared bucket. */
  for(sessionId?: string): SessionSnapshot {
    const key = sessionId ?? "";
    let state = this.bySession.get(key);

    if (state == null) {
      state = { refMap: new Map<string, string>(), url: null };
      this.bySession.set(key, state);
    }

    return state;
  }

  /** The pane is shared, so a navigation invalidates every session's refs. */
  clearAll(): void {
    this.bySession.clear();
  }

  /** Sessions currently holding refs. For tests and diagnostics. */
  get sessionCount(): number {
    return this.bySession.size;
  }
}

/**
 * How `browser_execute` should try the code it was given: a bare expression
 * evaluated as a statement body yields `undefined`, so it is wrapped in a
 * `return` first. The caller must advance **only on a syntax error**: retrying
 * on `undefined` runs `el.click()`-style code twice, and could never help.
 */
export function planExecuteAttempts(code: string): string[] {
  // `return` as a statement, not inside a string or `returnValue`.
  const looksLikeStatement = /(^|[\s;{()])return([\s(;)]|$)/.test(code);

  return looksLikeStatement ? [code] : [`return (${code})`, code];
}

/**
 * Whether a page error is the parse failure that justifies the next attempt.
 * Anchored, since this decides whether the code runs twice: a page's own
 * `throw new Error("SyntaxError in the config")` must not match.
 */
export function isSyntaxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /^(Uncaught\s+)?SyntaxError\b/.test(message.trim());
}

/**
 * Split a key combo into the key and its modifiers. The literal plus key is
 * why this is not a bare `split('+')`: `"Control++"`, `"Shift+"` and `"+"`
 * each leave a different number of empty segments behind.
 */
export function parseKeyCombo(combo: string): {
  key: string;
  modifiers: string[];
} {
  const parts = combo.split("+");
  const last = parts[parts.length - 1]!;

  // A trailing '+' means the key itself is '+', and split left an empty tail.
  if (last === "" && parts.length > 1) {
    const rest = parts.slice(0, -1);

    // `"Control++"` leaves one more empty segment behind than `"Shift+"` does.
    if (rest[rest.length - 1] === "") rest.pop();

    return {
      key: "+",
      modifiers: rest
        .filter((part) => part.length > 0)
        .map((part) => part.toLowerCase()),
    };
  }

  return {
    key: last,
    modifiers: parts
      .slice(0, -1)
      .filter((part) => part.length > 0)
      .map((part) => part.toLowerCase()),
  };
}

/**
 * A tool argument interpolated into page JavaScript, as a number. MCP
 * arguments are whatever the model wrote, and a cast is not a runtime check: a
 * non-number spliced into `window.scrollBy(${dx}, 0)` is script execution from
 * a value chosen after reading the page. Bounds too: an hour's wait is a hang.
 */
export function numericArg(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  // `Number('')` is 0, which would report a scroll that never moved.
  const blank = typeof value === "string" && value.trim().length === 0;
  const parsed = typeof value === "number" ? value : Number(value);
  const base =
    Number.isFinite(parsed) && value != null && !blank ? parsed : fallback;

  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(base)));
}

/**
 * A URL glob as a regular expression source. Metacharacters are escaped
 * first (`results?page=1` means a literal `?`), then `**` spans path
 * separators and `*` does not.
 */
export function globToRegexSource(pattern: string): string {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // A private-use placeholder keeps the `**` rewrite out of the `*` one. It
  // is stripped from the input first, or a pattern holding it would become `.*`
  const PLACEHOLDER = "\uE000";
  const source = escaped
    .split(PLACEHOLDER)
    .join("")
    .replace(/\*\*/g, PLACEHOLDER)
    .replace(/\*/g, "[^/]*")
    .split(PLACEHOLDER)
    .join(".*");

  return `^${source}$`;
}

/**
 * The reason a `goto` must not load this URL, or null when it may. The model
 * picks the URL after reading an untrusted page, and Electron runs
 * `javascript:` against the loaded document; `data:` is the same trick.
 * `file:` stays allowed: the agent can already read those files directly.
 */
export function navigationRefusal(raw: string): string | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a valid URL. Include the scheme, e.g. https://example.com.`;
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();

  if (scheme === "javascript" || scheme === "data") {
    return (
      `Refusing to navigate to a ${scheme}: URL — it would run as script in the page that is already loaded. ` +
      "Use browser_execute if you meant to run code in the current page."
    );
  }

  return null;
}

/**
 * Whether the preview has finished going where `goto` sent it. Host rather
 * than full URL, because servers redirect. `sawLoading` stops the loop
 * answering before the navigation starts: `loadURL` is asynchronous, and a
 * `goto` to another path on the current host would otherwise match at once.
 */
export function navigationSettled(state: {
  loading: boolean;
  currentUrl: string;
  startUrl: string;
  /** Null for `back`, `forward` and `reload`, which have no destination. */
  targetHost: string | null;
  sawLoading: boolean;
  elapsedMs: number;
  graceMs: number;
}): boolean {
  if (state.loading) return false;

  // Evidence the view left, demanded only for a grace period: a `goto` to
  // the URL already open produces none.
  const started =
    state.sawLoading ||
    state.currentUrl !== state.startUrl ||
    state.elapsedMs >= state.graceMs;

  if (!started) return false;
  if (state.targetHost == null) return true;

  try {
    return new URL(state.currentUrl).host === state.targetHost;
  } catch {
    // about:blank and friends have no host: keep waiting.
    return false;
  }
}

/**
 * Exact label, then prefix, then substring, then first word. Null when
 * nothing fits: a wrong pick silently books the wrong city.
 */
export function chooseOption<T extends { name?: string }>(
  candidates: readonly T[],
  wanted: string
): T | null {
  const target = wanted.trim().toLowerCase();

  if (target.length === 0) return null;

  const named = candidates.filter(
    (candidate) => (candidate.name ?? "").trim().length > 0
  );
  const label = (candidate: T): string =>
    (candidate.name ?? "").trim().toLowerCase();
  const firstWord = target.split(/[\s,]+/)[0] ?? target;

  return (
    named.find((candidate) => label(candidate) === target) ??
    named.find((candidate) => label(candidate).startsWith(target)) ??
    named.find((candidate) => label(candidate).includes(target)) ??
    (firstWord.length >= 3
      ? named.find((candidate) => label(candidate).includes(firstWord))
      : undefined) ??
    null
  );
}

/** Site advice handed over when the host loads, not carried in the prompt. */
const RECIPES: Array<{ hosts: RegExp; tip: string }> = [
  {
    hosts: /(^|\.)google\.(com|co\.[a-z]{2}|[a-z]{2,3})$/,
    tip:
      "Google: search pages take the query in the URL — /search?q=..., /travel/flights?q=Flights from BLR to DEL on 2026-09-20 one way, " +
      '/maps/search/coffee+near+Indiranagar. On Flights, airport boxes are autocompletes: use interact action:"pick". ' +
      'Prices sit in the results list; extract with selector "li" or read the text.',
  },
  {
    hosts: /(^|\.)amazon\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2,3})$/,
    tip:
      'Amazon: /s?k=your+query searches. Results are [data-component-type="s-search-result"]; extract with that selector ' +
      'and fields like {"title":"h2","price":".a-price .a-offscreen"}. Dismiss the location/cookie banner first if shown.',
  },
  {
    hosts: /(^|\.)github\.com$/,
    tip:
      "GitHub: /<org>/<repo>/issues?q=is:issue is:open label:bug searches issues; /<org>/<repo>/pulls for PRs. " +
      "Most read-only questions are answered by web_fetch on the same URL without a browser.",
  },
  {
    hosts: /(^|\.)youtube\.com$/,
    tip: "YouTube: /results?search_query=... searches. Video titles are in #video-title; extract with that selector.",
  },
  {
    hosts:
      /(^|\.)(booking|agoda|expedia|makemytrip|goibibo|skyscanner|kayak)\.(com|co\.[a-z]{2}|[a-z]{2,3})$/,
    tip:
      'Travel site: destination boxes are autocompletes (interact action:"pick"), date fields open a calendar — click the day ' +
      "cell by ref and check which month is showing. Results load after the page says it has loaded: wait for text or a URL pattern.",
  },
  {
    hosts: /(^|\.)(linkedin|x|twitter|facebook|instagram)\.com$/,
    tip: "Social site: most content is behind a login wall and the feed loads as you scroll. If a sign-in page appears, stop and report it — do not enter credentials.",
  },
];

export function recipeFor(url: string): string | null {
  let host: string;

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  return RECIPES.find((recipe) => recipe.hosts.test(host))?.tip ?? null;
}
