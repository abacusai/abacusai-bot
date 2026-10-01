# Phase 4 sessions implementation

**Phase 4 is not acceptance complete.** The route/start/checkout/dock/resource paths work in the native smoke run, but several parity details and the full R4 matrix remain unfinished. Do not mark this slice done or use it as a cut-over gate.

Continuation base `fa80344a`, branch `codex-sessions`. Merge `96dd016d` includes the chat-kit and bots fixes through `d68076ce` and the subsequent incoming progress update. Continuation edits do not change main or agent source; the merge carries the incoming branch’s existing changes. The authorized main B-T4 amendment is test-only. Terminal protocol helpers now live in shared code; two legacy adapters are pinned compatibility shims.

## Implemented behavior

The original route, persisted creation stage machine, checkout-scoped chat/diffs, dock, terminal output pump, native browser presenter, files and agents remain. This continuation adds:

- A common sidebar action list for row and context menus, title rename, four recent sessions with shared relative stamps, a visible model-setup CTA, missing-workspace relocation/deletion, routine navigation, PR hover/checks, tasks and a successful-run ChangesCard.
- Four dock edge drop zones and tab reorder destinations, duplicate-title ordinals, shell selection, terminal links opening embedded browser tabs, DEC mouse reporting through shared encoders, terminal-generation reattachment, ordered bounded UTF-8 writes and an empty-snapshot guard for Ghostty’s zero-byte allocator. Default cell colors update in place with the document theme; the cursor follows the foreground token.
- Embedded bots browser integration through `registerBrowserOpen`. Registration stays mounted when another panel is selected. Browser profiles, zoom, devtools, site-data clearing, materialization Retry, stale-result guards and a 500 ms capture deadline.
- Folder Trash confirmation, file tree menus including Rename, drag moves, git decorations, and the incoming shared `components/file-preview` PPTX deck viewer.
- Device controls, a five-second first-frame watchdog, H264 decoder reopen after queue overflow, ten-second hidden grace, bottom-anchored simulator crop, source retries, a permission-denied latch and screenshot fallback. Simulator capture boots first; failed playback stops media tracks.
- A merged needs-you group, notification-click navigation and keyless active-session/bot preview consumption. Completion notices wait for table snapshots; the shared resume cursor advances only after buffered listeners settle.
- Real resource gallery components, a 53-entry legacy translation keymap, and native-layout accessibility measurements. Light-mode contrast and tablist semantics found by axe were corrected.

## Merge resolution

| Conflicted file | Combined behavior |
|---|---|
| `features/bots/watcher.tsx` | Incoming snapshot buffering and bot/routine attribution; shared document run-finished subscription. |
| `features/chat/index.ts` | Incoming lazy gallery/runtime exports and the sessions public kit APIs. |
| `features/chat/kit/context.tsx` | Incoming dictation state and sessions composer modes, blocked state, history and durable envelope callback. |
| `features/chat/kit/tools/tool-line.tsx` | Incoming mounted tool windows/skins/first-seen bookkeeping and scoped sessions subagent diff resolution. |
| `features/shell/hotkeys.tsx` | Incoming shared `useAppHotkey` and sessions action IDs/terminal chords; action dispatch lives in the shared hotkey module. |
| `features/shell/index.ts` | Incoming URL registry plus sessions dock/presenter exports; no duplicate hotkey export. |
| `routeTree.gen.ts` | Regenerated through the router plugin. Review is a sibling redirect; diff remains masked under the session. Its snapshot was updated. |
| `routes/_shell/(sessions)/sessions.$sessionId.tsx` | Sessions composition using the incoming RouterContext chat runtime. |
| `test-support/app-harness.tsx` | Incoming browser events plus sessions browser/runtime/files test controls. |
| `docs/rewrite/PROGRESS.md` | Incoming version, with only the phase-4 row updated. |

## Validation

Prerequisites built: connectors, agent plus `write-runtime-package.js`, updater. Install used `pnpm install --pm-on-fail=ignore`. Checks use direct binaries; hooks still report that lefthook is absent.

