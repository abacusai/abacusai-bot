Paths are relative to `apps/desktop/src/renderer-next` at `4a22315f`.

1. **Major — `features/bots/chat/slots.tsx:244`** — While the default-mode query is pending, the composer sends `AgentMode.Yolo`, overriding a configured Normal mode on admission. Await the configured mode before enabling submission. Test sending with that query delayed.

2. **Major — `features/bots/watcher.tsx:124`** — Completion notices advance `lastEventId` before bots/routines snapshots are ready. Attribution then fails and the notice is permanently discarded, losing unread state, cues and notifications. Buffer notices until both collections finish preloading; test a mounted watcher with delayed snapshots.

3. **Major — `features/bots/form/submit.ts:165`** — Concurrent check-in edits overwrite untouched fields. If this window changes only Paused while another changes 09:00 to 10:00, remote sync skips the entire edited `checkIn` object, and saving restores 09:00. Track schedule and enabled changes independently and merge untouched leaves from the live routine.

4. **Major — `features/chat/kit/message.tsx:365`** — Bot messages render unfiltered parts and `WorkedThrough`. A message with visible prose also exposes thinking, migrated search results and step history outside the required spoken-parts whitelist. Apply bot-specific filtering while retaining permission cards. R3-T19 renders decoration fragments, so it misses the actual transcript behavior.

5. **Major — `features/bots/form/look-picker.tsx:79`** — Every non-`none` accessory remains disabled despite main/shared support now existing. `submitCreate` also omits `avatarAccessory`, and both collection field lists omit it, causing accessory updates to be rejected as read-only. Enable selection, include the field throughout persistence, and test create/update round-trips.

6. **Major — `features/bots/chat/slots.tsx:100`** — URL deliverables discard `target.url` and open an unfilled browser tab. Primary clicks and automatic URL previews cannot display their destination. Implement the browser handoff and retain the URL. R3-T33 checks targets and callbacks without exercising this route.

7. **Major — `components/file-preview/file-preview.tsx:194`** — PPTX previews replace the old visual viewer with paragraph outlines. Images, layouts, tables and formatting disappear; image-only slides become blank numbered entries. Port the read-only visual viewer. The test finding “Hi” does not establish preview parity.

8. **Major — `components/file-preview/file-preview.tsx:161`** — PDF/HTML previews bypass `hostRoot` and construct raw file URLs. A guest path such as `/workspace/report.pdf` loads the host’s `/workspace/report.pdf`, rather than the mapped workspace file. Resolve guest paths through the host file boundary before loading the viewer; add PDF/HTML guest-path tests.

9. **Major — `lib/bots/check-in.ts:74`** — Time validation applies when check-ins are Off. Selecting Daily, clearing its time, then selecting Off leaves an invisible invalid value that blocks submission. `CheckInFields` displays no validation error. Validate only fields relevant to the selected preset and expose active-field errors.

10. **Minor — `lib/bot-turns/turns.ts:132`** — Duplicate reaction suppression operates on whole messages. After a successful reaction, `[text("👍"), text("Here is the report")]` retains the duplicate emoji; mixed-message trailing emoji also escape streaming suppression. Filter and hold individual text parts, with live and migrated rendering tests.

11. **Minor — `routes/_shell/(bots)/bots.$botId_.chats.$sessionId.tsx:57`** — “Back to files” preserves `search.preview`, so sender and check-in previews remain open. Clear `preview` explicitly, as the forever-chat route does, and verify the files list returns.

12. **Major — `features/bots/form/form.test.tsx:103`** — The remote-sync test exercises `FormApi.setFieldValue` directly, then assigns the baseline to current values before comparing them. Removing the production remote-sync effect leaves it passing. Mount the editor and test successive remote updates, blurred untouched fields, preserved user edits and outgoing patches.

13. **Minor — `features/bots/data/data.test.ts:80`** — Loader tests preload collections in `setup()` before invoking the loaders. Removing their preload awaits leaves these assertions passing. Use delayed cold snapshots and assert that lookup, opening and hydration wait for readiness; exercise hover-then-click through the router.

14. **Minor — `features/bots/interactions.test.tsx:76`** — The model-count selector references composer attributes that `ModelChip` never renders, and the count is checked only in the Details-only case. Removing both `layoutId` assignments leaves the test green. Mark both actual model-value nodes, assert all four cases, and record the native morph at 1280 and 1000.

15. **Minor — `lib/theme.bots.test.ts:52`** — R3-T8 computes token contrast without checking rendered borders. Removing the control and dot border rules leaves it passing. Assert actual computed, composited boundaries on swatches, selected shapes, dots and accent controls in the browser.

16. **Minor — `features/bots/data/use-attention.ts:43`** — All callers leave the running-tool caption null, and avatars never consume streaming text/reasoning. Required talking/thinking states never occur, while sending triggers happy instead of wink. Wire chat activity through the route and test actual stream/send transitions; rendering every mood independently does not prove this integration.
