# Review of the phase-1 renderer foundation (Claude r1) — verdict NEEDS FIXES

Scope: `git diff 73caf359..HEAD` over `apps/desktop/src/renderer-next` (excluding `ui/**`), `vite.config.ts`, `vite.shared.ts`, `scripts/`, `components.json`, `index-next.html`, `src/main/renderer-generation.ts`, `src/main/dev/`. Checked against spec 01 r4 and its review-response tables, plus the PLAN/PROGRESS amendments (router document-level view transitions, the interim `data/collections` adapter, the dev fixture DB). Screenshots: `.claude/worktrees/agent-a418ac2a326e7fbf6/.build/screenshots/a91d0d4c/` and its `axe.json`. Line numbers are at `HEAD` (`6847de01`).

## Findings

1. **High — `features/shell/shell-layout.tsx:177-196`: opening or closing the side panel remounts the whole route.** `<Pane/>`, and with it the route `<Outlet/>`, is rendered inside `ResizablePanelGroup > ResizablePanel` when `layout.sidePanel === "layout" && tab`, and as a bare child otherwise. These are different tree positions, so React unmounts and remounts the entire route subtree when you:
   - toggle the panel at ≥1100 (⌘⌥B, the title-bar toggle, a tab link);
   - cross 1100 px with a tab open (xl ⇄ lg).

   Phase 1 loses only an Empty state. In phase 2 the same remount throws away the chat's scroll position, composer draft and stream subscription. This is the same class of bug R1-T1 guards against for pop-ups. **Fix:** keep one stable tree: always render the `ResizablePanelGroup`, and collapse or hide the side-panel `ResizablePanel` (size 0 or `collapsible`) when it is closed or in drawer mode. Alternatively, keep `<Pane/>` at a fixed position with a keyed wrapper. Add a test that a counter or `scrollTop` in the pane survives a panel toggle at xl and an xl→lg resize.

2. **High — `lib/navigation/transition-types.test.tsx:284-297`: the view-transition path that actually ships has no unit coverage.** After `a91d0d4c`, animation comes from the router's `defaultViewTransition.types` callback (`transition-types.ts:104-124`), not the React seam. The only unit assertion on that path is `expect(documentTypes).toEqual([])`. The comment explains that jsdom has no `startViewTransition`, so the router never calls `types`, which makes the assertion vacuous.

   Every R1-T11 case is proven only for the now-inert `addTransitionType` seam: pending offer, blocked, rapid/superseded, `invalidate()`, back/forward direction, masked close and search-only changes. The document path also has its own dedupe (`documentLastKey`), separate from the seam's `lastCommittedKey`, and it reads `router.latestLocation` at `startViewTransition` time. If a newer navigation began in between, that is not the committing location.

   **Fix:**
   - Stub `document.startViewTransition` (and `CSS.supports("selector(:active-view-transition-type(a))")`) in the harness and re-run all R1-T11 cases against the `types` callback.
   - Compute types from the router's committing `toLocation` (`getLocationChangeInfo(next, prev)` already passes it). Do not use `latestLocation` in `navTypesFor`.
   - Delete the seam, or keep it only as a documented dual path. Two mechanisms computing the same answer will drift.

3. **High (architecture) — `transition-types.ts:98-124` versus PLAN L23 "React owns view transitions".** The deviation is in PLAN/PROGRESS only as a commit message. It changes phase 2 and 3 plans:
   - React `<ViewTransition name>` shared elements (`bot-identity-${botId}`, 420 ms; `welcome-parade`) cannot join a transition that the router starts with `document.startViewTransition`.
   - Any React `<ViewTransition>` that is mounted during a route commit (the gallery `motion` section today; Suspense reveals later) makes React start a second `startViewTransition` while the router's is active. The first one is skipped. §13's fallback explicitly says "never a second transition".

   **Fix:** record this as a PLAN amendment with its consequences. Decide now whether shared elements become plain CSS `view-transition-name` under the router's transition, or whether route commits move back to React (for example, by committing through a React state update rather than store subscriptions). Guard against React VTs being present during router transitions: lint, or a dev assertion on `document.activeViewTransition`.