The first continuation full renderer-next/main/shared run had **3,859 passed, one stale route snapshot failed, seven todo**, across 379 passed files, one failed and one skipped. The corrected route snapshot passes all 17 router tests. Final gates and native results are recorded below.

The native driver uses an isolated canonical-path profile, real main and PTY, a fake model provider and a loopback HTML server. It now tests hidden unbroken 5 MB output from a quiet foreground producer (avoiding interactive-shell resize redraws), same-document output reconnect, retained-tail document reload, native browser capture pixels and Retina-scaled dimensions, guarded local HTML rendering, worktree Keep, masked diff and live deletion. Browser pixel assertions allow an RGB tolerance of two for macOS color management. It records real-layout axe including color contrast, rather than disabling that rule as in jsdom.

## Change requests and unfinished work

1. **Done:** B-T4 expects checkout identity `ws-1:primary`; main test-only amendment.
2. **Other owner / absent contract:** joined concurrent `agent.start` readiness. The renderer uses the existing contract; no assumption that the follow-up has landed.
3. **Other owner / absent contract:** settings exec-backend event. Picker applies returned state; no invented event for cross-window invalidation.
4. **Done implementation:** shared terminal key/mouse helpers and one-line legacy wrappers with exact-commit allow-list pins. Native platform-byte coverage remains partial.
5. **Implemented:** session action menus, title rename, collapsed recent list, no-model CTA, workspace recovery pane, PR hover/checks, tasks, ChangesCard and routine navigation. Workspace menus, search highlighting and folder drop are now implemented. The separately committed kit permission-action slot links only to an identified terminal already in this dock. ChangesCard now joins the latest outcome’s written paths to git stats; regression tests exclude unrelated files, cleared changes, failed runs and unavailable history fences. **Remaining:** complete UI proof.
6. **Implemented:** drop/reorder zones, shell picker, URL links, DEC mouse, generation reattach. Native retained-tail reload has the same generation/offset and retained marker. **Remaining:** exact full-buffer comparison, real pointer-drag/menu-equivalence matrix, multiple PTY/promotion cases, Windows/ConPTY key-byte proof and repaint-disabled checksum control.
7. **Implemented:** bots presenter/URL registry migration, profile/zoom/devtools/site-data controls, Retry and capture deadline. Native viewport dimensions, loopback pixels and guarded local HTML are measured. **Remaining:** native two-owner/zoom/occlusion matrix and local-file escape/security UI cases.
8. **Implemented:** folder confirmation, menus/drag/git marks, shared PPTX viewer, device controls/watchdog/overflow/grace/crop/retries/latch/snapshots. **Remaining:** complete file mutation/viewer matrix and real device permission, reconnect, hidden-grace and controls proof; no physical device was available.
9. **Implemented:** active session and bot keyless routing, visible duplicate identity, merged needs-you, notification navigation. Start-draft resources now consume keyless events in draft scope; the foreign-scope regression passes. **Remaining:** complete background/keyless/de-duplication integration matrix.
10. **Implemented:** resource fixtures, translation reuse keymap and native axe/contrast checks. **Remaining:** all gallery board states/overlays, motion/transition-count acceptance and the dedicated R4 cases below. Unmatched new locale copy retains English fallback.

## R4 status

Partial evidence does not mean the entire acceptance row passed. Browser placeholder geometry is not native geometry; screenshots showing terminal output are not a checksum control. Windows/ConPTY was not available.

