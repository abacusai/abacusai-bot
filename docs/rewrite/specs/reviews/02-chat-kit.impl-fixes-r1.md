# Chat kit fix pass, r1

Integrated fix pass, 2026-10-01. The stopped writer’s runtime, row-window and harness work was reviewed and integrated in this worktree. `rewrite/renderer` was merged first (`b1cf791e`) and refreshed (`d74d00aa`). Final validation is recorded below. All C1–C19 and A1–A56 are implemented and covered; A57 follows the explicit user exception. The main-owned notice path remains a handover.

## Per-finding status

C = Codex review; A = Claude review. Shared findings use the same implementation. “Fixed” refers to implementation and targeted regression coverage; the final gate results below qualify acceptance.

| Finding | Status | Resolution / rebuttal |
|---|---|---|
| C1 | Fixed | Only sequenced live progress resets recovery; repeated reconstruction failures exhaust the budget. |
| C2 | Fixed | Retry reserves a new run in the outbox with the existing message id and reconciles uncertain replies. |
| C3 | Fixed | Retirement increments reset revision and checks retirement before settlements/resends. |
| C4 | Fixed | Dispatcher hook failures are reported and isolated; following events still apply. Pre-apply also guards generation/abort; close discards queued events. |
| C5 | Fixed | Cancellation callbacks carry lineage, target run and attempt; terminals clear the matching timer. |
| C6 | Fixed | Permission timers carry generation, revision, descriptor and attempt; superseded timers are cleared. |
| C7 | Fixed | Definitive NOT_FOUND marks the host gone and the composer read-only. |
| C8 | Fixed | Composer handles rejected, stale, noop, queued, unconfirmed and definitive errors without destroying newer edits. |
| C9 | Fixed | Shared row budget includes tools, group headers and nested cards; measured placeholders and scoped anchors preserve reading position. |
| C10 | Fixed | Shared row budget includes tools, group headers and nested cards; measured placeholders and scoped anchors preserve reading position. |
| C11 | Fixed | At-end retention is wired; active-run messages remain protected, paging cursors/outcomes survive. |
| C12 | Fixed | Consecutive migrated tool groups show summaries; session groups expand, bot groups collapse; headers share the window. |
| C13 | Fixed | Trigger keys are handled on the owning textarea; IME and unrelated focused controls are ignored. |
| C14 | Fixed | Thinking is live only when it is the streaming message’s final part; provenance supplies migrated titles. |
| C15 | Fixed | Transcript chips use named AttachmentTrigger buttons; thumbnails load on intersection with bot path fallback. |
| C16 | Fixed | CSS follows foundation data-reduce-motion preferences, including explicit full overriding OS reduction. |
| C17 | Fixed | Pump retries at 250 ms, 1 s and 4 s, and removes settled abort listeners. |
| C18 | Fixed | Added real-host T6/T33 and Electron T16/T28/T31/T32 gates; final execution recorded below. |
| C19 | Fixed | 2,000 seeded sequences assert exact consumed sequence identity, uniqueness, order and final state. |
| A1 | Fixed | Admission lineage uses reset revision; recovery preserves reservations, retirement invalidates them. |
| A2 | Fixed | Only sequenced live progress resets recovery; repeated reconstruction failures exhaust the budget. |
| A3 | Fixed | Dispatcher hook failures are reported and isolated; following events still apply. |
| A4 | Fixed | Retry reserves a new run in the outbox with the existing message id and reconciles uncertain replies. |
| A5 | Fixed | At-end retention is wired; active-run messages remain protected, paging cursors/outcomes survive. |
| A6 | Fixed | Terminal steps count from RUN_STARTED, including steers. |
| A7 | Fixed | Permission timers carry generation, revision, descriptor and attempt; superseded timers are cleared. |
| A8 | Fixed | Cancellation callbacks carry lineage, target run and attempt; terminals clear the matching timer. |
| A9 | Fixed | Readiness timer starts before hydrate; hung hydrate rejects, ready failures recover. |
| A10 | Fixed | Fresh markers require a sequence above the checkpoint after a partial swap. |
| A11 | Fixed | Retirement increments reset revision and checks retirement before settlements/resends. |
| A12 | Fixed | Composer handles rejected, stale, noop, queued, unconfirmed and definitive errors without destroying newer edits. |
| A13 | Fixed | Shell exports useAppHotkey; focused-view Stop uses it with the real busy source. |
| A14 | Fixed | Host Stop catches and reports cancel failures. |
| A15 | Fixed | Runtime validates each decision against the pending descriptor’s allowed set. |
| A16 | Fixed | Echo/fresh/announcement and timing records are pruned with retained state; event-time maps have a bounded lifetime. |
| A17 | Fixed | Eviction is deferred out of render, and mounted views pin sessions in effects. Session lookup itself remains cached and synchronous. |
| A18 | Fixed | Native file selection reads File metadata and preload getPathForFile only; no file contents cross IPC. |
| A19 | Fixed | Fixture imports are guarded at their dynamic import sites; production bundle module inspection rejects fixtures/gallery. |
| A20 | Fixed | Pump retries at 250 ms, 1 s and 4 s, and removes settled abort listeners. |
| A21 | Fixed | Only live terminals announce; historical pages stay silent, and new-message announcements debounce 500 ms. |
| A22 | Fixed | Shared row budget includes tools, group headers and nested cards; measured placeholders and scoped anchors preserve reading position. |
| A23 | Fixed | Header/loading/placeholders sit outside registry Content; prepend hooks capture anchors before state changes. |
| A24 | Fixed | Markdown prevents navigation, scopes fragment scrolling locally, and rewrites reference definitions. |
| A25 | Fixed | Math load version is a rendered dependency; late temml load remounts finished text under the Compiler. |
| A26 | Fixed | Thinking is live only when it is the streaming message’s final part; provenance supplies migrated titles. |
| A27 | Fixed | Frozen host arrays, extracted message rows and stable event callbacks let the Compiler preserve finished messages. |
| A28 | Fixed | Consecutive migrated tool groups show summaries; session groups expand, bot groups collapse; headers share the window. |
| A29 | Fixed | Autofocus follows primaryAction; credentials focus Deny. |
| A30 | Fixed | Selected permission remains visible during sending/rejection/timeout, advancing only when pending removes it. |
| A31 | Fixed | Subagent durations use scoped SUBAGENT event timestamps rather than render-written module maps. |
| A32 | Fixed | Tool status uses its own run boundary; error calls map to failed; child runs use child status. |
| A33 | Fixed | CSS follows foundation data-reduce-motion preferences, including explicit full overriding OS reduction. |
| A34 | Fixed | Hidden user and empty assistant rows do not mount; outcome anchors fall back to the preceding visible row. |
| A35 | Fixed | Tray autofocus reads activeElement when mounted rather than retaining a stale focus flag. |
| A36 | Fixed | Queue edit text refreshes on opening; ghost rows expose no edit/remove controls. |
| A37 | Fixed | Model picker fallback, account-tier CTA, actionable notices, migrated dismiss and feature-limit upgrade are wired. |
| A38 | Fixed | Diff code uses th-inserted/th-deleted selectors. |
| A39 | Fixed | PermissionList supports a standalone session/runtime provider for notch use. |
| A40 | Fixed | RouterContext owns chat: ChatRuntime; both chat route loaders use context.chat. Bots route edits stay minimal. |
| A41 | Fixed | Pre-pass covers nested display math, list continuation, escaped delimiters and reference links. |
| A42 | Fixed | Markdown, attachment, mention, dictating-preview and picker gallery states exist; unmount retires fixture sessions and clears drafts. |
| A43 | Fixed | Transcript chips use named AttachmentTrigger buttons; thumbnails load on intersection with bot path fallback. |
| A44 | Fixed | Needs-you Show reaches the bot’s inline permission card. |
| A45 | Fixed | Thinking Marker has status semantics; Copy timeout clears; first-seen times come from scoped store records. |
| A46 | Fixed | Added real-host T6/T33 and Electron T16/T28/T31/T32 gates; final execution recorded below. |
| A47 | Fixed | Runtime recovery/admission/queue tests use memory transport with RPCHandler/RPCLink and main relay; real-host rows use AguiHost. Fixture snapshots fold independently with StreamProcessor. |
| A48 | Fixed | Replaced redundant expensive jsdom full-history mounting with bounded-window/geometry tests and real Electron expansion/anchor assertions; see root cause below. |
| A49 | Fixed | Echo-before-rejection is awaited deterministically; result must be started and send count exactly one. |
| A50 | Fixed | Rendered permission coverage includes two bot descriptors answered in reverse order, rejection, 10 s timeout, elsewhere and expiry. |
| A51 | Fixed | Composer tests toggle the actual turn busy source before/after RUN_STARTED and during permission wait. |
| A52 | Fixed | Exported-kit coverage includes unknown MCP mcp__linear__create_issue and unknown nested subagent kinds/parts. |
| A53 | Fixed | Added insertion-time pending-scroll interception, unread marker/local-echo clearing and stubbed prepend geometry. |
| A54 | Fixed | Host renders through exported ChatView/createChatUI and verifies old teardown callbacks cannot mutate the replacement. |
| A55 | Fixed | Strengthened positions, exact sequence trace, both skins/groups/unknown parts, decision imports, questionnaire shortcuts, composer attachments/IME/mini, announcement once/debounce and typed agent events. |
| A56 | Fixed | AST guard handles aliases, destructuring and computed request-method access. |
| A57 | User-directed exception | Existing-key mappings are recorded. Non-English copies remain English by explicit user instruction; no translation claim. |