4. **High — `data/collections/*` (interim adapter): moving to `data/db` is not a one-line change, and the interim adapter lacks the B fixes that are merged.** `data/collections/ipc-collection-options.ts` predates `706c0fec` (one snapshot loop per connection, covering echo resync, a lazy collection's mutation starting its sync) and `4fd805c4` (per-leaf prefs provenance, `updatePrefs(patch)`, read-only field refusal). Concrete defects today, whenever it runs against the real main instead of fixtures:
   - **Prefs provenance leak.** `tables.ts:51-54` sends `changes` minus id/updatedAt. Callers assign whole groups (`draft.sidebar = { ...draft.sidebar, pinned }` in `shell-layout.tsx:127-129` and `app-root.tsx:79-82`), so ⌘B also sends `sidebar.openSection` and marks it `user`. That permanently stops legacy sync of a leaf the user never touched (spec 00 B.2 per-leaf rule).
   - **Mutation on a lazy collection.** `awaitEcho` (`ipc-collection-options.ts:~330`) waits `echoTimeoutMs`. It then calls `utils.resync()`, which is a no-op when `resyncNow == null` (sync not started), so the handler resolves without an echo. For a lazy table (bots, routines) this is a 10 s hang followed by the optimistic row being dropped.
   - **Stopping syncs.** `collection.cleanup()` in `main.tsx:68-72` restarts sync on the next subscriber. See #7.

   **What breaks when switching to `data/db`:**
   - (a) Registry shape. `data/db/index.ts` creates module singletons at import time over `getTransport`, with `startSync` on three tables. The app uses a `createCollections(source)` factory plus `getCollections()`, `setDbSource()`, `CollectionsProvider`/`useCollections` and the `Collections` record type in the router context. Importing `data/db` would call `getTransport()` from module evaluation, before `initI18n`/`bootstrap()`'s timeout and `onClose` wiring (spec §8.6 step 5 ordering). It would also leave no hook for the fixture source.
   - (b) `updatePrefs`: a recipe `(draft) => void` in 7 call sites becomes `PrefsPatch`, with different semantics (explicit-choice leaves). Call sites: `shell-layout.tsx`, `app-root.tsx`, `command-menu.tsx`, `features/settings/index.tsx`, `sessions-sidebar.tsx`, `prefs.ts createPaneWidthWriter`, `lib/dev/dev-hooks.ts`.
   - (c) Config knobs: `backoffMs[]` becomes `retryDelayMs(n)`. `gcTime: 0` for the shell tables has no counterpart in `IpcCollectionConfig`.
   - (d) Stricter writes: `writablePatch` throws `ReadOnlyFieldError` for sessions/bots/prefs fields that the interim adapter sends or silently drops. Bots insert `{ ...row }` becomes `BOT_CREATE_FIELDS`.
   - (e) Tests: `bots-sidebar.test.tsx`, `sessions-sidebar.test.tsx`, `theme.test.tsx`, `bootstrap.test.ts`, `test-support/app-harness.tsx` and `data/fixture-db/*` are all built on `createCollections(DbSource)`. R1-T3 tests the interim adapter (185 lines), not spec 00 B-T1 (all cases).
   - (f) The fixture DB's `createMemoryDbSource()` returns a `DbSource`, not a `LazyTransport`.
   - (g) Utils: `awaitEcho`/`startSyncImmediate` exist only in `data/db`. The devtools Collections panel's `status()` shape is compatible.

   **Fix:** give `data/db` a `createCollections(lazyTransport, overrides)` factory. Keep the singletons behind `getCollections()`, not at import. Delete `data/collections/{ipc-collection-options,tables,table-source}.ts`. Port `usePrefs`/`useUpdatePrefs`/the pane writer onto `updatePrefs(patch)` (for example, `{ sidebar: { pinned } }`). Adapt `fixture-db` to hand a `LazyTransport` (its memory transport already is one). Until then, record in PLAN that two adapters exist.

5. **Medium — `package.json` `dev:next` and `scripts/screenshots-next.mjs:173`: the fixture DB stand-in outlived its reason.** Sub-slice B is merged: `src/main/rpc/router.ts:65` wires `db: dbRouter`, and main has `rpc/tables/*` with e2e tests. Yet `dev:next`, the screenshot run and R1-T11b all build with `VITE_NEXT_DB_FIXTURES=1`. Consequences:
   - The phase gate ("shell renders with real sidebars from collections") and the §12 "sidebars are live through the running main's legacy service path" item (mutation harness) are not exercised. Harness mutations go to main; the renderer reads the fixtures.
   - Prefs writes (theme) never reach main, so `nativeTheme.themeSource` and the WCO symbol colours never follow the in-app theme in dev.
   - The `memory-source.ts:1-7` header ("main's db.* answers UNAVAILABLE until B lands") is stale.

   **Fix:** default `dev:next` and the screenshot run to real `db.*`. Keep fixtures behind an explicit opt-in (`dev:next:fixtures`) seeded through the home directory, as §10.2 step 2 specified. Add the harness `bots.create` → sidebar integration case from §12.

6. **Medium — `lib/navigation/…`, `features/shell/rail.tsx:113,118` + `shell-layout.tsx:111-115`: the rail's "last location" is a full href passed as `to`.**
   - `rememberLocation(area, location.href)` stores `"/sessions/abc?tab=terminal"`, and `AppLink to={href}` hands it to `to`. Verified with `router.buildLocation({ to: "/sessions/abc?tab=terminal" })`: it returns `pathname: "/sessions/abc?tab=terminal"`, `search: {}`. Committing happens to work because the href string round-trips through history. However, `preload="intent"` and active matching run on a pathname whose `$sessionId` is `abc?tab=terminal`. That fails `SessionId` parsing or triggers `notFound`, and search middlewares (`retainSearchParams(["view"])`) are bypassed.
   - It also stores masked pop-up locations: `/routines/new` and `/bots/$id/details` reopen their sheet when you come back through the rail.

   **Fix:** store `{ to: fullPath, params, search }` of the deepest non-pop-up match (`PANE_BOUNDARIES` already knows the families), or navigate with `href`. Add a test.

7. **Medium — `main.tsx:68-72,88-95` + `lib/bootstrap.ts:157-186`: transport-loss handling after mount does not stop the syncs.**
   - `stopSyncs` calls `collection.cleanup()`. In TanStack DB a cleaned-up collection restarts its sync on the next subscription or `preload()`. During the 1.5 s before reload the mounted `useLiveQuery`s, the route loaders and `ReadinessReporter` keep the collections live, so syncs reopen on the dead client: the backoff loop the spec wanted aborted.
   - `notify()` calls `toast.add` even when the loss happens during boot, before any `<Toaster>` exists, so nothing is shown.

   **Fix:** abort through the adapter (an `AbortSignal`, or `transport.state === "closed"` checked in `run()` before each reopen; the `data/db` adapter can take it) rather than `cleanup()`. Show the boot-time message through the `BootFailure` renderer. R1-T18's "close after mount → reload once" should also assert that no `changes()`/`snapshot()` call happens after close.

8. **Medium — `main.tsx:76,120,136`: unguarded boot steps.** `initI18n()`, `changeLanguage(resolveLanguage(prefs.language))` (a lazy locale chunk import) and the dev-hooks import are awaited outside `bootstrap()`'s typed failure handling. A rejected locale chunk leaves a blank window: no router, no `BootFailure`, no `window.ready({ barrier: "failed" })`, only main's swap timeout. **Fix:** fall back to `en-US` on `changeLanguage` failure and log it. Wrap the rest of `start()` so that any throw renders `BootFailure` and reports `failed` when the transport is open.

9. **Medium — `features/bots/bots-sidebar.tsx:92`, `features/routines/index.tsx:52`, `features/library/index.tsx:22`: a11y regression shipped.** Each has `role="list"` whose children are links (registry `Item` rendered as `<a>`) with no `listitem`. The run's `axe.json` records **36 critical `aria-required-children`** violations (bots, routines, library, both themes). `screenshots-next.mjs:315-317` only fails on `color-contrast`, so the run passes anyway. **Fix:** drop `role="list"`. `NavList.Root` is already a `<nav>`, and links in a nav need no list; the alternative is to give each row `role="listitem"` via a wrapper. Make the screenshot run fail on `critical`/`serious` violations, not only contrast.

10. **Medium — `axe.json` (a91d0d4c): the recorded run is not green.**
    - `-ui-section-alert-dialog-open-alert-dialog@1280-light` has a `color-contrast` violation. Per `screenshots-next.mjs:316` that run exits 1, so the contact sheet attached to the gate came from a failing run.
    - The combobox example has `aria-hidden-focus` on `nav` in both themes: the modal combobox hides a `nav` that contains focusable rail links. The shell's `<nav>` should be marked `inert` alongside `aria-hidden`, or the gallery example made non-modal.

    **Fix:** fix both and re-run. Record the run's exit status in `shots.json`.

11. **Medium — `scripts/check-legacy-renderer-diff.mjs:16,21` + root `package.json` `check`: the legacy-diff guard is vacuous.** The default base is `"rewrite/renderer"`. On that branch (or anything merged into it) `merge-base HEAD rewrite/renderer` is `HEAD`, so the script always reports nothing. It is also not in the root `check` pipeline (`check:knip-next` and `check:ui-registry` were added; `check:legacy-diff` was not). Run by hand against `73caf359`, today's diff passes: 11 locale files, 1646 → 1771 leaves, 0 changed or removed. **Fix:** default the base to `main` (or `$GITHUB_BASE_REF`), and add it to `check`.

12. **Medium — `src/main/dev/renderer-next.electron.test.ts`: R1-T11b under-proves its claims.**
    - `describe.skipIf(!runnable)` silently skips without a `VITE_UI_GALLERY` build or a display, so CI very likely never runs it.
    - `expect(started.every((t) => t.pane !== false))` passes when `pane` is `undefined`, i.e. when `transition.ready` never resolved or no pane animation existed.
    - It does not cover:
      - the pending-screen (slow loader) commit;
      - `nav-forward` (`/sessions/new` → `/sessions/<id>`) and browser-back `nav-back`, both named in §12;
      - the sidebar group animating for `nav-lateral` and settings types.

    **Fix:** assert `pane === true` (and a `.sidebar` animation where expected), add those cases, and fail loudly in CI when the build is absent (build it in `globalSetup`).

13. **Low — `styles/tokens.css:195-206`: reduced motion fades the old snapshot in.** `animation-name: vt-fade-in` is applied to `::view-transition-old(*)`, so the outgoing snapshot animates from opacity 0 to 1 and pops out at frame 0 (a flash). The same happens under `html[data-reduce-motion="on"]`. The spec's own CSS has the same mistake. Also, `prefs.motion.reduce === "off"` does not override the OS `@media (prefers-reduced-motion)` rule, although `useMotionPreference` says `"off"` wins. **Fix:** use `vt-fade-out` for `-old`, and scope the media rule with `html:not([data-reduce-motion="off"])`.

14. **Low — `features/shell/occlusion.ts:104-117`: the occlusion watcher observes `style`/`class` on the whole `body` subtree.** Every `motion` frame (sidebar width spring, scrim, floating sidebar) and every Tailwind class flip triggers `sync()`, which runs `querySelectorAll(OCCLUDER_SELECTOR)` plus a full re-measure. That is a per-frame document query during every shell animation. **Fix:** observe `childList` on `body` only (portals mount there). Per candidate, observe attributes on the candidate itself (a separate `MutationObserver` with a `subtree` limited to that element), or filter mutation records by `target.closest(OCCLUDER_SELECTOR)` before calling `sync()`.

15. **Low — `features/shell/rail.tsx:79-104`: pending timer not cleared on unmount.** The hover-intent timer has no unmount cleanup, so the rail unmounting (`_shell` → `_bare`) with a pending timer opens the floating sidebar later. The module-level `closeTimer` in `shell-store.ts:47-60` is shared across instances; the gallery renders several rails. **Fix:** clear the timer in an effect cleanup, and keep timers per instance.

16. **Low — `features/shell/top-bar.tsx:96-101`: Forward is always enabled.** Only Back reads `useCanGoBack()`. **Fix:** track `history.location.state.__TSR_index` against the history length (or keep a max index seen) to disable Forward.

17. **Low — `features/shell/top-bar.tsx:55`: literal inset.** `pr-[max(var(--titlebar-end),8px)]` hard-codes the inset; the other literals are listed in the visual section. **Fix:** use `max(var(--titlebar-end), var(--pane-inset))`.

18. **Low — `features/shell/sidebar-slot.tsx:48,63` + `layout.ts:68` duplicate the token widths.** `280` and `88` are repeated as JS numbers (`--sidebar-w`, `--sidebar-strip-w` exist in `tokens.css`). The motion `animate={{ width }}` animates a layout property every frame. Also, at pinned→strip the inner `style={{ width }}` jumps to 88 immediately while the outer column is still 280, so the strip sits left-aligned in a wide column for the spring's duration. **Fix:** read the widths from one TS constant module that also generates the CSS values (as `overlay-slots` does), and animate the inner content with the column (or clip), not snap.

19. **Low — `features/shell/shell-layout.tsx:124-125`, `app-root.tsx:83-94`: ⌘⌥B opens the area's first tab, not the last-used one.** Spec §7.9 says "tab ⇄ last tab for the area". The toggle logic is also duplicated in two places. **Fix:** keep `lastTabByArea` in `shellStore` and use one action for both.

20. **Low — `routes/_shell/(bots)/bots.$botId.tsx:42-45` (and `sessions.$sessionId.tsx:31-34`): a failed load throws `notFound()`.** The loader swallows the preload error (`ignoreLoadError`, whose stated intent is "a failed preload lets the route render") and then throws `notFound()` because `has()` is false. A transient DB error therefore shows "Not found" instead of the sidebar's Retry. **Fix:** throw `notFound()` only when `collection.status === "ready"`.

21. **Low — `features/shell/command-menu.tsx:38-39`: the always-mounted command menu defeats lazy loading.** It subscribes `useLiveQuery(collections.bots)` at the root, which starts the lazy `bots` sync on every launch and route, `/onboarding` and `/__ui` included. **Fix:** mount the menu's lists only while `open`.

22. **Low — `data/queries/invalidation.ts:46-51`: an extra round trip per chrome notice.** The `chrome` notice is written with `setQueryData` and then immediately invalidated, which refetches `window.chrome`. `followNotices` (`live.ts:22-34`) retries a FORBIDDEN stream every second forever while the transport is open (the WebSocket and tests). **Fix:** skip invalidation for `chrome`, and stop on a defined non-retryable error code.

23. **Low — `lib/window-chrome/use-titlebar-area.ts`: hook not used by the app.** It is only used by its test. §7.4 says the toast viewport offset uses it; the toast offset is not implemented. knip passes only because tests are entries. **Fix:** use it for the toast viewport (top-positioned toasts would sit under the traffic lights), or remove it from the spec.

24. **Low — `features/shell/shell-layout.tsx:56-63` + `index.ts:3`: dead export.** `PANE_VT` is exported from the shell only for the gallery now that the shell has no `<ViewTransition>`. **Fix:** move it to the gallery or to `lib/motion.ts`.

25. **Info — locales.** Additions only (verified per leaf: 1646 → 1771, 0 changed or removed, 11 files). 48 of 51 new `shell.*`/`*.empty.*`/`settings.pages.*` keys in `de-DE.json` are English copies (for example `shell.rail.label = "Areas"`). That is expected for new strings, but worth tracking for translation.

## Visual (screenshots a91d0d4c against the canvas description)

Measured in CSS px from the 2× captures.

The following match: rail 56, sidebar 280, title bar 40, pane inset 8 on the right and bottom, pane radius about 12, identity left edge equal to the pane's left edge at 1280/1100/900 (336 px), and the 900 drawer rect (left 536.5, width 356, top 48 = 40 + 8, bottom 792, right 892). The scrim starts at the toolbar's bottom edge, and the title bar stays unblurred and interactive.

V1. **Medium — the rail and title bar are not frosted.** `tokens.css:51-53` (`html { background-color: var(--sidebar) }`) and the shell root `bg-sidebar` (`shell-layout.tsx:141`) are opaque, so macOS `vibrancy: "under-window"` from the window-chrome slice can never show through. Both themes render flat `#fafafa`/`#1b1b1b` chrome. **Fix:** on macOS in overlay mode (and not under `prefers-reduced-transparency`), make `html` and the shell transparent and draw the chrome with `bg-sidebar/70` or similar. Keep the pane opaque `bg-background`. Gate this on `data-titlebar="overlay"` plus a platform attribute rather than a JS branch in layout.

V2. **Medium — in light theme the content pane barely separates from the chrome** (`bots-new@1280/1100/800-light`). The pane is `--background` (white) on `--sidebar` (oklch 0.985). The inset rounded pane, the canvas's main structural cue, is almost invisible: only a 1.5 % lightness step, no border, no shadow. Dark has a clear step (0.145 vs 0.205). **Fix:** add a hairline (`ring-1 ring-border/60` or `shadow-[0_0_0_1px_var(--border)]`) on the pane and the in-layout panel in light mode, or darken light `--sidebar` by role (for example 0.97). Do not hand-tune registry tokens; the ring on the molecule is the cleaner option.

V3. **Low — `sessions-review-prs-tab-terminal@1280`: pane and in-layout side panel meet with a 1–2 px seam.** Both have 12 px corners and there is no gutter, so they read as a crack rather than two cards. The rest of the shell is on an 8 px rhythm (`--pane-inset`). **Fix:** make the resize handle the 8 px gutter (a transparent 8 px hit area with a 1 px hover line), and account for it in the 1100 maths (pane + panel = 748).

V4. **Low — "Ready" status text appears next to non-entity titles** ("Make a bot Ready" on `/bots/new`, and on a session with no run). The status slot is fed a constant (`shell-layout.tsx:156`). **Fix:** let routes supply status through the slot, and render nothing when no entity is shown.

V5. **Low — sidebar row and rail pitch are off the 8 px grid.**
   - Sidebar: 34 px pitch (32 px row + `gap-0.5`), a 36 px header (`h-9`), and a drawer tab row at 12 px padding (`px-3 pt-3`).
   - Rail: 52 px item pitch (48 + `gap-1`), which the canvas `Rail` does not have.

   **Fix:** use a 32 px pitch (gap 0 with hover inset) or 40, and step the rail at 48 (or 56) with no extra gap.

V6. **Low — the bottom rail "Settings" glyph (`app-icon/index.tsx:56-62`) reads as a sun or brightness icon at 18 px,** not a gear, and sits directly above the avatar. In the screenshots it looks like a theme toggle. Verify it against the canvas gear path. If it is the canvas glyph, raise it with design.

V7. **Low — title-bar panel tabs (1280).** The `TabsList` pill (h-7 plus its padding) almost fills the 40 px bar. The active chip has a visible border that no other bar control has, and the tabs butt against the panel toggle with no separation. **Fix:** use a 24 px list height, the `ghost`/line tab variant used in the canvas `TopBar`, and 8 px before the toggle.

V8. **Info — 800 px (`bots-new@800`, `bots-chief-of-staff@800`).** The strip is correct (88 px column, 56 px tiles, active tile highlighted, New on top). Identity starts at 174 px against the pane's 144 px, which is the documented `min-width: min-content` fallback under the macOS reservation. Status is hidden. The ⋯ actions fold appears on the bot page. The strip's names are available only via native `title`, as spec'd, but not keyboard-discoverable. Consider a tooltip on focus.

V9. **Info — a floating sidebar capture is missing from the listed set.** Spec §10.2 step 5 (collapsed + rail hover) is not in the listed screenshots. Check that the run produced it.

## Confirmed correct

- **Transport lifecycle (`close-signal.ts`, `create-transport.ts`, `websocket.ts`, `memory.ts`):**
  - `state` flips before listeners run;
  - each registration fires exactly once;
  - a late listener fires on a microtask with the first reason;
  - `close()` is idempotent and `explicit`, while a remote close is `port-closed`.

  `bootstrap()` registers `onClose` immediately after `getTransport()` resolves. The mount guard on `transport.state` is in place. `fail()` skips `window.ready` on a closed port. The reload handler is idempotent, ignores `explicit`, and has a 10 s loop guard in `sessionStorage`.
- **Hotkeys:**
  - The platform comes only from `HotkeysProvider defaultOptions.hotkey`, with `preventDefault`/`stopPropagation` off, and the wrapper cancels only accepted events.
  - The rich-text guard covers `isContentEditable` and `[data-hotkeys="text"]`.
  - `@tanstack/react-hotkeys@0.12.1 useHotkey` syncs its callback and options on every render (`registration.callback = callback` in an effect), so there are no stale closures. `AppHotkeys` re-renders with area, search and floating state.
  - Escape is `enabled: floatingOpen`.
- **Occlusion watcher:**
  - It uses explicit slot lists, never a suffix match.
  - It measures toast roots, not the viewport.
  - It keeps a candidate through `data-ending-style`.
  - It ignores zero-size and invisible rects.
  - It has per-candidate `ResizeObserver`s, `resize` and capture `scroll` handling, and a rAF loop while animating.
  - Publishes are deduplicated.
  - `dispose()` disconnects everything and cancels the frame, and the effect runs once with cleanup.
- **Router:**
  - Masks use full paths.
  - `PANE_BOUNDARIES` is `satisfies Partial<Record<keyof FileRoutesById, string>>`.
  - `navIntent` travels in history state (`useAppNavigate`, `AppLink`), with a fresh id per navigation.
  - `@tanstack/react-router@1.170.40` pins `router-core@1.171.33` exactly, so the offer/commit internals the seam relies on are fixed.
  - `router-core` calls `startViewTransition` only on the commit path (`load-client.js:916`), so pending offers never start a document transition.
- **Readiness:** reported once per document (global symbol), for bare and shell routes, `failed` on the first `error`, and it unsubscribes.
- **Theme:**
  - `applyTheme` sets the class, `color-scheme` and `data-theme`, and the pre-paint rule keys off `:not([data-theme])`.
  - `accentForeground` picks by WCAG contrast.
  - `ThemeEffect` follows the media query only for `system`.
- **Build:**
  - Two `react()` instances in the right order, with `NEXT_MODULES` limited to JS/TS.
  - The router plugin runs before React.
  - `rolldownOptions.input` has both documents.
  - `index-next.html` CSP is verbatim equal to `index.html` and `renderer-csp.ts`.
  - The aliases are shared through `vite.shared.ts`.
- **Main:** `resolveRendererGeneration` honours the env var only when unpackaged. The mutation harness is gated on `!isPackaged && ABACUSBOT_DEV_HARNESS=1`, and ignores and logs malformed lines.
- **shadcn:** the registry snapshot exists (`apps/desktop/shadcn-registry/2026-09-30/manifest.json`), and `check:ui-registry` is in the root `check` pipeline. `components.json` points `ui` at `#next/ui` (`src/renderer-next/ui`, not `components/ui`).
- **Old renderer:** `src/renderer` changed only in the 11 locale files, additions only (verified per leaf).
- **Screenshot geometry checks** (identity/pane alignment, drawer rect, scrim top, band flips) exist and match the captures, apart from the axe gating in #9 and #10.