| ID | Status and evidence |
|---|---|
| R4-T1 | Partial / not fully covered: Generated route snapshot, native masked dock mounting and real-session route snapshot after correcting parameter-change hydration; full reload/back/scroll/draft matrix pending. |
| R4-T2 | Partial / not fully covered: Existing nav-type suite runs; dedicated session matrix pending. |
| R4-T3 | Partial / not fully covered: Loaders await tables and avoid hydrate on preload; delayed-snapshot/error Retry tests pending. |
| R4-T4 | Partial / not fully covered: Native live deletion; delayed unknown/editor/owned redirect tests pending. |
| R4-T5 | Partial / not fully covered: Source invalidation implemented; per-source tests pending; exec event missing from contract. |
| R4-T6 | Partial / not fully covered: Checkout selectors implemented; three-checkout chip/decoration test pending. |
| R4-T7 | Partial / not fully covered: Real creation exercised; complete actions/prefs rollback matrix pending. |
| R4-T8 | Partial / not fully covered: Three lifecycle tests; readiness-joined start proof outside renderer scope. |
| R4-T9 | Partial / not fully covered: Attention precedence test; unread/run integration matrix pending. |
| R4-T10 | Partial / not fully covered: Common seven-action row/context menu, merged needs-you and relative stamps; Workspace menus/recovery, highlighted search and folder drop implemented; complete action/prefs rollback matrix pending. |
| R4-T11 | Partial / not fully covered: Structure and traversal guards; full AST forbidden-error-pattern checks pending. |
| R4-T12 | Partial / not fully covered: Stage reconciliation unit test and native new worktree; picker/reload/detach cases pending. |
| R4-T13 | Partial / not fully covered: Caller IDs and one native first admission; acceptance-before-clear reload not exercised. |
| R4-T14 | Partial / not fully covered: Tray uses main APIs; Docker/local actual first-command test not run. |
| R4-T15 | Partial / not fully covered: Reducer/bands tests; pixel restore/back-forward matrix pending. |
| R4-T16 | Partial / not fully covered: Tab persistence exists; promotion/existence/eviction dedicated tests pending. |
| R4-T17 | Partial / not fully covered: Output append/replacement test; resync/retired/exit UI matrix pending. |
| R4-T18 | Partial / not fully covered: Capture deadline and equivalent-lease candidate regression pass; bots URL integration covered; delayed stale/profile/overlay matrix pending. |
| R4-T19 | Partial / not fully covered: Folder confirmation, inline/menu rename, drag moves and git marks; complete file mutation matrix pending. |
| R4-T20 | Partial / not fully covered: Actual canvas background pixels match both themes; computed terminal-default/diff-add/diff-delete contrast passes at two widths. ANSI/explicit-color matrix and repaint-disabled checksum control remain pending. |
| R4-T21 | Partial / not fully covered: Four-edge/reorder reducer tests and semantic dock toolbar; real pointer drag/menu equivalence pending. |
| R4-T22 | Partial / not fully covered: 53-entry translation keymap, locale guard and existing starter byte identity; full copy audit pending. |
| R4-T23 | Partial / not fully covered: Four jsdom axe cases plus native-layout contrast/axe across two widths and schemes; all gallery states/overlays pending. |
| R4-T24 | Partial / not fully covered: Incoming PPTX deck viewer reused through FilePreview; full actual-deck session acceptance pending. |
| R4-T25 | Partial / not fully covered: Native Keep, scoped fingerprints and successful-run ChangesCard; Latest-outcome message fences and written-path join tested; full scopes/Undo UI matrix pending. |
| R4-T26 | Partial / not fully covered: Real chat navigation records one nav-lateral transition; session-view split/full transition-count matrix pending. |
| R4-T27 | Partial / not fully covered: Reduced-motion global rules; dedicated motion tests absent. |
| R4-T28 | Partial / not fully covered: Import structure scan passes; stronger complete AST checks pending. |
| R4-T29 | Partial / not fully covered: macOS hidden unbroken 5 MB, no-replay reconnect and quiet retained-tail document reload pass (generation/offset/marker). Exact full-buffer equality, multiple PTYs/promotion/resize/Windows remain pending. |
| R4-T30 | Partial / not fully covered: Real native loopback pixels and scaled viewport dimensions, guarded checkout HTML pixels; zoom/occlusion/two-owner/escape matrix pending. |
| R4-T31 | Pass inventory: Inventory test: all 111 rows with targets and explicit statuses. Does not claim green parity. |
| R4-T32 | Partial / not fully covered: SPS/keyframe, first-frame watchdog/disposal, queue-overflow decoder reopen and crop tests; physical-device lifecycle matrix pending. |
| R4-T33 | Partial / not fully covered: Checkout suites and native worktree Keep pass; B-T4 expectation corrected. Renderer mutation isolation matrix pending. |
| R4-T34 | Partial / not fully covered: Native first admission/PTY/browser/local HTML/Keep/masked diff/delete; supervised permissions/ChangesCard/legacy comparison pending. |
| R4-T35 | Partial / not fully covered: Shared refresh-before-respond connector sequence reused; session suspended-turn case missing. |
| R4-T36 | Partial / not fully covered: Bots embedded URL registry integration, keyless active session/bot and duplicate labels; Start draft-scope URL regression passes; background full matrix pending. |
| R4-T37 | Partial / not fully covered: Bounded historical resolver exists; migrated/paging/reload dedicated tests missing. |
| R4-T38 | Partial / not fully covered: Authoritative main outcome suites run; sessions-specific complete scenario test absent. |
| R4-T39 | Partial / not fully covered: Shared key/mouse helpers and pinned compatibility wrappers; existing legacy mouse tests pass. Native Electron key-byte/Windows matrix pending. |