## Review qualifications and root causes

- A18: the existing byte-returning main RPC remains untouched, but chat no longer calls it. The path-only native picker uses the existing preload bridge, so no contract/main change is needed for this kit.
- A17: retaining a synchronous cached lookup is intentional. Eviction/retirement is deferred and pinning happens in effects; rendering does not synchronously retire another mounted chat.
- A42: dictation is a gallery preview; microphone recording remains the later-phase placeholder specified by §8. The picker boards now open their real popovers.
- A48: the old test mounted hundreds of rich completed rows twice in jsdom and incorrectly expected all 520 messages after introducing retention. Outcome rows were omitted from its count. The replacement isolates row-budget logic and stubbed geometry; Electron measures real DOM expansion and offset preservation. This is not a timeout increase.
- R2-T28 uncovered reused scroller state across thread navigation and opening geometry deferred beyond the route snapshot. Thread-keyed kit mounts, opening at the end and actual mounted-row heights in the commit address both.
- R2-T31 initially exceeded the 50 ms repeated-expansion gate at 400/200 rows. The spec’s fallback uses MAX_ROWS=100 and 50-row activations. Filtering parts before creating elements and stable original-part/group keys also removed the 3,000-part render cost and surviving-row remounts. The final gate passes.

## Validation

- Desktop full run: 340 files, 3,767 passed, two failures, seven existing todo tests. The two failures were the stale synchronous-eviction assertion and the expansion performance gate; both were fixed and rerun below. No other suite failed.
- Complete affected renderer-next rerun, with React Compiler enabled: **788 passed / 62 files**, including the new manual-Retry case and real-host memory-relay cases.
- Complete chat Electron gate rerun, required suites enabled: **12 passed / 2 files** (R2-T16/T28/T31/T32). Foundation and other main-serial suites passed in the full desktop run.
- Agent full run (both API keys unset): **2,033 passed, five skipped / 123 files** (122 passed, one skipped).
- Connectors: **14 passed / 1 file**. Updater: **9 passed / 3 files**.
- Desktop `tsc -b`, root oxlint, root oxfmt --check, renderer-next knip, legacy diff, JSX i18n guard, locale synchronization check and UI registry snapshot check passed. Oxlint reports seven existing old-renderer warnings; knip reports one CSS configuration hint.
- Final production bundle check: **187 chunks**, no chat fixture/gallery modules. Goldens remain byte-identical: no JSONL changes against the pre-pass merge; fixture tests pass. React Compiler remains on, with no manual memo introduced.

