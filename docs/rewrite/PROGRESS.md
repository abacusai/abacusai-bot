# Rewrite progress

Branch: `rewrite/renderer`. Plan: `docs/rewrite/PLAN.md`. Design canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX

Working loop per slice: spec (docs/rewrite/specs/<slice>.md) → adversarial spec review (Codex) → implement → typecheck/lint/test → adversarial diff review (Codex) → fixes → commit on this branch → mark done here.

| Phase | Slice | Spec | Impl | Review | Status |
|---|---|---|---|---|---|
| 0 | agent AG-UI host + emitter | r1 → Codex review running | | | spec |
| 0 | main oRPC contract + MessagePort transport | r1 → revising (Codex r1) | | | spec |
| 0 | DB tables (snapshot + change events) | same spec as transport | | | spec |
| 0 | migration runner | same spec as transport | | | spec |
| 0 | Window Controls Overlay + Electron 44 | r2 (Codex r1 applied) | a059a113 (Codex, legacy mode default) | Claude review + smoke run in progress | reviewing |
| 1 | renderer foundation (deps, shadcn base-mira, routes skeleton, data layer, tokens, /__ui) | | | | todo |
| 2 | chat kit | | | | todo |
| 3 | bots | | | | todo |
| 4 | sessions | | | | todo |
| 5 | routines, artifacts, library, settings | | | | todo |
| 6 | onboarding, tour, notch | | | | todo |
| 7 | cut-over | | | | todo |