## Per-item inventory

All §2 rows are mirrored in `features/sessions/parity.ts`, each naming an existing destination. Partial means implementation exists but its full parity claim has not been demonstrated. S101 is retired and S102 explicitly deferred. No all-green claim is made.

| Item | Status | Required destination/behavior |
|---|---|---|
| S1 | Partial | `/sessions/new` → `SessionStartPage` (§8); the workspace comes from `?workspace=` or `prefs.lastPickedWorkspaceId` (§8.3) |
| S2 | Partial | loader: awaits `sessions`/`workspaces` readiness, row or `notFound()`; on enter (not preload) unread cleared, `session.load()` (§5.3); every file/git call carries the session's checkout (F5) |
| S3 | Partial | route `pendingComponent`: transcript skeleton (foundation `defaultPendingMs` 150) |
| S4 | Partial | `notFoundComponent` "This session was deleted" + New session (§5.5) |
| S5 | Partial | `/` → `/bots/new` (foundation); side panel state is `?tab=` only |
| S6 | Partial | `<AppLink to="/sessions/$sessionId">` |
| S7 | Partial | `useParams({ strict: false }).sessionId` |
| S8 | Partial | `/sessions/$sessionId/review` → `?tab=changes` redirect (F3); `/sessions/$sessionId/diff` masked full-diff dialog (§5.4) |
| S9 | Partial | one sidebar for the Sessions rail item, header "Sessions" + Search + New (canvas `SessionsSidebar`) |
| S10 | Partial | same filter; grouped by workspace (foundation §7.3; canvas) (§7.2) |
| S11 | Partial | inside a workspace group rows are ordered by `updatedAt` desc with no bucket headers; the search results and the collapsed-sidebar history show a relative stamp (`chatStamp`, 03 P17) |
| S12 | Partial | "Pinned" group above the workspaces (`prefs.pinned.sessionIds`) |
| S13 | Partial | 32 px row (34 in the tree board): status dot, label, trailing chip (running / needs you / diff / unread); pin shown by group (§7.3) |
| S14 | Partial | running dot + "running", "needs you" chip, error (§6.6) |
| S15 | Partial | same (`scrollIntoView({ block: "nearest" })`) |
| S16 | Partial | link to `/sessions/$sessionId`, `transition: "nav-lateral"` |
| S17 | Partial | one item list for both menus: Rename, Pin/Unpin, Mark as unread, Open beside this chat, New worktree from here, Copy session ID, Delete session (§7.4) |
| S18 | Partial | registry `AlertDialog`, same copy; `agent.stop` then `sessionsCollection.delete` (§6.4); inline error |
| S19 | Partial | canvas: "No sessions yet" / "Start one with ⌘N, or drop a folder here." + drop zone (§7.6) |
| S20 | Partial | Search field with highlighted matches and "workspace · branch" sub-line (canvas) (§7.1) |
| S21 | Partial | Workspace group: collapsible (`prefs.workspaceExpanded`), count, branch, missing state, row menu (§7.5) |
| S22 | Partial | inline rename from the row menu and the title bar (§7.4, §9.1); automatic title stays in the kit (02 §8.3) |
| S23 | Partial | `prefs.pinned.sessionIds` (spec 00 C.4 imports it) |
| S24 | Partial | `sessionsUnreadStore` over `ai.runFinished` (`success`/`error`; a Stop marks nothing) (§6.7) |
| S25 | Partial | same rule on `browser.events runtime-materialized` (§6.7, §12.6) |
| S26 | Partial | foundation `Mod+B` |
| S27 | Partial | canvas `Main`: "What should we build?", 120 px two-row box ("Describe the work. Type @ for files, / for skills"), context tray under it (§8.1) |
| S28 | Partial | tray workspace button → `WorkspacePicker` popover: same rows, search, Default workspace, Add a folder (§8.3) |
| S29 | Partial | `system.dialog.openFolder()` → `workspaces.add({ path })`; typed errors (§6.5); picks it |
| S30 | Partial | same order in the start page's loader (§8.3); `prefs.lastPickedWorkspaceId` |
| S31 | Partial | canvas starter cards (3 × 2, "Try one of these", Shuffle); same fill-and-focus (§8.4) |
| S32 | Partial | sidebar collapsed: "Pick up where you left off in {workspace}" list of 4 recent sessions beside starters (canvas `MainCollapsed`) (§8.5) |
| S33 | Partial | tray worktree button (canvas "New worktree" / "No worktree") with the same options (§8.3) |
| S34 | Partial | kit `ModeChip` (02 §8.2); Auto hidden without sandbox support; default from `prefs.defaultMode`, written on change (§9.3) |
| S35 | Partial | kit `ModelChip` with the groups of 03 §13.1 (shared builder); same resolution; "Compact UI" retired (§9.3) |
| S36 | Partial | composer `blocked` reason "no-model" + the same CTA (§26.2 kit amendment) |
| S37 | Partial | `startSession()` (§8.6): client id, insert, worktree, `promoteScope` for terminal and browser, navigate, first message submitted by the thread |
| S38 | Partial | kit attachments with `attachmentsBase` = workspace or worktree path (02 §8.6) |
| S39 | Partial | start page resolves a workspace before enabling Send; missing folder → the workspace-missing state (§17.2) |
| S40 | Partial | `TopBarSlot identity`: "{workspace} /" (muted) + label (500), click to rename (§9.1) |
| S41 | Partial | New session (`Mod+N`, foundation), panel toggle (foundation), tab strip when open (§10.1); terminal toggle retired (F16) |
| S42 | Partial | `ensureAgentStarted(row)` on enter, same schedule; failure → thread banner with Retry (not a toast, R4-T8) (§9.2) |
| S43 | Partial | after a successful start, once (§9.2) |
| S44 | Partial | `sessionsCollection.update({model})` + `agent.setModel` when running + `settings.setDefaultModel` (§9.3); same toast |
| S45 | Partial | kit `ModeChip` (02 §8.2) + `prefs.defaultMode` write |
| S46 | Partial | kit `ChatView skin="session"` (02 §5, §10); pending first message = outbox (02 §3.7) |
| S47 | Partial | kit queue slot (02 §8.5) |
| S48 | Partial | kit Stop = `ai.cancel` (02 §4.5) |
| S49 | Partial | kit admission outcomes (02 §3.7, §4.6) |
| S50 | Partial | kit `deriveSessionTitle` (02 §8.3) |
| S51 | Partial | kit `Notice`, `ErrorCard` (02 §5.6) |
| S52 | Partial | the feedback popover of 03 §11.3, enabled for `skin="session"` too (§26.2) |
| S53 | Partial | kit (03 P65) |
| S54 | Partial | kit composer: ArrowUp walks history when the queue is empty, from a route-supplied `history` source over `settings.promptHistory.*` (§26.2) |
| S55 | Partial | kit `mentions` from this route: `files.search` (§9.3) |
| S56 | Partial | tray "Tasks {done} of {n}" opening the plan popover (§9.4) |
| S57 | Partial | tray branch button → `BranchPicker` popover, same rules and copy (§14.2) |
| S58 | Partial | tray PR item + hover card, `git.prInfo` with `refetchInterval: 60_000` and focus refetch (§14.3) |
| S59 | Partial | kit permission tray (02 §6); auto-resolve on a more permissive mode is main/agent behaviour (00-agent-agui §3.5) |
| S60 | Partial | `features/sessions/notify.ts` via `system.notify` + `system.events notification-clicked` (§19.2) |
| S61 | Partial | `BrowserAskHost` mounted by the shell, `browser.events` + `browser.permissions.respond` (§12.7) |
| S62 | Partial | read-only composer banner (canvas `ReadOnlyStates` "A session whose folder is gone") (§17.3) |
| S63 | Partial | canvas `SessionWorkspaceMissing` pane state with Choose folder / Delete workspace, and the send-blocked composer line (§17.2); dismissal retired (the state is inline, not a dialog) |
| S64 | Partial | read-only session skin with the routines banner and "Talk to the routine" (phase 5 route) (§17.3) |
| S65 | Partial | the shared `components/connector-request-card/` of 03 r3 §11.4 in the session's `slots.banner`, fed by `connectors.events({ conversationKey })` (snapshot of pending asks first), field flows via `connectors.submitFields`, decline, `connectors.respond` releasing the suspended turn (§9.3) |
| S66 | Partial | kit composer drop (02 §8.6) over the whole thread pane (the route forwards `onDrop`) |
| S67 | Partial | kit `DiffExpander` (02 §5.4); "Open full diff" → `/sessions/$id/diff` (§5.4) |
| S68 | Partial | kit `SubagentCard` + Agents tab detail (§15) |
| S69 | Partial | `ChangesCard` in `RunTail`: "{n} files changed +a −d", Review changes (canvas `SessionRunning`, `SessionReview`) (§9.5) |
| S70 | Partial | `panelTabsStore` per conversation key (open tabs) + `?tab=` (active) (§10.2); same neighbour rule |
| S71 | Partial | "Add a tab" menu, same items and rules; Changes added when there are changes (§10.1) |
| S72 | Partial | no empty panel: the strip exists only while a tab is open (user decision); the toggle opens the last tab or the menu (§10.1) |
| S73 | Partial | same: `<Activity mode>` per tab, browser presented only when visible (§10.5) |
| S74 | Partial | same (§10.1) |
| S75 | Partial | chat pane default 480 (canvas), min 360; panel min 360; persisted in `prefs.panes` (§10.3) |
| S76 | Partial | below 1100 the pane folds into one tab strip with Chat first (F4) |
| S77 | Partial | `preview:<key>` tabs, same cap and eviction (§13.3) |
| S78 | Partial | `@tanstack/highlight` viewer + "Open in editor" (§13.3) |
| S79 | Partial | same viewers (`components/file-preview/`) (§13.3) |
| S80 | Partial | a guarded **local-file runtime** tab on the native surface (F8, §12.8, main amendment §26.4 f) |
| S81 | Partial | same engine and options; theme from tokens for both schemes (§11.2) |
| S82 | Partial | open a Browser tab (§11.2) |
| S83 | Partial | ported verbatim with its tests (§11.4) |
| S84 | Partial | ported verbatim (§11.4) |
| S85 | Partial | one side-panel tab per terminal, same id scheme and labels (§11.1) |
| S86 | Partial | "New terminal" split button with the shell menu (§11.1) |
| S87 | Partial | tab close = kill, no confirmation (parity); switching away = `hide`; exit → the tab shows "Process exited with code {n}" for 2 s, then closes (§11.1) |
| S88 | Partial | same (`terminal-registry.ts`) (§11.3) |
| S89 | Partial | `terminal.output` with `fromOffset`; `snapshot` append vs replace by `from` (§11.3) |
| S90 | Partial | same, pacer-debounced 40 ms (§11.3) |
| S91 | Partial | same (§11.3) |
| S92 | Partial | `terminal.promoteScope` + re-key; `retired {superseded}` ends the old iterator (§11.1) |
| S93 | Partial | same (§11.1) |
| S94 | Partial | same contract (§12.2–§12.4) |
| S95 | Partial | same (`normalizeAddress` ported with tests) (§12.5) |
| S96 | Partial | same items (§12.5) |
| S97 | Partial | same (§12.5) |
| S98 | Partial | foundation occlusion watcher + intersect test (§12.4) |
| S99 | Partial | same on `browser.events` (§12.1, §12.6) |
| S100 | Partial | `browser.runtime.close(lease)` (§12.3) |
| S101 | Retired | — |
| S102 | Deferred | "The agent is browsing. Take over / I'm done" bar (canvas `SessionBrowser`) |
| S103 | Partial | same library and behaviour; canvas "Filter files" field and "M" marks (§13.1) |
| S104 | Partial | same (§13.2) |
| S105 | Partial | same + Open in editor (§13.2) |
| S106 | Partial | same; `files.events tree-root-changed` + `gitState` (§13.1) |
| S107 | Partial | Changes tab: changed files, per-file diff, Keep, Undo (with §26.4), change navigation (canvas `SessionReview`) (§14) |
| S108 | Partial | Agents tab list + detail (canvas `SubAgents`) (§15) |
| S109 | Partial | Device tab, same controls (§16) |
| S110 | Partial | ported (F9) (§16.2), fallback chain included |
| S111 | Partial | `SessionPreviewBridge` mounted once by the shell (§13.4) |

