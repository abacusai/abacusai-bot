# Spec 00 sub-slice C, second part (step 1 transcripts-v2, thread store, step 4 rules): implementation review (Claude r1)

Scope: `git diff 70a3ec36..d4652ce6 -- apps/desktop/src/shared/transcript apps/desktop/src/main/migrations/steps apps/desktop/src/main/services/session apps/desktop/src/main/rpc/deps.ts`, plus the `pending` change in `runner.ts`/`types.ts` from 656bd76a. Checked against spec 00 C.3/C.5/C.7/C.9 and "Implementation notes (sub-slice C), Second part". Consumers checked: spec 02 §5 and §14. Old UI checked: `renderer/conversation/{hydration,serialization,persistence,derivations}.ts`, `renderer/components/chat/{render-utils.ts,feedback-row.tsx,injected-text.ts}`. Protocol checked: `packages/agent/src/protocol.ts` `ConversationSegment`. The runner rewrite in `.claude/worktrees/agent-a5cb21e509bea9104` (attempt ids, mid-merge) was read for the `pending` interaction only.

Line numbers are at d4652ce6.

## Findings

### 1. High: one bad file fails all of step 1, and the failure blocks every later step on every launch
`main/migrations/steps/001-transcripts-v2.ts:59-90`, `004-archive-transcripts-v1.ts:61-122`, `transcript-files.ts:72-91`.

The loop has no per-file isolation. The mapper is total, but the code around it can still throw:
- `JSON.stringify(thread)` throws `RangeError: Invalid string length` when the v2 text is longer than V8's maximum string length. v2 is about 1.5 to 2 times the size of v1 (finding 6), so a v1 file of a few hundred MB is enough.
- `fs.writeFileSync` into staging can fail with ENOSPC or EACCES.
- A file can disappear between the `readdir` and the read.

Any of these rejects `plan`, and the runner records `lastFailure` and stops. The next launch retries from step 1 and fails the same way, so step 2 (prefs) and every later step never run on that machine.

**Fix:** wrap each file in `try/catch`, count it (`failed`, `tooLarge`) and log it, then continue. `stat` before reading and skip anything over a size cap as `tooLarge`, not as `corrupt` (see finding 7). Step 4 needs the same guard.

### 2. High (cut-over): nothing removes an orphaned v1-derived twin, so cleared history comes back once the "v1 gone" rule is removed
`main/services/session/thread-store.ts:119-129`, `transcript-service.ts:100-113`, `004-archive-transcripts-v1.ts:44-122`.

Today "cleared stays cleared" rests on one rule in `readCurrentFile`: a v1-derived twin whose v1 file is gone is treated as cleared. Such orphans are real. They are left by:
- a crash between the two `rmSync`s in `TranscriptService.remove`;
- a failed v2 removal;
- a session deleted by an older build after a downgrade (v1 removed, v2 left).

Step 4 archives every v1 file. After it runs, every migrated twin is a "v1-derived twin with no v1", so the rule must be removed in the same build (the notes say so). Once it is removed, every orphan above is served again. Step 1 and step 4 only walk `transcripts/`, so no step ever cleans `threads/`.

**Fix:** before archiving, step 4 lists `threads/` and archives (moves to the backup) every `transcript-v1` twin that has no v1 file. Add a C-T9 case for it. Also add a test in the cut-over build that `ai.hydrate` still serves a thread whose v1 was archived. That makes the dependency between removing the rule and running step 4 explicit.

### 3. Medium: a twin written by a newer build counts as "corrupt" and is overwritten without a backup
`shared/transcript/thread-file.ts:109-119, 143`, `thread-store.ts:133-141, 154-163`.

`parseThreadTwin` returns `corrupt` for any `version !== 2` and for any `source.kind` other than `agui` or `transcript-v1`. The dual-write (`writeFromV1`) and the repair (`readCurrentFile`) then overwrite a `corrupt` twin with no backup. Step 1 at least backs it up as `replace-user`.

So after a downgrade, a thread file from a newer build (say `version: 3`, or a new source kind) is silently replaced by v1-derived content on the next save or hydrate. The notes say the minimal parse exists so that "a future `agui` field can never make its file look corrupt". A version bump defeats that.

