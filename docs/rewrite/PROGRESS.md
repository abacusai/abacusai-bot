# Rewrite progress

Branch: `rewrite/renderer`. Plan: `docs/rewrite/PLAN.md`. Design canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX

Working loop per slice: spec (docs/rewrite/specs/<slice>.md) → adversarial spec review (Codex) → implement → typecheck/lint/test → adversarial diff review (Codex) → fixes → commit on this branch → mark done here.

| Phase | Slice | Spec | Impl | Review | Status |
|---|---|---|---|---|---|
| 0 | agent AG-UI host + emitter | r3 (b7982412, after Codex r1+r2) | Opus agent in worktree | | implementing |
| 0 | main oRPC contract + MessagePort transport | r2 (Codex r1 applied); implementation notes and deferred additions in the spec | f11e5d25..f8e7fbb8 (sub-slice A; FOUNDATION_API bump held back, see spec) | | review |
| 0 | DB tables (snapshot + change events) | same spec as transport | | | spec |
| 0 | migration runner | same spec as transport | | | spec |
| 0 | Window Controls Overlay + Electron 44 | r2 | a059a113 + cba4ca8a (Codex) | Claude r1 + re-review MERGEABLE; smoke on E44 OK; 2 low items deferred to wco switch | done (legacy default) |
| 1 | renderer foundation (deps, shadcn base-mira, routes skeleton, data layer, tokens, /__ui) | | | | todo |
| 2 | chat kit | | | | todo |
| 3 | bots | | | | todo |
| 4 | sessions | | | | todo |
| 5 | routines, artifacts, library, settings | | | | todo |
| 6 | onboarding, tour, notch | | | | todo |
| 7 | cut-over | | | | todo |