## Screenshots

16 real-route PNGs: sidebar/session, start, Changes split view and terminal; 1280×800 and 900×800; light/dark. Reproduce with `e2e/sessions-real.mjs` after `VITE_UI_GALLERY=1 vite build` without DB fixtures. Files and manifest are beside this report in `04-sessions-screenshots/`. Representative Changes/start/terminal images were visually inspected. They show the current implementation, not approved canvas parity.

## Commits

`git log --oneline 33301dc9..HEAD` lists Chat public API amendments, bots shared service extraction, shell override/hotkeys/presenter/folding, sessions data/runtime/composition, validation and report commits. Hooks reported `Can't find lefthook in PATH`; checks were called directly.

## Continuation gate results

The acceptance status above remains partial. Automated gates are green; they do not replace the missing R4 scenarios.

| Gate | Final result |
|---|---|
| Desktop `tsc -b` | Pass. |
| Renderer-next + main + shared, CI with two workers | **3,868 passed, 7 todo; 384 files passed, 1 skipped** (159.30 s). |
| Terminal follow-up after the empty-write fix | **5 passed in 3 files**; UTF-8 boundaries, empty reconnect and awaited cursor advancement. |
| Main-serial, `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1` | **293 passed in 10 files** (128.40 s). |
| Native sessions driver | **10 checks passed**; 16 PNGs, actual terminal canvas pixels, native browser/local HTML pixels. |
| Real-layout axe | **12 runs, zero violations**; sidebar/start/changes, 1280/900, light/dark, color-contrast enabled. Coverage follows the responsive layout; the narrow folded dock is not a diff-overlay audit. |
| Computed colors | Terminal default **19.80/18.97**, diff add **8.31/11.46**, diff delete **6.75/8.56** (light/dark), both widths; all exceed 4.5:1. |
| Root oxlint | Pass; seven existing legacy hook warnings, no errors. |
| Root oxfmt | Pass. |
| Registry | **41 files** match. |
| Legacy diff | Pass; **19 additions/authorized pinned adapters**. |
| Knip-next | Pass; three existing configuration hints. |
| Locales | **2,384 keys in each of 11 locales**, no missing/extra keys or unresolved `t()` calls. |

