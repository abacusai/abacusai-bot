# Rewrite progress

Branch: `rewrite/renderer`. Plan: `docs/rewrite/PLAN.md`. Design canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX

Working loop per slice: spec (docs/rewrite/specs/<slice>.md) → adversarial spec review (Codex) → implement → typecheck/lint/test → adversarial diff review (Codex) → fixes → commit on this branch → mark done here.

| Phase | Slice | Spec | Impl | Review | Status |
|---|---|---|---|---|---|
| 0 | agent AG-UI host + emitter | r3 + impl r1 amendments | merged 2fecccd2; fixes merged 81066a43 (36/36; 24 goldens byte-identical; ABACUSAI_BOT_WIRE_RECORD) | Codex r1 + Claude r1 fixed | done (ndjson default) |
| 0 | main oRPC contract + MessagePort transport | r2 + implementation notes | merged cfb550aa; fixes merged 73caf359 (20/20 incl. credit flow control) | Codex r1 + Claude r1 fixed | done (dormant until new renderer) |
| 0 | DB tables (snapshot + change events) | same spec, notes (sub-slice B) | merged 6aca10c1; fixes merged bab36146 (27/27, leaf provenance); watcher deflake ed2f2f04 | Codex r1 + Claude r1 fixed | done |
| 0 | migration runner | section C + notes + 1 Oct amendment | runner 69f12a5d + r2 ce06e642; step 1 d4652ce6 + fixes 41e0dd92 (27/27 + write block) | runner Codex r1/r2 + Claude r1 fixed; step 1 Codex r1 + Claude r1 fixed, Codex r2 running | review (step 1 r2) |
| 0 | Window Controls Overlay + Electron 44 | r2 | a059a113 + cba4ca8a (Codex) | Claude r1 + re-review MERGEABLE; smoke on E44 OK; 2 low items deferred to wco switch | done (legacy default) |
| 1 | renderer foundation (shell, router, theme, gallery) | r4 + impl amendments (router-owned route transitions) | merged 6847de01; fixes 8acc0ebb (40/40); r2 fixes e14f845d (9/9; Linux native-frame CI job added, unrun locally) | Codex r1 + Claude r1 + Codex r2 fixed; tree green (3,057 tests) | done (dev-only until cut-over) |
| 2 | chat kit | r4 (Codex r1–r3 applied; final) | Opus agent in worktree | | implementing |
| — | main AG-UI relay (`ai.*` behind AguiSource, wire selection, ring, hydrate/joinRun, thread persistence) | 00-agent-agui §8 + notes (main relay, r2) | merged b4da2b2f; fixes 5d5dc433 (33/33); r2 fixes c07479f7 (4/4; bounded bookkeeping) | Codex r1 + Claude r1 + Codex r2 fixed | done (agui default only in the wco build) |
| 3 | bots | r3 (4a854154, Codex r1–r2 applied; final) | waits on phase 2 | | spec done |
| 4 | sessions | r3 (b8997551, Codex r1–r2 applied; final) | waits on phases 2–3 | | spec done |
| 5 | routines, artifacts, library, settings | r3 (Codex r1–r2 applied; final) | waits on phases 2–4 | | spec done |
| 6 | onboarding, tour, notch | r4 (Codex r1–r3 applied; final) | waits on phases 2–5 + relay `ai.attention` | | spec done |
| — | main requirements from specs 3–6 (run-finished, attention, checkout-aware files/git, bot model, routine attempts, update failedPhase, sound opt-out import, prefs leaves, cue claims) + 3 cut-over defects | specs 03 §24, 04 §26, 05 §31, 06 §23 | Opus agent in worktree | | implementing |
| 7 | cut-over | r1 (551c59b8) → Codex r1 (25 items, 3 blockers) → r2 in progress; 5 code defects routed to implementers | | | spec |
