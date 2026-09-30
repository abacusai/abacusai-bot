Paths below are relative to `apps/desktop/src/renderer-next`; lines refer to `505d04bf`.

1. **Major — `features/settings/account-usage.tsx:116`** — Sign out is offered for environment-authenticated Abacus accounts. Main cannot remove that credential, but the default checked option can delete other stored API keys. Gate sign-out with `settings.get` and `canSignOutOfAbacus`, preserving the old renderer’s stored-key restriction.

2. **Major — `features/routines/form.tsx:142`** — Successful saves replace the baseline with trimmed values while retaining raw form values. Submitting `" Brief "` leaves `changed()` true and triggers the discard blocker after persistence. Edit has the same defect at line 114. Reset the form to parsed values before navigating; test successful submission with surrounding whitespace.

3. **Major — `features/routines/page.tsx:328`** — Editor history initializes once, but navigating between routine IDs does not remount `EditorChat`. Messages, drafts and gone state carry across routines; subsequent submission saves mixed history under the second routine. Add `key={row.id}` at line 296 and test navigation between distinct histories.

4. **Major — `features/routines/run-requests.tsx:79`** — Failed connector hops only set an error. They never send the supported `{ outcome: "failed", error }` response required by §7.4, leaving the agent’s tool call blocked. Extend `respond` and settle failed hops and refresh failures explicitly.

5. **Major — `features/routines/globals.tsx:64`** — Global routine attention depends on a lazy routines collection that it never hydrates. Cold-opening Settings mounts no routines contributor, so valid fires, attention and completions are discarded. TanStack DB’s `get()` and `toArray` do not start synchronization. Hydrate and retain the collection globally; buffer early events before marking attempts seen.

6. **Major — `features/library/messaging.tsx:198`** — Closing unfinished setup opened directly from Messaging leaves its platforms enabled. Connect only navigates, so `settlePairing()` finds neither an active flow nor a deferred entry and returns. Register direct setup with the shared flow, or independently settle sheet closure from fresh status. Test direct Connect followed by Escape, Done and navigation.

7. **Major — `features/library/messaging.tsx:384`** — Unlink only disables platforms. It never invokes `messaging.unlinkShared`, so Discord/Telegram retain their remote link and reconnect to the same account when enabled again. Await remote unlink before disabling, update the snapshot, and surface failures.

8. **Major — `features/library/mcp.tsx:78`** — Losing the selected session retains its runtime statuses and logs. An outstanding `servers(scope)` response can also overwrite a newly selected session. Clear state when scope disappears and key requests by session/workspace, ignoring responses from superseded scopes.

9. **Major — `features/library/mcp.tsx:207`** — Refresh announces success regardless of `{ success: false, error }`. OAuth sign-in similarly refreshes after failed authentication, and Restart discards its outcome. Inspect each result, show failures unless cancelled, and refresh only after successful authentication.

10. **Major — `features/settings/models.tsx:74`** — `isFetchedAfterMount` stays true after the first fetch; it does not prove counters postdate a later exhaustion mark. Old positive counters therefore clear a new warning. The request also omits `refresh: true`, allowing main’s cache to supply stale counters. Force refresh on mark changes and compare response freshness with the mark. R5-T23 supplies the Boolean manually and cannot catch this integration failure.

11. **Major — `features/settings/updates.tsx:55`** — Install retry is treated as another failure. Main publishes `installing: true` while retaining the previous `error` and `failedPhase`; this handler clears `clicked`, and `updatePhase` continues reporting failure. Preserve the installing state through retry and clear historical failure fields at the install transition. R5-T27 tests only the selector, not this event sequence or dialog.

12. **Major — `lib/theme-effect.tsx:39`** — Text size and bubble tint write `--chat-font-size` and `data-bubble-tint`, but the target renderer contains no consumers. Both controls persist values without changing the chat. Connect them to transcript/composer typography and bubble styling, then verify rendered styles.

13. **Major — `lib/keyboard/actions.ts:42`** — Stop run is advertised as rebindable, but the composer still registers literal `Mod+.`. The new action-based hook has no consumer there. Changing or unbinding Stop does nothing, and reassignment can leave competing handlers. Wire the composer through the shared action-based registration and test actual key events after rebinding.

14. **Major — `components/keymap-editor/index.tsx:58`** — Conflict validation checks only the edited ID’s nominal context. Shared window bindings also apply in terminals: assigning Toggle side panel to `Ctrl+Shift+W` on Windows passes the window check but collides with terminal Close tab. Validate every affected context, including terminal reserved keys, before saving.

15. **Major — `features/artifacts/index.tsx:141`** — The virtual window assumes 180 px grid rows, while rendered rows have 180 px cards plus a 10 px gap. Eviction moves card anchors, and selection scrolling uses the same wrong stride. Include measured gaps consistently in spacers and offsets, and align windows to complete rows. R5-T31’s arithmetic tests pass without rendering the grid.

16. **Minor — `features/artifacts/index.tsx:142`** — The one-shot resize effect returns permanently when the initial list is empty. Artifacts arriving later retain the guessed 800 px width through pane resizes. Attach the observer with a callback ref or rerun it when the viewport appears.

17. **Minor — `features/library/skills-tools.tsx:47`** — Selecting Global removes `workspace`, after which the resolver immediately falls back to `prefs.lastPickedWorkspaceId`. Global cannot be selected when a default workspace exists. Preserve an explicit global scope and test the resulting `listInstalled` input.

18. **Minor — `features/shell/hotkeys.tsx:125`** — Toggle side panel omits `actionId` metadata. Recording its existing chord makes live conflict detection identify its own registration as an unknown fixed action, producing a Cancel-only conflict. Supply its action metadata and test that editing excludes every registration of the same action.