Earlier full runs exposed a stale generated route snapshot and timing failures under heavy parallel load. An initial main-serial run had four failures: one stalled Electron scrollback child and three chat cases. The session loader now hydrates parameter changes even when Router labels the navigation `stay`; the final full serial run above is green. No continuation main-source edits were made.

Visual inspection caught terminal WASM errors missed by the original text-buffer probe. The final driver rejects both `RangeError` and `RuntimeError`. The fix skips empty reconnect writes, bounds/yields large UTF-8 copies, and awaits each write before advancing the cursor. The default-color adapter targets the installed Ghostty 0.4 render-line shape; its RGB matching cannot distinguish an explicitly chosen color identical to an original default. That color-identity case and the complete ANSI palette remain open under R4-T20.

[Native results](04-sessions-native-results.json) and [screenshot manifest](04-sessions-screenshots/manifest.json) record the passing measurements. The `.build` directory is generated and left untracked.

Continuation commits through the final terminal fix (first-parent order):

```text
96dd016d Merge rewrite/renderer into sessions, preserving chat and bots fixes
ef5157ed refactor(terminal): share protocol helpers and legacy adapters
47df9764 chore(terminal): pin authorized legacy compatibility shims
f70a7f64 feat(browser): add runtime controls, materialization retry and capture deadline
30192543 fix(bots): open URL deliverables in the embedded session browser
5c7a9161 feat(sessions): finish navigation, tray actions and resource dock controls
4e072fab feat(files): add tree menus, git decorations and folder trash confirmation
26c52535 feat(device): recover streams and add controls and snapshot fallback
33dbdf33 fix(bots): retain browser routing while another panel is selected
f86fe832 fix(sessions): identify duplicate tabs and reuse legacy translations
41b60833 fix(notices): acknowledge completion only after buffered attribution
dc8c5668 feat(sessions): expose model setup and replace resource gallery placeholders
6bfa17fd fix(sessions): type gallery reader and latch simulator capture permission
73b76320 fix(sessions): expose file rename and preserve relative recent stamps
1ca6ce99 fix(browser): retain native candidate across equivalent runtime leases
8bf736c8 fix(device): reopen overloaded decoder behind a keyframe barrier
e3dbdd44 fix(sessions): address real-layout contrast and tablist semantics
b082308c feat(chat): expose route-owned permission card actions for sessions
4aaa52be feat(sessions): add workspace recovery menus and scoped permission terminal links
71ab9b99 feat(sessions): route start previews through the draft resource scope
8cb62976 fix(sessions): hydrate parameter changes before route snapshots and keep reviewed text readable
4f60b0d1 fix(sessions): attribute ChangesCard to the latest completed run
0c55eb4c fix(terminal): resolve token colors and follow document theme changes
7ab67a86 fix(terminal): bound ordered replays and skip empty WASM writes
```