### R2-T31 accepted measurements

Measured in the real Electron renderer at 1280×800 with MAX_ROWS=100. Every threshold is asserted in the harness; all three prepend offsets and both repeated-expansion offsets were preserved with zero drift. Both expansion cases performed 20 activations, exceeding the required ten.

| Gate | Result |
|---|---|
| (a) 1,000 rich messages, 1,500 tools, five subagents | First paint 49 ms; median scrolling 59.9 fps; frame p95 18.3 ms; 95 mounted rows |
| (b) active replay, 350 messages | Readiness 13 ms; 100 mounted rows |
| (c) 3,000-tool message | First paint 49 ms; 100 mounted rows |
| (d) 20 KB streamed Markdown | 171 deltas; 1,821 tasks; task p95 3.68 ms, busy-task p95 4.97 ms, maximum 30.25 ms; zero ≥50 ms tasks |
| (e) history, 20 activations | Commit median 19.6 ms, p95/max 20.3 ms; peak 100 rows; 0 px drift |
| (e) tools, 20 activations | Commit median 12.2 ms, p95/max 13.9 ms; peak 100 rows; 0 px drift |

The final measurements were captured with ABACUSBOT_CHAT_METRICS_FILE; the numbers above are the accepted run, not the earlier failing measurements.

## Commits in the integrated continuation