**Fix:** keep `corrupt` for unparseable JSON or a non-object only. A parseable object with an unknown `version` or `source.kind` becomes `foreign`, which is never written by the dual-write, the repair, step 1 or step 4, and is counted and logged.

### 4. Medium: freshness depends on wall-clock `updatedAt`, and equal times count as current
`thread-file.ts:147-173`, `thread-store.ts:131-133`, `transcript-service.ts:76`.

`TranscriptService.write` stamps `updatedAt` with `new Date().toISOString()`, which has millisecond resolution and follows the wall clock. `decideConversion` skips a twin when `twin.updatedAt >= v1.updatedAt`.

Two cases leave a stale twin that `readCurrent` reports as current until the next v1 write:
- two v1 writes land in the same millisecond, and the second dual-write fails;
- the clock steps backwards (NTP or a manual change), and a dual-write fails.

The C-T7 test `await`s 5 ms before the failing write, which avoids exactly this case (`thread-store.test.ts`, "keeps onPersist…").

**Fix:** add a content fingerprint to `source`, for example `segments` (already stored, never compared) plus the byte length of the v1 text or a cheap hash. `decideConversion` converts when the fingerprint differs, whatever the times say.

### 5. Medium: the dual-write doubles main-thread work on the old renderer's save path
`transcript-service.ts:87-91`, `thread-store.ts:148-164`.

The old renderer saves every 750 ms per streaming session (`persistence.ts:16`). Each save now also runs, synchronously in main:
- a full mapping;
- `JSON.stringify` of a file larger than v1 (finding 6);
- a second atomic write.

The first dual-write per session in each launch also reads and fully `JSON.parse`s the existing twin, only to learn its `source.kind`. For a large session this is main-process jank on the IPC path every window uses, which conflicts with "old renderer unchanged". Meanwhile no shipped consumer reads v2 (the new renderer is not shipped), and `readCurrent` already repairs stale twins on demand.

**Fix:** coalesce the dual-write (a trailing debounce of a few seconds, or write on idle or on session switch), or drop it until the cut-over and rely on the repair. If it stays, keep the `source` classification in a small in-memory cache that the first repair or dual-write populates, rather than parsing the whole file.

### 6. Medium: v2 files store each tool output two or three times
`shared/transcript/v1-to-ui-messages.ts:283-321`.

Each tool is stored as:
- `call.output`: the legacy output;
- `result.content`: the same output again;
- `result.metadata.abacus.data`: for `bash`, `read` and `generic`, the same text a third time (`data.output` / `data.content`);
- `arguments` and `input`: the args twice, once as a string and once as an object (for `write`, that is the whole file body twice).

Tool-heavy threads come out at roughly 1.5 to 2 times their v1 size. That size is paid:
- on disk;
- by the dual-write;
- by every `ai.hydrate` page, since `readCurrent` re-reads and parses the whole file per page (`rpc/procedures/ai.ts:52`);
- by step 1's staging, which holds a converted copy of every thread before the commit, so peak disk use is roughly v1 + 2 × v2.

**Fix:** spec 02 §5.4a already reads `call.output ?? result.content`, so omit `call.output` whenever a result part is emitted. Do not also copy `data.output`/`data.content` when it equals `output`; store a marker instead. Check free space before step 1 plans, or stage and commit in batches.

### 7. Medium: memory is not "one file at a time", and a large valid transcript can be quarantined and later pruned
`transcript-files.ts:72-91`, `004-archive-transcripts-v1.ts:68-88`, `thread-file.ts:95`.

- `inspectTranscript` returns `twin`, which contains the fully parsed existing v2 file (`ThreadTwin.file`). That object stays alive through the conversion even though only `source` is used. Peak memory per file is therefore the parsed v1, the parsed old v2, the new v2 object and its serialized string: about 5 to 7 times the largest file. The C.9 "1 MB read buffer" is not implemented, which the notes acknowledge.
- `readFileSync(file, "utf8")` throws `ERR_STRING_TOO_LONG` above the maximum string length, and step 1 classifies that as `corrupt`. At the cut-over, step 4 reads the same file as a Buffer (which succeeds) and **quarantines** it. Quarantine is pruned after 90 days, so a valid but very large transcript is eventually deleted without ever being converted.

**Fix:**
- Do not keep `file` in the twin that steps 1 and 4 use (return only `status`/`source`).
- Classify read failures separately: `tooLarge` and `unreadable` are never quarantined; they are kept in place and listed.
- Either implement a streaming conversion for large files or state a hard size limit in the spec.

