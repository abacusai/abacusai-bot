# Rewrite progress

Branch: `rewrite/renderer`. Plan: `docs/rewrite/PLAN.md`. Design canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX

Working loop per slice: spec (docs/rewrite/specs/<slice>.md) → adversarial spec review (Codex) → implement → typecheck/lint/test → adversarial diff review (Codex) → fixes → commit on this branch → mark done here. From 1 Oct 2026 implementation and fix passes run as Codex tasks (gpt-6.1-sol, full access, one worktree each); Claude orchestrates only.

| Phase | Slice | Spec | Impl | Review | Status |
|---|---|---|---|---|---|
| 0 | agent AG-UI host + emitter | r3 + impl r1 amendments | merged 2fecccd2; fixes merged 81066a43 (36/36; 24 goldens byte-identical; ABACUSAI_BOT_WIRE_RECORD) | Codex r1 + Claude r1 fixed | done (ndjson default) |
| 0 | main oRPC contract + MessagePort transport | r2 + implementation notes | merged cfb550aa; fixes merged 73caf359 (20/20 incl. credit flow control) | Codex r1 + Claude r1 fixed | done (dormant until new renderer) |
| 0 | DB tables (snapshot + change events) | same spec, notes (sub-slice B) | merged 6aca10c1; fixes merged bab36146 (27/27, leaf provenance); watcher deflake ed2f2f04 | Codex r1 + Claude r1 fixed | done |
| 0 | migration runner | section C + notes + 1 Oct amendment | runner 69f12a5d + r2 ce06e642; step 1 d4652ce6 + fixes 41e0dd92 + r2 8dc67139 (archive index, fail-closed clears, durable held writes) | runner Codex r1/r2 + Claude r1 fixed; step 1 Codex r1/r2 + Claude r1 fixed; low-effort Codex r3 running | done (dormant until cut-over) |
| 0 | Window Controls Overlay + Electron 44 | r2 | a059a113 + cba4ca8a (Codex) | Claude r1 + re-review MERGEABLE; smoke on E44 OK; 2 low items deferred to wco switch | done (legacy default) |
| 1 | renderer foundation (shell, router, theme, gallery) | r4 + impl amendments (router-owned route transitions) | merged 6847de01; fixes 8acc0ebb (40/40); r2 fixes e14f845d (9/9; Linux native-frame CI job added, unrun locally) | Codex r1 + Claude r1 + Codex r2 fixed; tree green (3,057 tests) | done (dev-only until cut-over) |
| 2 | chat kit | r4 (final) | merged 809f6175; fixes bc32ca68; r2 fixes b1704cfc (Codex; Electron gates 12; R2-T31 49 ms paint / 59.9 fps) | Codex r1 + Claude r1 + Codex r2 fixed; tree green (3,807 tests) | done (abacus.notice.path landed 25cdc149) |
| — | main AG-UI relay (`ai.*` behind AguiSource, wire selection, ring, hydrate/joinRun, thread persistence) | 00-agent-agui §8 + notes (main relay, r2) | merged b4da2b2f; fixes 5d5dc433 (33/33); r2 fixes c07479f7 (4/4; bounded bookkeeping) | Codex r1 + Claude r1 + Codex r2 fixed | done (agui default only in the wco build) |
| 3 | bots | r3 (final) | merged 33301dc9; fixes 5a1d64f7; r2 fixes 3e15c8e4 (Codex) | Codex r1 + r2 fixed; tree green (3,822 tests) | done (URL deliverables → embedded browser tab deferred to the phase-4 integration pass via registerBrowserOpen) |
| — | cross-slice follow-ups (chat local-model adoption + disk skills baseline, global title-bar end actions, typed notification routing, registry checker, RouteSheet) and main phase-4 asks (joined agent.start, exec-backend settings event) | reports 04/05 change requests | merged 0cadd1b7 and d488dc00 (Codex) | | done |
| 4 | sessions | r3 (final) | merged e031e516 (Codex; ~70 commits: routes, stage machine, dock, terminals, browser surfaces incl. embedded bots routing, scoped diffs, files/device, main contracts wired) | Codex r1 (21) + r2 (2) fixed; tree green (4,161 tests) | done (R4 acceptance matrix partial per report) |
| 5 | routines, artifacts, library, settings | r3 (final) | merged 1bdd32c3; r2 fixes f809ad96 (Codex; 61 commits total) | Codex r1 (18) + r2 (4) fixed; tree green (4,065 tests) | done (R5 acceptance matrix partial per report) |
| 6 | onboarding, tour, notch | r4 (final) | merged 4a32dc07 (Codex; ~65 commits incl. two cross-phase merges) | Codex r1 (17) + r2 (3) fixed; tree green (4,327 unit + 272 serial) | done (hardware runs: notched Mac, external display, Windows capsule pending) |
| — | main requirements from specs 3–6 (+ cut-over defects #9/#10/#11, step-1 handovers, Bot.avatarAccessory) | specs 03 §24, 04 §26, 05 §31, 06 §23 + notes | merged 0ab59029; fixes 8eaec2b1; r2 fixes e75cb79d; accessory a868db96 (all Codex) | Codex r1 + Claude r1 + Codex r2 fixed; tree green (3,528 tests) | done |
| 7 | cut-over | r3 (final; D1–D9 followed as written, §19 open questions pending user) | Codex task in worktree codex-cutover (release N: C1–C14) | | implementing |

## Cutover release N implementation, 1 October 2026

C5 completion and C6–C14 are implemented in ordered commits on codex-cutover. See [the cutover report](reports/07-cutover.md) for focused checks and final gates. Release acceptance remains pending hardware, signed RC, comparative performance and §19 decisions. N keeps migration steps 1, 2 and 5 registered. Steps 3 and 4 remain reserved for N+1. Restore tooling is shipped early so support can exercise its synthetic two-profile and two-cycle checks before retirement.
