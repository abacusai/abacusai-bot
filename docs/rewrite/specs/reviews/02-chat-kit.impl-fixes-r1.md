# Chat kit fix pass, r1

Status snapshot, 2026-10-01. This pass is incomplete. Another writer continued editing and committing in this same worktree after the merge. The runtime step below was verified independently. Other changes need an integrated review once there is one writer.

Merged `rewrite/renderer` first in `b1cf791e`. Kept the interrupted stash as `chat-kit-interrupted` for recovery. Concurrent commits `4a0c14af`, `535e44fe`, `954f3fbe`, `1bb05d00`, `27b6b392` and `aaa7b5b6` are present but have not received final integrated validation in this pass.

## Validation

- Runtime suite: 47 tests passed across 11 files, with ABACUS_API_KEY and ROUTELLM_API_KEY unset.
- Changed runtime files, store/apply.ts and permission decisions: oxlint and oxfmt --check passed.
- Desktop tsc -b fails in transcript.tsx and transcript.test.tsx against the concurrently changed scroller/window.ts API. No runtime type errors remained.
- Full suites, Electron gates, bundle check, legacy diff, registry check and NDJSON comparison have not been completed.

## Per-finding status

References C refer to the Codex review; A refer to the Claude review. Overlapping findings share their implementation. No rebuttals are asserted in this partial pass.

