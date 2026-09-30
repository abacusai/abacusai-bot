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
| 2 | chat kit | r4 (final) | merged 809f6175 (726 renderer-next tests) | Codex r1 (~20) + Claude r1 (57) → Codex fix task in worktree (incl. Electron/real-host tests, 6 change requests, knip) | fixing |
| — | main AG-UI relay (`ai.*` behind AguiSource, wire selection, ring, hydrate/joinRun, thread persistence) | 00-agent-agui §8 + notes (main relay, r2) | merged b4da2b2f; fixes 5d5dc433 (33/33); r2 fixes c07479f7 (4/4; bounded bookkeeping) | Codex r1 + Claude r1 + Codex r2 fixed | done (agui default only in the wco build) |
| 3 | bots | r3 (final) | merged (Codex, 11 commits; 25 screenshots; report docs/rewrite/reports/03-bots-implementation.md); avatarAccessory wiring, shared shims (§24.9), URL previews (phase 4) and the full R3 matrix pending | Codex r1 running | review |
| 4 | sessions | r3 (final) | Codex task in worktree codex-sessions (from 33301dc9) | | implementing |
| 5 | routines, artifacts, library, settings | r3 (final) | Codex task in worktree codex-phase5 (from 33301dc9) | | implementing |
| 6 | onboarding, tour, notch | r4 (Codex r1–r3 applied; final) | waits on phases 2–5 + relay `ai.attention` | | spec done |
| — | main requirements from specs 3–6 (+ cut-over defects #9/#10/#11, step-1 handovers, Bot.avatarAccessory) | specs 03 §24, 04 §26, 05 §31, 06 §23 + notes | merged 0ab59029; fixes 8eaec2b1; r2 fixes e75cb79d; accessory a868db96 (all Codex) | Codex r1 + Claude r1 + Codex r2 fixed; tree green (3,528 tests) | done |
| 7 | cut-over | r3 (Codex r1–r2 applied; final); prerequisites P1–P6 routed to implementers | waits on phases 2–6 | | spec done |