Evidence commit `be58b6c6` contains the native driver, updated screenshots and results JSON. The following report commit updates this document and only the phase-4 progress row.

Implementation commits before this report:

```text
c5ae9883 Chat: admit durable session submission envelopes with caller identities
5ed24a38 Shell: add session dock override, action dispatch and single native presenter
264e0e7c Bots: share the document run-finished subscription with other areas
d57917f2 Chat: expose draft composer, mode availability and prompt history bindings
fdff47f6 Bots: extract shared connector request flow and model groups
aacebe9d Sessions: persist checkout-aware creation stages and bounded dock state
084df60a Chat: expose subagent detail and historical tool diffs for sessions
f04d2262 Bots: share the document sound player with sessions
6012fdbc Shell: fold sessions sidebar for resource tab references
15362fcb Shell: expose action bindings to session dock routes
dec09a01 Shell: dispatch terminal close by action and accept keyless previews
0508f1f6 Sessions: add Ghostty terminal views and resumable output pumps
4851426b Sessions: add checkout files, scoped changes and runtime surfaces
6275ca8f Shell: track native browser ownership and hide stale presentations
bd051758 Chat: accept the route default mode and disable blocked sends
7167c319 fix(bots): keep shared notifier preferences current
a9d18cf8 refactor(shell): expose only used presenter contracts
ed1c3371 feat(sessions): compose start, dock and checkout-aware resource views
2dee3d31 fix(chat): apply first-send callbacks to durable admissions
39d342de test(shell): separate session dock from generic panel expectations
236ea88a fix(sessions): restore dock pixels and finish composer and agents bindings
64f6cdce test(sessions): scan forbidden dependency imports without matching parity prose
e4634221 test(sessions): record native worktree and hidden PTY smoke with screenshots
```
