# Rewrite progress

Branch: `rewrite/renderer`. Plan: `docs/rewrite/PLAN.md`. Design canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX

Working loop per slice: spec (docs/rewrite/specs/<slice>.md) → adversarial spec review (Codex) → implement → typecheck/lint/test → adversarial diff review (Codex) → fixes → commit on this branch → mark done here.

| Phase | Slice | Spec | Impl | Review | Status |
|---|---|---|---|---|---|
| 0 | agent AG-UI host + emitter | r3 (b7982412) | merged 2fecccd2 (`--wire agui` behind ndjson default; pi bump reverted: behaviour changes) | Codex r1 (15) + Claude r1 (21) → fix agent in worktree | fixing |
| 0 | main oRPC contract + MessagePort transport | r2 + implementation notes | merged cfb550aa; fixes merged 73caf359 (20/20 incl. credit flow control) | Codex r1 + Claude r1 fixed | done (dormant until new renderer) |
| 0 | DB tables (snapshot + change events) | same spec, notes (sub-slice B) | merged 6aca10c1 | Codex r1 (12) + Claude r1 (15) → fix agent in worktree | fixing |
| 0 | migration runner | same spec, section C + notes | merged 70a3ec36 (runner, prefs step 2, legacy sync, progress window); step 1 transcripts-v2 by follow-on agent | Codex r1 + Claude r1 running | review |
| 0 | Window Controls Overlay + Electron 44 | r2 | a059a113 + cba4ca8a (Codex) | Claude r1 + re-review MERGEABLE; smoke on E44 OK; 2 low items deferred to wco switch | done (legacy default) |
| 1 | renderer foundation (shell, router, theme, gallery) | r4 (Codex r1–r3 applied) + impl amendments | merged (15 commits; Transport state/onClose; dev fixture tables until db.* wired) | Codex r1 + Claude r1 next | review |
| 2 | chat kit | r4 (Codex r1–r3 applied) | waits on phase 1 + main AG-UI relay + AG-UI fixes | | spec done |
| — | main AG-UI relay (`ai.*` procedures behind AguiSource, resolveWire/emitAgui wiring, transcript ring, hydrate) | needed before phase 2 impl; spec section in 00-agent-agui §8 + 00-transport A.4 | | | todo |
| 3 | bots | r1 in progress (Opus) | | | spec |
| 4 | sessions | | | | todo |
| 5 | routines, artifacts, library, settings | | | | todo |
| 6 | onboarding, tour, notch | | | | todo |
| 7 | cut-over | | | | todo |