- `d74d00aa`: refresh merge from rewrite/renderer.
- `950ae807`: typed fixture relay and real-host user echoes.
- `47ee7ab3`: mounted tool window, input and permission state.
- `8a02f1a3`: main memory transport and exact replay-position trace.
- `83ad3e50`: reading anchors, widgets and permission regressions.
- `eed41aa0`: production fixture/gallery exclusion and bundle check.
- `69058ff6`: gallery states, native path-only picker and group-row budget.
- `4697dc9f`: real Electron sessions, transitions, scrolling and performance harness.
- `62195903`: deferred LRU assertion.
- `69f7f379`: pre-element tool filtering, stable keys and manual-Retry regression.
- This document’s final commit records the accepted gates and per-finding disposition.

## Regression locations

- R2-T6 and R2-T33: `runtime/user-echo.test.ts`, `runtime/steer-ids.test.ts`, shared `renderer-next/test-support/real-host.ts` and `renderer-next/test-support/chat-relay.ts`; actual AguiHost over the memory transport and main relay.
- R2-T16: `scroller/transcript.test.tsx`, `scroller/markers.test.tsx` and `src/main/dev/chat-kit.electron.test.ts` (both geometry and real DOM).
- R2-T28/R2-T32: `src/main/dev/chat-real-session.electron.test.ts`; the real application, main agent, FakeProvider, persisted sessions, approval and reload.
- R2-T31: `src/main/dev/chat-kit.electron.test.ts` and dev-only `fixtures/perf/`; metrics may be captured using ABACUSBOT_CHAT_METRICS_FILE.
- Strengthened runtime cases: `positions`, `host`, `ordering`, `lifecycle`, `connection`, `recovery`, `queue`, `admission-uncertain` tests.
- Strengthened exported kit/composer/permission cases: `kit/parts`, `kit/view`, `kit/status`, `kit/tools/tool-line`, `kit/permissions/lifecycle`, `kit/permissions/presenters`, `composer/composer`, `gallery/a11y` tests; guard and fixture tests check typed event coverage, AST access and byte-identical goldens.

## Handover

Relay-side `path` in `abacus.notice` belongs to main and is handed over. No main services, main RPC, shared contracts, bots feature sources or agent source were edited. Only main/dev Electron harness scripts were added.

## English locale copies

Per the user instruction, these new keys retain English text in all non-English locale copies. Existing reused keys preserve their earlier mapped translations. Plurals use _one/_other; duplicate base keys are removed and the static i18n test resolves plural forms.

