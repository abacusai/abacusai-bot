# Phase 3 bots implementation fixes r1

2026-10-01. Review: [03-bots.impl-codex-r1.md](03-bots.impl-codex-r1.md); contract: [03-bots.md](../03-bots.md), r3. Worktree branch `worktree-agent-a2f588ede14ebf525`, merged `rewrite/renderer` first (`2beb2583`, fast-forward). All findings addressed. Full acceptance variants still lacking evidence are recorded in the [implementation report](../../reports/03-bots-implementation.md#fix-pass-against-spec-r3--2026-10-01).

Paths below are relative to `apps/desktop/src/renderer-next` unless specified. Every regression below detects removal of its fix: mutation runs 1–14 and 16 plus title all exit nonzero, with restored files afterward; #15 checks native computed styles and a live border-removal mutation. Artifacts: `.build/bots-regression-mutations.json`, `.build/bots-mutations`, `.build/bots-boundaries.json`.

| Finding | Status and change | Regression evidence | Commit |
|---|---|---|---|
| 1 | Fixed. Admission waits for configured mode; pending query has no sendable composer. Normal fallback replaces YOLO. | Mounted `readiness.test.tsx`: delayed default-mode query, then actual outgoing send uses its mode. | `489f96d9` |
| 2 | Fixed. Watcher awaits bots/routines snapshots, buffers notices and advances resume ID after delivery; retry can recover preload rejection. | Mounted delayed watcher in `readiness.test.tsx` retains unread from a terminal notice received before readiness. | `489f96d9` |
| 3 | Fixed. Schedule and enabled provenance merge independently against the live routine. Remote form sync advances untouched leaf baselines. | `form/form.test.tsx`: pause-only and schedule-only concurrent edits preserve remote changes; mutation restores whole-object overwrite and fails. | `7280b984`, `489f96d9` |
| 4 | Fixed. Bot-specific part whitelist runs in the actual ChatView while retaining tool permission scaffolding. WorkedThrough removed for bots. | `chat/transcript.test.tsx`: mixed spoken/thinking/migrated-search/steps render only spoken content. | `5e187653` (minimal chat commit) |
| 5 | Fixed. Accessory picker enabled; create/update fields include avatarAccessory in both collection implementations. | `form/form.test.tsx` create/update collection round-trip and `form/editor.test.tsx` mounted picker/save. | `7280b984` |
| 6 | Fixed. URL retained through shell session request registry. Until phase 4 owns the surface, placeholder displays URL and offers Open in external browser. | Routed automatic URL deliverable in `readiness.test.tsx` verifies destination, external action and session isolation; shell registry handler lifecycle test. | `f9762e0d` (shell), `489f96d9` (bots) |
| 7 | Fixed. Ported read-only visual PPTX slides, paragraphs, shapes, tables, images, authored geometry and notes. | `components/file-preview/file-preview.test.tsx`: image-only slide remains visible at authored coordinates with deck background; outlines-only mutation fails. | `73ba2a70` |
| 8 | Fixed. PDF/HTML use the host materializeFile boundary with viewed session conversationKey and hostRoot, then load its validated local URL. | Routed guest PDF/HTML in `readiness.test.tsx` + component resolver tests; non-file URL rejected. Raw guest URL mutation fails. | `73ba2a70`, `489f96d9`, `78435c9c` |
| 9 | Fixed. Only active presets validate time; active errors displayed. Switching Off refreshes validation to clear stale field errors. | Mounted `form/editor.test.tsx`: Daily → empty time → visible error → Off → save. | `7280b984`, `489f96d9` |
| 10 | Fixed. Successful reaction duplicates and streaming trailing emoji filtered per text part in live and migrated messages. | `chat/transcript.test.tsx` actual transcript plus live/migrated mixed-parts cases. | `5e187653` |
| 11 | Fixed. Back to files clears search.preview on sender/check-in route slots. | Mounted sender preview in `readiness.test.tsx`: Back restores file list and removes preview. | `489f96d9` |
| 12 | Fixed. Replaced vacuous remote-sync coverage with actual editor. Untouched leaves refresh without validation/touch changes. | `form/editor.test.tsx`: successive remote updates, blur without edit, preserved user persona, outgoing patch only persona; removing effect fails. | `489f96d9` |
| 13 | Fixed. Loader coverage starts with delayed cold snapshots and exercises mounted hover-then-click. | `data/data.test.ts` delayed bots/sessions/routines; `readiness.test.tsx` open/hydrate blockers and skeleton. Removing awaits fails. | `489f96d9` |
| 14 | Fixed. Tests mark actual motion model-value spans and assert all four panel/composer states. Native recording at both widths. | `interactions.test.tsx` catches absent layoutId; `e2e/bots-real.mjs` asserts one visible value before/after focus, saves 23 screencast frames at each 1280/1000 width. | `489f96d9`, `fa6b40b8` |
| 15 | Fixed verification. Browser reads/composites actual light borders and dark fills for real unread dot, selected shape, ten swatches and accent submit. | `e2e/bots-real.mjs`: 26 boundaries, minimum light 4.58:1 / dark 6.13:1; removing borders invalidates assertion. Waits for theme transition to settle. | `fa6b40b8` |
| 16 | Fixed. Route bridges actual thread activity to avatar and sidebar; reasoning → thinking, text → talking, running tool caption populated, sending → wink. Attention/reaction precedence retained. | `chat/activity.test.tsx`: FakeRelay on mounted bot route streams reasoning/text/tool and sends; removing route bridge fails. | `489f96d9`, `fa6b40b8` |

## Additional requirements

- Title duplication: `ec1f2373`, shell filters a panel action when its tab already occupies the strip. Mounted title assertion detects reinstating the duplicate. Refreshed `bots-chief-of-staff-tab-details@1280-light.png` confirms one strip.
- §24.9 shared migration: `42612382` moves pure templates/check-in/schedule to `src/shared/bots/*`; old helper files are one-line re-exports, and dialog's removed literals/helper become shared import/export shims. Immutable fixtures retained byte-for-byte. `1f1bd897` pins these exact three legacy files using the existing allow mechanism. `02399ff7` places shared oracle verification outside renderer-next so the import guard stays strict. Unchanged legacy helper suites pass 27 tests. `check:legacy-diff` passes; its unchanged main test hardcodes the sign-in commit and fails on the new authorized pins. No src/main source or test was edited.
- Main contract/store/table accessory support came from the initial merge. No main or agent changes were made here. Separate minimal shell commits own the identity/action fix and URL registry. The sole chat source edit is the separately committed bot transcript filter.

## Final checks and artifacts

- Full renderer-next/main/shared: **3,733 passed**, **1 failed** (unchanged main allow-list hardcoded commit), **7 TODOs**, one skipped file. 352 passing files. Main-serial with required Electron suites: **281 passed / 8 files**.
- Unchanged legacy helper suites: **27 passed / 3 files**; targeted final shared oracle/guards: **25 passed / 3 files**.
- Real-main Electron driver: **13 checks at 1280**, **12 at 1000**. `.build/bots-real-{1280,1000}.json`; 23 recorded morph frames at each width in `.build/bots-model-morph`.
- `tsc -b`, root oxlint/oxfmt, UI registry, legacy diff, Knip, i18n/locales and required package builds pass. Existing lint warnings and Knip configuration hints remain.
- Foundation screenshots: **99 captures, zero failures**, all 1280/1000/900/800 light/dark. `.build/screenshots/02399ff7/{shots.json,axe.json,index.html}` and PNGs. Initial 800-band startup sample failed; unchanged script retry passed. Linux native-frame probe skipped on macOS.

Details and all R3-T1…T33 verification gaps are in the appended implementation report. Generated screenshots, native frames and logs live under `.build` and are not source commits.