### 8. Medium: several segments for one tool call become several parts with the same call id
`v1-to-ui-messages.ts:499-506`, compared with `renderer/conversation/derivations.ts:497-518` (`omitSupersededToolLifecycleSegments`).

The old UI shows only the newest segment per `toolCall.id` across the transcript. The mapper emits a tool-call part (and a result part) for every such segment. The result is two tool-call parts with the same `id`, and two tool-result parts with the same `toolCallId`. TanStack pairs results by `toolCallId`, and the kit keys tool rows by it (spec 02 §5.4), so v2 renders the call twice or pairs the wrong result, where the old UI rendered it once.

**Fix:** within a thread, keep only the newest segment per call id, as the old UI does. Record each superseded segment in `segments[]` with `partIndex: null` and `supersededBy`. Add a golden fixture.

### 9. Low/Medium: when a user text closes a bracket, the bracket's own later close frame is ignored
`v1-to-ui-messages.ts:382-400, 439-460, 624-633`; fixtures `user-inside-bracket.json`, `subtask-edges.json`.

A user text inside a bracket closes it as `finished`. When the bracket's own `completed` frame arrives later, it is treated as unmatched: it opens a new assistant message (`sub-u:1`), and its `outcome` and `endTime` are never applied. The old UI keeps the bracket open across the user text (`hydration.ts:18-66`), so there a late `outcome: "interrupted"` does settle the card as interrupted, and v2 disagrees with the old UI.

Also, the serializer writes a close frame for every settled bracket (`serialization.ts:137-153`). An unclosed bracket followed by a user text therefore means the sub-agent was still running when the file was saved. `finished` overstates that. The `subtask-edges` fixture itself describes `sub-open` as "Left open by a crash", yet its golden asserts `status: "finished"`.

**Fix:** remember the brackets closed by inference (hand-back, user text), keyed by id. A later `completed` frame with that id updates that part's `status`, `endTime` and `segments` instead of opening a message. Consider `error: interrupted` for a close caused by a user text. Add a golden with a late `outcome: "interrupted"`.

### 10. Low: message ids are unique, but the `:n` scheme is ambiguous and unstable, and other ids are not deduplicated
`v1-to-ui-messages.ts:340-348, 413`; `rpc/procedures/ai.ts:55-61`; `packages/agent/src/agui/ids.ts`.

- **Same grammar as other ids.** The mapper's suffixes (`:1`, `:0` for the child message, `:result`, `:approval`) use the same `:` grammar as the agent's ids (`${runId}:user`, `${toolCallId}:result`, `${messageId}:think:n`, `${subagentRunId}:${legacyId}`). A deduplicated id cannot be told apart from a real one. When an `agui` writer appends to a migrated thread, only luck prevents a collision with the ids spec 02 relies on (§14.11, R2-T33).
- **Stable under append only.** A `:n` suffix and the `segment-<i>` fallback are assigned by position. When the old renderer rewrites a file with earlier segments gone, an id can move to another message. The kit's `before` cursor then no longer matches, and `ai.hydrate` silently returns the newest page again (`findIndex === -1` → `end = messages.length`).
- **Only message ids are made unique.** A repeated `created` id gives two `SubagentPart`s with the same `subagent.id`, which spec 02 §5.5 uses for `onOpenSubagent` and `SubagentScope`. `tool-result` ids (`${segmentId}:result`) and approval ids repeat in the same way.

**Fix:**
- Use a separator the agent never produces, such as `#2`.
- Apply the same `claim` to `subagent.id` and to result-part ids.
- Make `ai.hydrate` answer an unknown `before` with an empty page (or an error) rather than the newest page.

### 11. Low: turn fields are dropped inside brackets and after the first value in a message
`v1-to-ui-messages.ts:354-380, 638, 654`.

Segments routed into `open.child` never call `takeTurnFields` and never split on `messageIndex`, so their `messageIndex`/`regenerateAttempt`/`versions` are lost. Outside brackets, the first value wins, so a later, different `versions` in the same message is dropped too. Neither value appears in `segments[]`.

**Fix:** record `messageIndex` (and `regenerateAttempt` when present) on each provenance entry.

