# Rewrite progress

Branch: `rewrite/renderer`. Plan: `docs/rewrite/PLAN.md`. Design canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX

Working loop per slice: spec (docs/rewrite/specs/<slice>.md) → adversarial spec review (Codex) → implement → typecheck/lint/test → adversarial diff review (Codex) → fixes → commit on this branch → mark done here.

| Phase | Slice | Spec | Impl | Review | Status |
|---|---|---|---|---|---|
| 0 | agent AG-UI host + emitter | r3 + impl r1 amendments | merged 2fecccd2; fixes merged 81066a43 (36/36; 24 goldens byte-identical; ABACUSAI_BOT_WIRE_RECORD) | Codex r1 + Claude r1 fixed | done (ndjson default) |
| 0 | main oRPC contract + MessagePort transport | r2 + implementation notes | merged cfb550aa; fixes merged 73caf359 (20/20 incl. credit flow control) | Codex r1 + Claude r1 fixed | done (dormant until new renderer) |
| 0 | DB tables (snapshot + change events) | same spec, notes (sub-slice B) | merged 6aca10c1; fixes merged bab36146 (27/27, leaf provenance); watcher deflake ed2f2f04 | Codex r1 + Claude r1 fixed | done |
| 0 | migration runner | section C + notes (two parts) | merged 70a3ec36; step 1 transcripts merged d4652ce6; runner rewrite merged 69f12a5d (journal v2, kill-injection harness) | runner: Codex r1 + Claude r1 fixed, Codex r2 (4 items) → fixing; step 1: Codex r1 + Claude r1 (27) → fixing | fixing |
| 0 | Window Controls Overlay + Electron 44 | r2 | a059a113 + cba4ca8a (Codex) | Claude r1 + re-review MERGEABLE; smoke on E44 OK; 2 low items deferred to wco switch | done (legacy default) |
| 1 | renderer foundation (shell, router, theme, gallery) | r4 + impl amendments | merged 6847de01 (15 commits, 459 tests, 144 screenshots) | Codex r1 (15) + Claude r1 (25 + visual) → fix agent in worktree | fixing |
| 2 | chat kit | r4 (Codex r1–r3 applied) | ready to start once phase-1 fixes and relay reviews land | | spec done |
| — | main AG-UI relay (`ai.*` behind AguiSource, wire selection, ring, hydrate/joinRun, thread persistence) | 00-agent-agui §8 + notes (main relay) | merged b4da2b2f (35 tests incl. spawned e2e) | Codex r1 + Claude r1 running | review |
| 3 | bots | r2 (70eba3ac) → Codex r2 running | | | spec |
| 4 | sessions | r1 (4859cf03) → Codex r1 running | | | spec |
| 5 | routines, artifacts, library, settings | r1 in progress (Opus) | | | spec |
| 6 | onboarding, tour, notch | | | | todo |
| 7 | cut-over | | | | todo |