| Finding | Status | Detail |
|---|---|---|
| C1 | Implemented; runtime suite passed | Recovery budget resets only on sequenced live subscription events, not join/subscribed control. |
| C2 | Implemented; runtime suite passed | Finished-run retry uses a new-run admission/outbox, retaining the original message id. |
| C3 | Implemented; runtime suite passed | Retirement invalidates reset revision and tokens; settlement and resends check retirement. |
| C4 | Implemented; runtime suite passed | Pre/post hooks and client callbacks reject superseded or aborted generations; close discards queues. |
| C5 | Implemented; runtime suite passed | Cancellation callbacks carry generation, revision, run target and attempt; terminal cancels timeout. |
| C6 | Implemented; runtime suite passed | Permission timeouts carry generation, revision, store and attempt. |
| C7 | Implemented; runtime suite passed | Definitive send NOT_FOUND sets notFound on the host. |
| C8 | Pending | Pending integrated fix/review and acceptance coverage. Major — [composer.tsx:338](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/composer/composer.tsx:338). |
| C9 | Pending | Pending integrated fix/review and acceptance coverage. Major — [transcript.tsx:278](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/scroller/transcript.tsx:278). |
| C10 | Pending | Pending integrated fix/review and acceptance coverage. Major — [transcript.tsx:207](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/scroller/transcript.tsx:207). |
| C11 | Pending | Pending integrated fix/review and acceptance coverage. Major — [session.ts:529](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/runtime/session.ts:529). |
| C12 | Pending | Pending integrated fix/review and acceptance coverage. Major — [message.tsx:354](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/kit/message.tsx:354). |
| C13 | Pending | Pending integrated fix/review and acceptance coverage. Major — [triggers.tsx:93](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/composer/triggers.tsx:93). |
| C14 | Pending | Pending integrated fix/review and acceptance coverage. Minor — [parts.tsx:194](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/kit/parts.tsx:194). |
| C15 | Pending | Pending integrated fix/review and acceptance coverage. Major — [message.tsx:99](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/kit/message.tsx:99). |
| C16 | Pending | Pending integrated fix/review and acceptance coverage. Minor — [chat.css:191](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/chat.css:191). |
| C17 | Implemented; runtime suite passed | Pump sleep removes the abort listener when settled. |
| C18 | Pending | Pending integrated fix/review and acceptance coverage. Major — [transcript.test.tsx:7](/Users/rajaniraiyn/work/abacusai-bot/apps/desktop/src/renderer-next/features/chat/scroller/transcript.test.tsx:7). |
| C19 | Pending | Pending: consumed sequence trace assertions remain to be added. |
| A1 | Implemented; runtime suite passed | Retirement invalidates reset revision and tokens; settlement and resends check retirement. Recovery alone does not invalidate admissions. |
| A2 | Implemented; runtime suite passed | Recovery budget resets only on sequenced live subscription events, not join/subscribed control. |
| A3 | Implemented; runtime suite passed | Dispatcher hook exceptions are reported and isolated; client errors trigger recovery. |
| A4 | Implemented; runtime suite passed | Finished-run retry uses a new-run admission/outbox, retaining the original message id. |
| A5 | Pending | Pending integrated fix/review and acceptance coverage. Major: processor retention (§10, `MAX_MESSAGES = 300`) never runs. |
| A6 | Implemented; runtime suite passed | Terminal step counts start at RUN_STARTED message boundary, before steers. |
| A7 | Implemented; runtime suite passed | Permission timeouts carry generation, revision, store and attempt. |
| A8 | Implemented; runtime suite passed | Cancellation callbacks carry generation, revision, run target and attempt; terminal cancels timeout. Swap clears cancelling when there is no active run. |
| A9 | Implemented; runtime suite passed | Readiness cap is armed before hydrate; hung hydrate rejects; ready-session hydrate failures recover. |
| A10 | Implemented; runtime suite passed | Fresh messages require seq above checkpoint, including after partial swap. |
| A11 | Implemented; runtime suite passed | Retirement invalidates reset revision and tokens; settlement and resends check retirement. |
| A12 | Pending | Pending integrated fix/review and acceptance coverage. Minor: composer admission outcomes. |
| A13 | Pending | Pending integrated fix/review and acceptance coverage. Minor: Stop hotkey (`Mod+.`). |
| A14 | Implemented; runtime suite passed | Host stop catches and logs cancel rejection. |
| A15 | Implemented; runtime suite passed | Runtime validates decisions against the descriptor allowed set without a never cast. |
| A16 | Pending | Pending integrated fix/review and acceptance coverage. Minor: unbounded per-session sets. |
| A17 | Pending | Pending integrated fix/review and acceptance coverage. Minor: `ChatView` creates and evicts sessions during render. |
| A18 | Pending | Pending integrated fix/review and acceptance coverage. Minor: attach "Files or images" copies every file's bytes into the renderer. |
| A19 | Pending | Pending integrated fix/review and acceptance coverage. Minor (needs a bundle check): fixtures probably ship in production. |
| A20 | Pending | Pending integrated fix/review and acceptance coverage. Nit: pump retry delays differ from §3.3. |
| A21 | Pending | Pending integrated fix/review and acceptance coverage. Major: history pages announce old runs. |
| A22 | Pending | Pending integrated fix/review and acceptance coverage. Major: the window does not bound mounted rows (§10, r3-3). |
| A23 | Pending | Pending integrated fix/review and acceptance coverage. Major: registry prepend preservation never runs. |
| A24 | Pending | Pending integrated fix/review and acceptance coverage. Major: in-page Markdown links navigate the router. |
| A25 | Pending | Pending integrated fix/review and acceptance coverage. Major: math rendered before temml loads never updates. |
| A26 | Pending | Pending integrated fix/review and acceptance coverage. Major: the "Thinking" shimmer stays on for the whole run. |
| A27 | Partial | Host arrays are frozen module constants. Composer context changes from concurrent commits remain unverified. |
| A28 | Pending | Pending integrated fix/review and acceptance coverage. Major: tool groups (§5.3) are not implemented. |
| A29 | Pending | Pending integrated fix/review and acceptance coverage. Major (safety): the credentials card focuses "Allow once". |
| A30 | Pending | Pending integrated fix/review and acceptance coverage. Minor: the tray moves on before the answer resolves. |
| A31 | Pending | Pending integrated fix/review and acceptance coverage. Minor: sub-agent durations come from a stale clock and module maps written during render. |
| A32 | Pending | Pending integrated fix/review and acceptance coverage. Minor: `runActive` is thread-wide. |
| A33 | Pending | Pending integrated fix/review and acceptance coverage. Minor: the in-app reduce-motion preference doesn't reach CSS. |
| A34 | Pending | Pending integrated fix/review and acceptance coverage. Minor: invisible messages still mount a scroller row. |
| A35 | Pending | Pending integrated fix/review and acceptance coverage. Minor: "composer had focus" is set on focus and never cleared. |
| A36 | Pending | Pending integrated fix/review and acceptance coverage. Minor: queue row editing. |
| A37 | Pending | Pending integrated fix/review and acceptance coverage. Minor: ErrorCard and notice gaps (§5.6). |
| A38 | Pending | Pending integrated fix/review and acceptance coverage. Minor: diff colours in code blocks never apply. |
| A39 | Pending | Pending integrated fix/review and acceptance coverage. Minor: `PermissionList` cannot render outside a `ChatView`. |
| A40 | Pending | Pending integrated fix/review and acceptance coverage. Minor: the runtime is not on the router context. |
| A41 | Pending | Pending integrated fix/review and acceptance coverage. Minor: pre-pass edge cases. |
| A42 | Pending | Pending integrated fix/review and acceptance coverage. Minor: gallery gaps. |
| A43 | Pending | Pending integrated fix/review and acceptance coverage. Minor (a11y): transcript attachment chips. |
| A44 | Pending | Pending integrated fix/review and acceptance coverage. Minor: "Show" on a "needs you" row does nothing in bots. |
| A45 | Pending | Pending integrated fix/review and acceptance coverage. Nit. |
| A46 | Pending | Pending integrated fix/review and acceptance coverage. Blocker: whole R2 rows have no test. |
| A47 | Pending | Pending integrated fix/review and acceptance coverage. Major: the wrong harness for "memory transport" and "real host" rows. |
| A48 | Pending | Pending integrated fix/review and acceptance coverage. Major: failing and weak scroller test. |
| A49 | Implemented; runtime suite passed | R2-T35a awaits processed echo before rejecting, requires started and exactly one send. |
| A50 | Pending | Pending integrated fix/review and acceptance coverage. Major: R2-T22 is incomplete. |
| A51 | Pending | Pending integrated fix/review and acceptance coverage. Major: R2-T10 is not tested through the real busy source. |
| A52 | Pending | Pending integrated fix/review and acceptance coverage. Major: R2-T12 does not use the spec's cases. |
| A53 | Pending | Pending integrated fix/review and acceptance coverage. Major: R2-T16 jsdom gaps. |
| A54 | Pending | Pending integrated fix/review and acceptance coverage. Major: R2-T2 is incomplete. |
| A55 | Pending | Pending integrated fix/review and acceptance coverage. Minor: weak assertions across several rows. |
| A56 | Pending | Pending integrated fix/review and acceptance coverage. Minor: R2-T30 is a name heuristic. |
| A57 | Pending | Pending integrated fix/review and acceptance coverage. Minor: locales. |

## Retention and test limitations

retain() now protects messages from the active run start, and paging shifts that boundary. The required at-end lifecycle caller has not yet been wired. The consumed sequence trace, timer race assertions, exported-kit host render, real-host integration rows and all missing Electron gates remain to be verified. R2-T31 numbers have not been measured and the phase gate remains open.

## Handover

The relay-side path on abacus.notice belongs to main and is handed over. The picked-file path-only RPC also needs main ownership if the existing contract has no path-only picker. No main services, main RPC, shared contracts, bots feature sources or agent source were changed by this runtime step.

## English locale copies

Per the user instruction, non-English copies are to remain English. A concurrent writer committed 37 keymap entries; their locale changes need review against that instruction. The keys below currently equal English in every non-English locale and have not been translated in this pass.

```text
```