```text
chat.announce.approval
chat.announce.error
chat.announce.finished
chat.announce.newMessages_one
chat.announce.newMessages_other
chat.announce.stopped
chat.busy.agents_one
chat.busy.agents_other
chat.busy.needsYou
chat.busy.retrying
chat.busy.tools_one
chat.busy.tools_other
chat.busy.typing
chat.busy.working
chat.code.copied
chat.code.copy
chat.code.showLess
chat.code.showMore_one
chat.code.showMore_other
chat.composer.attachFailed
chat.composer.attachFiles
chat.composer.attachFolder
chat.composer.busyBot
chat.composer.busySession
chat.composer.channelBot
chat.composer.dictate
chat.composer.dictateSoon
chat.composer.files
chat.composer.gone
chat.composer.mini
chat.composer.modeFailed
chat.composer.model
chat.composer.models
chat.composer.notReady
chat.composer.pasteUnavailable
chat.composer.queue
chat.composer.queueFailed
chat.composer.rejected
chat.composer.removeAttachment
chat.composer.routineRun
chat.composer.searchModels
chat.composer.send
chat.composer.uploading
chat.day.today
chat.day.yesterday
chat.error.crashed
chat.error.open
chat.error.switchModel
chat.message.credits_one
chat.message.credits_other
chat.message.discard
chat.message.notSent
chat.message.sending
chat.message.workedThrough_one
chat.message.workedThrough_other
chat.mode.ACCEPTEDITS
chat.mode.AUTO
chat.mode.DEFAULT
chat.mode.PLAN
chat.mode.YOLO
chat.mode.description.ACCEPTEDITS
chat.mode.description.AUTO
chat.mode.description.DEFAULT
chat.mode.description.PLAN
chat.mode.description.YOLO
chat.notice.dismiss
chat.notice.historyTooLarge
chat.notice.showInFolder
chat.part.compaction
chat.part.details
chat.part.featureLimit
chat.part.summary
chat.part.thinking
chat.part.thoughts
chat.permission.action.allowOnce
chat.permission.action.alwaysAcceptEdits
chat.permission.action.alwaysAllow
chat.permission.action.alwaysAllowFolder
chat.permission.action.alwaysAllowHost
chat.permission.action.alwaysAllowRule
chat.permission.action.alwaysAllowSite
chat.permission.action.alwaysAllowThese
chat.permission.action.planAcceptAll
chat.permission.action.planApproveEach
chat.permission.action.planFullAccess
chat.permission.action.planKeepPlanning
chat.permission.action.runInBackground
chat.permission.action.skipAll
chat.permission.addNote
chat.permission.alsoInNotch
chat.permission.chip.browser
chat.permission.chip.connect
chat.permission.chip.createFile
chat.permission.chip.deleteFile
chat.permission.chip.editFile
chat.permission.chip.generic
chat.permission.chip.outside
chat.permission.chip.plan
chat.permission.chip.question
chat.permission.chip.runCommand
chat.permission.notePlaceholder
chat.permission.pending_one
chat.permission.pending_other
chat.permission.problem.earlierTurn
chat.permission.problem.incarnation
chat.permission.problem.invalid
chat.permission.problem.noResponse
chat.permission.problem.notPending
chat.permission.sandboxRunsAgain
chat.permission.showAll
chat.permission.title.browserAction
chat.permission.title.createFile
chat.permission.title.credentials
chat.permission.title.deleteFile
chat.permission.title.editFile
chat.permission.title.editOutside
chat.permission.title.exitPlan
chat.permission.title.fetchUrl
chat.permission.title.generic
chat.permission.title.networkHost
chat.permission.title.networkHostDescription
chat.permission.title.notebook.delete
chat.permission.title.notebook.insert
chat.permission.title.notebook.replace
chat.permission.title.notebookOutside
chat.permission.title.overwriteFile
chat.permission.title.question
chat.permission.title.readOutside
chat.permission.title.runCommand
chat.permission.title.sandboxDenied
chat.permission.title.sandboxDeniedDescription
chat.permission.title.writeOutside
chat.permission.verb.reach
chat.permission.verb.read
chat.permission.verb.write
chat.question.previous
chat.question.progress
chat.question.submit
chat.queue.edit
chat.queue.editLabel
chat.queue.fewer
chat.queue.label
chat.queue.more_one
chat.queue.more_other
chat.queue.problem.noAnswer
chat.queue.problem.restarted
chat.queue.problem.wentOut
chat.queue.remove
chat.queue.waiting.permission
chat.queue.waiting.step
chat.queue.waiting.turn
chat.run.done_one
chat.run.done_other
chat.run.stopped
chat.run.usage
chat.subagent.done_one
chat.subagent.done_other
chat.subagent.failed
chat.subagent.kind.browser
chat.subagent.kind.component
chat.subagent.kind.delegate
chat.subagent.kind.generic
chat.subagent.open
chat.subagent.steps_one
chat.subagent.steps_other
chat.subagent.stopHint
chat.tool.diff
chat.tool.earlierSteps_one
chat.tool.earlierSteps_other
chat.tool.meta.exit
chat.tool.meta.lines
chat.tool.meta.matches_one
chat.tool.meta.matches_other
chat.tool.moreSteps_one
chat.tool.moreSteps_other
chat.tool.openFile
chat.tool.show
chat.tool.showAll_one
chat.tool.showAll_other
chat.tool.status.done
chat.tool.status.failed
chat.tool.status.needsYou
chat.tool.status.refused
chat.tool.status.running
chat.tool.status.stopped
chat.transcript.jump
chat.transcript.jumpNew_one
chat.transcript.jumpNew_other
chat.transcript.label
chat.transcript.new_one
chat.transcript.new_other
chat.transcript.olderFailed
chat.transcript.showEarlier
chat.transcript.showLater
chat.view.gone
chat.view.unavailable
```