### 12. Low: the "nothing is dropped" claim holds only for unknown types
`v1-to-ui-messages.ts:145-202, 336`.

Known segment types lose any fields the mapper does not name: extra keys, `isSpinny`, and a `toolResult.toolCallId` that differs from `toolCall.id`. A non-record `args` becomes `{}` (fixture `r-bad-args`). For the protocol shape, `toolUseRequest.type` is dropped, and so is `toolUseRequest.args` whenever `input` is present.

**Fix:** keep unrecognised keys in `metadata.abacus.extra` (or keep the raw segment for known types when it has extra keys), or weaken the claim in the file header and the notes.

### 13. Low: a nameless tool call becomes a visible part
`v1-to-ui-messages.ts:153-154`, compared with `hydration.ts:155` and `serialization.ts:23`.

The old UI drops a `tool_call` whose `name` is `""`. The mapper emits a tool-call part with an empty name, which the kit renders as a nameless `ToolLine`.

**Fix:** map it as `unknown` with `raw`.

### 14. Low: any read error on the v1 file is treated as "cleared"
`thread-store.ts:45-51, 127-129`.

`readText` returns null for any error, not just ENOENT. EACCES, EBUSY or EMFILE (for example a Windows antivirus lock) therefore makes `ai.hydrate` return an empty thread, even when a good twin exists.

**Fix:** only ENOENT means cleared. For other errors, serve the twin as it is, without repairing it.

### 15. Low/Medium: `pending` and the runner, now and after the attempt-id rewrite
`runner.ts:305-344` (d4652ce6); the rewrite in worktree `agent-a5cb21e509bea9104`, `runner.ts:542-554`.

At d4652ce6:
- A deferred commit leaves no record anywhere. If `removeStaging` fails after it (the failure is only logged), the next launch finds a journal whose commit is not recorded and undoes a commit that had finished. That moves the archived v1 files back, and the next run redoes the work. It self-heals, but it churns.
- `lastFailure` is not cleared on a deferred commit.
- Later steps run while an earlier id is still unrecorded, which breaks the "ascending id" guarantee for any future step that depends on step 4.

In the rewrite, `pending` appends a `recorded` log line, so recovery treats the attempt as finished. That fixes the first point; keep it through the merge, and keep a test for "crash after `recorded`, before staging deletion" on a pending plan. Three more points for the rewrite:
- **Honour `isWriteBlocked`.** `ThreadStore` (dual-write and repair) and `TranscriptService` should respect it. An unresolved step 1 or step 4 attempt covers `threads/<id>.json` and `transcripts/<id>.json`, and nothing stops the dual-write from writing into a destination that recovery may later roll back.
- **Bound repeated partials.** If `pending` never reaches 0 (for example a v1 file without `updatedAt` whose mtime keeps changing), step 4 runs on every launch forever. Record the step anyway after N launches with an unchanged `pending`, or set `lastFailure`.
- **Stop after a deferred step** (`break`, not `continue`), or document that no later step may depend on step 4.

### 16. Medium (consumer gap, spec 02): what the old UI derives from this data that the kit spec does not cover
None of these is a mapper bug: v2 keeps every byte. But spec 02 §5 says nothing about them, and C.9 names the kit as the dependency.
- **Injected text.** `visibleUserText` (`injected-text.ts`) strips `<system_reminder>` blocks and hides routine-fire user messages entirely. The kit would show them as user bubbles.
- **Attachments.** Pills and thumbnails are rebuilt from the `@/abs/path` references in user text (`user-file-refs.ts`, `temp-image-refs.ts`).
- **Feedback row.** Its rating index is `2 × userTextCount − 1`, counted positionally over all user texts (`feedback-row.tsx:29-59`), and it folds in the turn's credits.
- **Content the old UI never rendered.** `web_search_results` and `media` have no case in the old UI (`render-utils.ts:204-265`). v2 plus spec 02 §5.3 will show them for the first time in migrated history.
- **Credits inside a bracket.** They land in the child message's `metadata.abacus.credits`, where the §5.3 footer (top-level messages) never shows them. The old UI hid them too.
- **Protocol-shape tools.** Their diff and display data sit in `call.metadata.abacus.legacy.toolDisplayData`, which §5.4a's migrated normalisation does not read. No producer writes this shape today.

### 17. Tests and goldens that do not prove their claim
- **`001-transcripts-v2.test.ts` "streams a large folder, yielding and reporting progress"** passes without any mid-loop yield. The label assertion is satisfied by the final `ctx.progress(names.length, …, "Upgrading chat history")` alone, and nothing observes "one file at a time". Assert a progress call with `0 < done < 1000` before the end, and a `setImmediate` spy. Drop the memory claim, or test it with an fs double that counts open files.
- **C-T2 "every part-producing segment's id is on its part"** also passes if every segment were mapped to `unknown`, because `kindText` carries `segmentId`. Add: well-formed generated segments are never `kind: "unknown"`, and each part's content equals the segment's text, query, summary, URL and so on.
- **C-T2 bracket frames.** The generator gives `created` and `completed` frames independent ids, so the matched-close path (the reason given for checking a multiset) is exercised only by the 3% `"dup"` ids. Generate paired frames, including late closes (finding 9).
- **C-T2 schema.** `ThreadFileV2Schema` is `looseObject` throughout and does not check `ThinkingPart` or subagent metadata, so "parses with the schema" proves little beyond the part `type` names.
- **`subtask-edges` golden** asserts `finished` for the bracket its own fixture calls "Left open by a crash" (finding 9).
- **`user-inside-bracket` golden** uses `outcome: "completed"` on the late close, so it cannot show that the outcome is dropped (finding 9).
- **C-T7 "keeps onPersist when the v2 write fails"** makes the write fail with `chmod 0500`, which does nothing as root and on Windows. It also sleeps 5 ms to avoid the equal-timestamp hole (finding 4). Fail the write with an injected fs error instead, and add the same-millisecond case.
- **Missing tests:** an unknown-version or unknown-kind twin under the dual-write and the repair (finding 3); duplicate tool call ids (finding 8); an orphaned twin at step 4 (finding 2); `ai.hydrate` with a `before` that no longer exists (finding 10); a v1 file over the size cap (findings 1 and 7).

## Confirmed correct

- **Legacy transcripts are never modified.** Step 1, `inspectTranscript` and `readCurrentFile` only read `transcripts/`. The C-T4 test hashes the legacy files before and after. There is no diff under `renderer/` or `preload/`.
- **The mapper is total, deterministic and pure.** Non-objects, unknown types, known types missing required fields, and `at` values that are out of range or non-finite all map to something. The output depends only on the input. The input is never mutated; the output only shares references (`raw`, `input`, `results`).
- **C.3 tool-state table.** Rows and precedence are implemented as written, including row 2's synthesised `error: "failed"` versus a stored `error`, and "outcome ⇒ state error". The fixture covers every row.
- **Sub-agent state machine.** It matches `hydration.ts` for `created`, hand-back, a matched close with and without `outcome`, an unmatched close (recorded, not dropped) and an open bracket at end of file (interrupted). Nesting cannot occur in v1: a `created` while a bracket is open is a hand-back. A user text inside a bracket closes it and becomes a user message, which is better than the old UI: the old UI tags that user text into the bracket and hides it from the main thread.
- **Message boundaries.** User messages and `messageIndex` splits follow C.3. The child message's `:0` id is claimed in the same set, so every message id in a thread is unique (C-T2 checks this recursively).
- **`agui` twins are never overwritten** by the dual-write, the repair or step 1. Step 4 keeps a v1 file whose `agui` twin was migrated from an older v1.
- **`TranscriptService`.** The v2 write comes after the v1 rename and is isolated, so `onPersist` still runs when it fails. `remove` deletes both files on every path: reset (legacy IPC and `agent.reset`), session delete and workspace delete, all tested through the real `ServiceHost`.
- **Atomic, serialized writes.** All writes use `writeFileAtomicSync`, whose `.tmp` names the walker ignores. Writes, removals and repairs are synchronous in main, so they cannot interleave within the process, and neither file can be left half-written.
- **Session ids.** `isSafeSessionId` is shared and guards both paths, including `ai.hydrate` input.
- **Step 1 is idempotent and resumable.** A rerun plans nothing. A corrupt twin is backed up as `replace-user`. A `create` whose destination appears later is promoted to a backed-up write by the runner. A crash before the record point is undone and the step reruns.
- **Step 4** follows the C.5 rules and is registered only in its test.
- **Wiring.** `ai.hydrate` is wired to `ServiceHost.threadStore`.
