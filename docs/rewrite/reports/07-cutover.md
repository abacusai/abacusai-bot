# Release N cut-over evidence

Worktree: `codex-cutover`, starting at `c92812e7`. This report separates implementation checks from release acceptance. A missing hardware, signed-artifact or last-release comparison is a gap, never a passing gate. C15 is excluded: the production registry remains `[1, 2, 5]`.

## Prerequisites verified on the starting tree

| Prerequisite | Code evidence | Regression evidence |
| --- | --- | --- |
| P1 strict archive enumeration | `migrations/steps/transcript-files.ts`, step 4; enumeration failures cannot authorize orphan removal | Step-4 failure tests |
| P2 held changes | `services/session/held-files.ts`; shared thread store; startup replay immediately after migrations | Thread-store recovery tests |
| P3 transactional activation | `experience-updater.ts`, store pending activation; scheduler commits after readiness | `experience-activation.test.ts` and renderer-host suites in broad run |
| P4 main keep-awake | `followMainAgentBusy`, relay aggregate busy; AG-UI excludes compat turn-state ordering | `keep-awake.test.ts`, `agent-busy.test.ts` |
| P5 taps framing | CLI manager splitter streams UTF-8, drops complete oversized lines and waits for both EOFs before exit | `line-splitter.test.ts`, `cli-manager-taps.test.ts` |
| P6 bounded fallback | ThreadStore streams retained 64–512 MB v1 without writing a conversion; larger files produce clearable notices | `stream-v1.test.ts`, thread-store suites |

The focused prerequisite run passed 85 tests in seven files. The broader run also exercised activation and RPC suites.

## Stack

Commit numbering follows the spec's C1–C14 headings. The task brings the restore command into N while keeping retirement steps unregistered; that overrides the spec's C15 command timing.

| PR | Implementation | Local checks | Remaining release evidence |
| --- | --- | --- | --- |
| C1 | Per-thread evidence (ignoring the global archived hint), invalid-index logging, retirement-aware startup import and step-3 plan; completed attempt manifests/index; retained partial generations; stop after partial; marker retirement proof; held replay and quit flush | Focused 174 tests; broad 4,333 passed / 484 files, one skipped suite and seven pre-existing chrome TODOs; 13 existing crash matrices (the earlier failing run reached 5,250 kill points; the passing run did not print a count); two additional actual step-3/4 runner-mutation matrices pass; TypeScript, oxlint (legacy warnings only), registry, legacy-diff and scoped knip pass | Real N+1 partial-home downgrade through packaged N; real last-release synthetic fixtures. Step planning uses direct fs rather than injected runner IO, so the kill matrix covers runner mutations, not kills inside every planner read/write. |
| C2 | Hidden probes wait on native events; recreate IPC is wco-only; mode-matched health checks; compatibility refusal memo; fresh install admission and download cancellation; API coupling check; seven chrome cases now executable | 74 tests in ten files; real macOS Electron chrome: five pass, two Linux-only cases skipped; TypeScript and oxlint pass | Windows/Linux CI; chrome fixture uses real BaseWindow/RendererHost but does not prove every production popup, browser-runtime layout, pre-exposure geometry, persisted-route recreation or signed artifact. Private feed withdrawal/install-on-quit and already-shipped clients need release-pipeline evidence. |
| C3 | Main-only activity beacon; versioned, validated complete draft registry with live-store hydration; full bot edits and baseline; anchored DOM continuity; 4 MB stand-down; awaited/logged stage 2 before exposure; log rings in both entries | 85 focused tests in 11 files; two real Electron MessagePort/readiness tests with delayed candidate stage 1 and stage 2, capture/restore/flip timestamps; TypeScript, oxlint and scoped knip pass | Packaged production-route draft demonstrations and virtualized off-window anchor restoration; Windows/Linux execution. |
| C4 | Source-derived renderer and agent provenance; builder/install agreement checks; pinned Turbo environment; production-only graph and content checks; dev harness elimination; bounded renderer/companion smoke outcomes; CI exit-status checks; gzip baseline | Production Vite build and release checker pass; gallery build rejected; 55 desktop tests, 14 updater tests, two Node provenance/cache-configuration tests; desktop and script TypeScript and oxlint pass | Actual agent-only hotfix cache miss and same-commit cache hit have not been executed. Packaged smoke and signed pipeline still pending. Size baseline is a local build measurement, not M1–M6. |
| C5 | **Partial implementation; release gate open.** Default wco with unpackaged legacy override; API 2 desktop/updater; API-2 notch-entry requirement; experience classifier; AG-UI spawn CI; exact 313 feature parity ids and parsed declaration checks; legacy blob inventory; notch Settings and tour replay handoff | 4,370 unit tests / 491 files; 11 integrity tests and four health-check tests after adding the missing-notch refusal case; 122 parity/bot tests after consumer corrections; 14 updater tests; four real agent spawn cases; four Node checks. Required Electron run: 301 pass / one performance failure / two Linux skips; isolated rerun passes all nine chat-kit cases, yielding passing evidence for 302 distinct cases. TypeScript, format, lint, registry, legacy-diff, scoped knip and locale checks pass. Production release checker and experience build pass. | Bridge map consumer column, frozen bridge enumerations/sign-off, final green/retired/deferred schema with evidence and PLAN anchors, release-note generation and packaged per-area demonstrations remain unfinished. Source-API fixture generation and a comparative CDP driver are now implemented in part, as detailed below. Synthetic source fixture completion, reference-machine performance acceptance, bridge consumers and packaged demonstrations remain open. The user-login comparison below supplies local M1–M6 observations. The unsigned directory smoke now handles a missing updater configuration without a fatal-pattern error; three-OS T16 acceptance remains open. |
| C6 | Not started; entry switch/deletion gate remains behind C5 | Not run | Legacy tree, entry and oracle moves remain. |
| C7 | Not started | Not run | Renderer rename, complete project scope and canary checks remain. |
| C8 | Not started | Not run | Legacy preload/window.api/raw IPC removal remains. |
| C9 | Not started | Not run | Generation/chrome collapse and Linux native-frame CI remain. |
| C10 | Not started | Not run | CLI/default wire removal, frozen oracle recorder, fragmented manager byte-identity cases and final CI wire step remain. |
| C11 | Not started | Not run | Live legacy preferences sync/dual writer removal remains; startup import must stay. |
| C12 | Not started | Not run | Removed-dependency checker/removal, final size limits and v1Archived option removal remain. |
| C13 | Not started | Not run | Keymap application, final consumer enumeration and locale purge remain. |
| C14 | Not started | Not run | Packaging corrections, restoration command, support article, release notes, rollout rule and final release acceptance remain. |

## Open evidence gaps

- R7-T10–T13, T11b and T32 require homes created by each retained real shipped build with synthetic data, including dormant-release drift, profiles, clearing and oversized histories. Hand-authored unit fixtures do not prove these gates.
- R7-T24 / M1–M6 require both specified reference machines and complete probe evidence. The authorized user-login comparison below replaces the local source-login blocker; Windows and signed RC acceptance remain open.
- Windows and Linux packaged execution and native-frame acceptance require CI/hardware results. Signed/notarized macOS and Windows hardware checks require the private release pipeline.
- Parity requires exact static ids/consumers and packaged per-area demonstrations; prior phase reports contain partial acceptance, so they are not a blanket sign-off.

## Commit record and candidate status

- C1: `f6b2effd`.
- C2: `afaf2ba9`.
- C3: `75842556`.
- C4: `6b5d2f59`.
- C5: `fa3c9ae7`, partial implementation, not a completed release-candidate sign-off. C6–C14 have not been implemented. This worktree is **not release N complete**.

## Local package and source-artifact observations

`electron-builder --config electron-builder.yml --dir --mac --arm64 --publish never` produced the real unsigned macOS app, with code-signing discovery disabled. The production checker passes after clearing `dist/main` explicitly; before that fix it correctly refused a stale mutation-harness chunk left by an acceptance build. The experience builder produced an API-2 archive from the production dist and agreeing renderer/agent provenance.

Launching the packaged app on an isolated empty synthetic home printed `[smoke] main process ready`, `[smoke] renderer ready`, and `[smoke] notch ready`, then exited 0. The same log contains an updater ENOENT/unhandled-rejection pattern because the unsigned `--dir` app lacks `Contents/Resources/app-update.yml`. Therefore R7-T16's no-fatal-pattern condition is **not proven**. This artifact was built from the dirty local C5 tree before the C5 commit and before local-history fixups; it is not exact-final-commit evidence. The package is not signed or notarized, and the companion-ready outcome does not establish notched-display geometry or hardware behavior.

The original shipped v1.0.85 macOS arm64 archive was downloaded and launched on a separate empty synthetic home. CDP reached its actual renderer and enumerated its `window.api`; the owned process was stopped afterward. [Artifact provenance](07-shipped-artifact.json) records the binary hash. This is an observation of the real source build, **not** a completed §13 content fixture. The 12 bots, 40 sessions, 2,000 histories, oversized/corrupt histories, profiles, routines, memories, grants, dormant drift and completed onboarding/stub account fixtures still need the generator and acceptance runs. No real user data was used.

All 24 NDJSON files compare byte-for-byte with starting commit `c92812e7`.

## Performance and size measurements

| Measurement | Local result | Limit of this evidence |
| --- | --- | --- |
| C4 main initial gzip | 1,247,875 bytes | Static entry/module-preload/style list; includes all emitted preload links. |
| C5 draft main initial gzip | 1,253,383 bytes | Same static method; not CDP first-paint resource measurement. |
| Shipped v1.0.85 static initial gzip | 1,001,567 bytes | Extracted directly from shipped asar, seven entry resources. |
| Static initial comparison | +25.14% | Over the M6 budget by this proxy; the specified CDP comparison is still missing. Do not claim M6 green. |
| C5 notch initial gzip | 622,079 bytes | Companion bundle only, not memory or latency. |
| Largest emitted lazy JS candidate | 917,079 bytes | `editor.api2` belongs to the remaining legacy build; workers and entry resources excluded. C4's earlier 1,483,496-byte candidate was a TS worker and must not be treated as a lazy route. |
| Math lazy gzip | 59,838 bytes | Static temml chunk. |
| Chat history expansion p95, contended Electron run | 50.6 ms | Failed the existing 50 ms phase gate; isolated nine-case rerun passed. The rerun did not print numeric measurements. |
| M1–M5 median/p90, M6 CDP resources | See the user-login comparison below | Seven alternating pairs, first discarded; local unsigned macOS evidence. Windows, wrong-theme frames and separate companion RSS remain open. |

[Draft size data](07-size-flip.json) and [shipped static size data](07-shipped-size.json) are retained separately. The +10% rule applies to M1–M5; M6's spec budget is at most the old initial bundle. Windows reference measurements and Linux Xvfb reports remain CI/hardware gaps. No comparative performance gate has passed.

## Release gate register at this checkpoint

| Gate | Status and exact outstanding evidence |
| --- | --- |
| R7-T1 | Local C5 default/override tests pass. C6/C9 entry and generation removal pending. |
| R7-T2 | Local API coupling, stale provenance, builder/verifier commit disagreement and missing-notch refusal checks pass. Actual new-commit Turbo miss and same-commit joint hit experiment pending. |
| R7-T3 | Existing real handshake/swap and activation tests pass; production-route packaged continuity demonstration pending. |
| R7-T4 | Local classifier tests pass through C5. Final C7 path classifier checks pending. |
| R7-T5 | Wco default selects AG-UI; existing relay/manager tests pass. Final unconditional construction and all-spawn audit pending C10. |
| R7-T6 | All 24 oracle bytes unchanged. Final AG-UI recorder and complete frozen-oracle run pending. |
| R7-T7 | Framing/EOF/UTF-8/oversize regression tests pass. Three scenario byte-identity runs through the real manager with fragmented fd/inline input pending. |
| R7-T8 | Both-mode argv/readiness and RUN_ERROR checks pass; AG-UI exits-without-ready and NDJSON-only readiness refusals pass. C10 collapse pending. |
| R7-T9a | Four real spawned entry cases pass, including absent-wire legacy default, AG-UI fd and inline compat. Complete explicit no-compat and sandbox-probe entry matrix still required. |
| R7-T9b | Not implemented; C10 default AG-UI and ndjson exit-64 contract pending. |
| R7-T10 | Full real pre-rewrite synthetic-content fixture and packaged upgrade assertions not implemented/run. |
| R7-T11 | Dormant-release identification, original artifact fixture and packaged upgrade assertions not implemented/run. |
| R7-T11b | Dormant→pre-rewrite drift fixture, pinned/theme changes and startup provenance assertions not implemented/run. |
| R7-T12 | Two-profile first-activation migration and untouched inactive-profile packaged demonstration not implemented/run. |
| R7-T13 | Packaged N−1 downgrade and N re-upgrade on the same generated homes, including records whose newer fields were dropped, not implemented/run. |
| R7-T14 | Local bounded fallback/recovery tests pass; original-shipped oversized/unreadable source fixtures and packaged demonstrations pending. |
| R7-T15 | Durable attempt manifests/index exist, but executable restoration command and two-profile/two-cycle/conflict/recovery acceptance are pending C14. |
| R7-T16 | Real unsigned macOS package exits 0 and prints main/renderer/notch readiness. Missing app-update.yml is explicitly logged before checks, and the new empty-home smoke has no fatal/unhandled-rejection pattern. Linux/Windows runs, no-companion Linux and shortcut cleanup remain pending; signed acceptance is separate. |
| R7-T17 | Signed/notarized macOS acceptance, physical notch/external-display/haptics/TCC/mic checks, Windows signed upgrade/scaling/taskbar/uninstall and Linux artifacts require pipeline/hardware. |
| R7-T18 | Production experience builds. Final asar/experience entry/provenance/CSP and removed-asset checks pending deletion and dependency steps. |
| R7-T19 | Legacy window.api is still exposed. C8 removal and both-window handshake/exposure assertions pending. |
| R7-T20 | Legacy raw IPC/IpcChannels remain. Parsed allow-list/removal assertions pending C8. |
| R7-T21 | Parsed-specifier helper and negative consumer checks exist. Inventory import-resolution negative control and final grep gate are not implemented. |
| R7-T22 | Current scoped knip passes. Main/shared/preload/script project widening, exact executable entries, five planted canaries and dependency checks pending. |
| R7-T23 | Baseline/report measurements exist; final RC limits +5% and CI package budget enforcement pending. |
| R7-T24 | User-authorized logged-in shipped v1.0.85 fixture measured against the fresh unsigned candidate on Apple M3 / 16 GiB. Seven alternating pairs, first discarded. Numeric M2 timing, M4 and M5 pass; M1 (+259.32%), total process-tree M3 (+38.60%) and observed M6 (+25.43%) fail. Wrong-theme frames, separate companion RSS, M1 route comparability, Windows reference hardware, Linux reporting, signed RC and phase-budget acceptance remain open. The static M6 proxy is unchanged and also fails. |
| R7-T25 | All 313 feature ids and parsed declarations pass. Bridge consumer mapping and frozen exact sets, final row status/evidence/owner anchors, notes and packaged per-area sign-off remain incomplete. |
| R7-T26 | Current i18n and all 11 locale schemas pass. C13 final post-keymap used-key equality and dynamic-key enumeration/purge pending. |
| R7-T27 | Main authoritative busy/keep-awake regression tests pass. |
| R7-T28 | Hidden/minimized/full-screen probe and wco-only recreate tests pass. Final absence of recreate IPC pending C8. |
| R7-T29 | macOS real Electron fixture: five pass; two Linux cases skip. Three-OS packaged production geometry/popup/browser-view/density/full-screen evidence pending. |
| R7-T30 | 302 distinct local Electron cases have passing evidence after isolated rerun, with two platform-only skips. These run dev acceptance fixtures, not the packaged RC; the specified packaged area demonstrations are missing. |
| R7-T31 | Gallery and stale-harness output were refused; production passes both admissions. Explicit fixture-flag rejection test and packaged env-override matrix remain incomplete. |
| R7-T32 | A partial original-source home has a packaged first-launch observation: 3.204 s overall, step 1 1.102 s. Complete fixtures, progress responsiveness and the 50 MB/200 MB/1 GB comparison remain missing. |
| R7-T33 | Local fresh-install admission, withdrawal cancellation and late completion tests pass. Real generic-feed N−1→N installation/relaunch/halt matrix, shipped-client limitation and capsule file-lock evidence require remaining implementation and platform execution. |

## Per-area sign-off still required

The bridge lacks its resolved consumer column and final frozen enumerations. Chrome needs three-OS packaged production geometry evidence. Agent wire needs the final frozen oracle/manager matrix. Foundation needs packaged screenshots/axe and hotkey checks; Chat needs packaged real approvals and reference performance; Bots/Sessions need packaged routes, terminal/device/browser and attachment cases; Routines/Artifacts/Library/Settings need packaged interaction and stress cases; Onboarding/Tour/Notifications need fresh install, settings/command-menu integration, dictation and hardware demonstrations. Static feature consumer resolution is not a substitute for these checks. Existing `partial` phase entries are deliberately not relabeled as accepted.


## Continuation checkpoint, 1 October 2026

The renderer merge is `19c8dd96`. The combined Vite configuration retains source provenance, release graph checks, production readiness definitions, main output cleanup and the updater bundle. It also retains detached main/preload aliases, registry compiler exclusions and route-test ignore prefixes. Production build output has zero React Compiler diagnostics. A bounded Vite dev launch on a fresh synthetic home built main/preload and opened the app without an unresolved `#shared/contract` import. Both detached resolver tests pass after adapting them to the config function.

C5 remains partial. C6–C14 have not started. This checkpoint does not authorize a release or claim that C5's entry gate has passed. Spec 07 §13.3 and risk R15 require refusing a performance fixture when the original source build cannot reach its shell through the synthetic account stub. The source account fetch bypasses the loopback proxy environment and returns `unidentified-account`. At that checkpoint, a user decision about recorded main-debugger fetch instrumentation was pending. The user later authorized the logged-in fixture described below. No fetch instrumentation workaround has run. The disabled alternative is implemented and tested in `scripts/cutover/source-fetch-proxy.mjs`, with exact synthetic-home checks, loopback-only forwarding and a recorded script hash.

### C5 continuation changes and checks

| Change | Evidence | Limit |
| --- | --- | --- |
| Unsigned directory updater handling | Missing `app-update.yml` logs that updates are disabled before a check starts. Automatic download promises now have a rejection observer. Two new regression tests pass. Empty-home unsigned macOS smoke exits 0 and prints all readiness markers with no fatal or unhandled-rejection pattern. | This does not prove signed updater installation or three-OS T16 acceptance. |
| Source fixture generator | Original v1.0.85 archive hash remains `e2ab8da004af1570ad6165bc009311b5badb5de1337f0d88d2f960641a2dd2df`. Own API writes create bots, sessions, 2,000 histories, preferences, geometry, memories and routine attempts. Oversized content is constructed from a seed inside the source renderer to avoid oversized CDP commands. The second profile follows the explicitly permitted registry construction. | The shipped pairing decision API cannot create an absent sender. The auto-reply grant is missing. Source-completed onboarding and final upgrade/downgrade assertions remain open. Partial archives cannot satisfy the complete fixture gates. |
| Comparative probe driver | Same bot/composer and long-session probes for both builds; seven alternating pairs, first discarded; median/p90; parentage RSS sampler including Windows code; GC/heap sampling; observed CDP Network resources and per-resource gzip sizes. Manifest-verified home copies exclude incidental Chromium state. Full mode requires a completed source perf-home and a separately migrated candidate manifest. | At this checkpoint M1–M5 had not run; the follow-up below supplies measurements. Wrong-theme frame classification and companion RSS attribution remain unimplemented. Windows sampling has not run on hardware. This is a partial implementation of R7-T24, not a passing gate. |
| Agent indexing integration | The merged multiline CSS `:is(...)` selector exposed a line-location assertion that assumed a selector's first component fit one line. The assertion now verifies both its starting line and normalized selector continuation. The complete agent unit project passes after the fix. | No production indexer behavior changed. Full agent typecheck also required adding the missing declaration for the existing build provenance helper. |

The immutable partial source archives and their manifests are retained under `apps/desktop/src/main/migrations/__fixtures__/legacy-home-pre-rewrite-v1.0.85*.partial.*`. The second partial variant corrects the draft preference envelopes, uses the shared bot templates and includes a typed v1 tool call. Neither claims complete source-home acceptance.

[Tool usage and limitations](../../../scripts/cutover/README.md) documents the commands and refusal behavior. The source archive is never read from a user home, and no content came from openbot.run.

| Check | Current result |
| --- | --- |
| Desktop `tsc -b`; agent full typecheck; tools typecheck | Pass |
| Desktop shared/main/renderer/renderer-next unit projects, `--maxWorkers=2` | 5,432 tests pass across 609 files; the added second updater test also passes in its focused two-test file |
| Required Electron main-serial | 302 pass, two Linux-only skips across 12 files |
| Agent unit project | 1,732 pass, two skips across 100 passing files and one skipped file |
| Updater / connectors | 14 tests pass in each package |
| Cut-over Node tooling checks | Eleven tests pass |
| oxlint / oxfmt | No lint errors; inherited legacy warnings. Format check passes after formatting the new reports and scripts. |
| UI registry / legacy diff / scoped knip / React Compiler | Pass; zero compiler diagnostics |
| NDJSON frozen oracles | All 24 are byte-identical to `c92812e7` |
| Release graph checker | Production passes; the final package is rebuilt from the checkpoint commit after acceptance builds |
| Packaged macOS smoke | Unsigned local result only; all readiness outcomes and exit 0. Signed, Windows and Linux acceptance remain gaps. |

### Measured observations

| Measurement | Old | Candidate | Finding |
| --- | --- | --- | --- |
| M6 CDP onboarding diagnostic, median / p90 | 1,001,567 / 1,001,567 gzip bytes | 1,251,321 / 1,251,321 gzip bytes | +24.94%. The numeric M6 budget fails. Seven alternating pairs ran; first pair discarded. These fresh onboarding homes are not the required completed performance homes, so no R7-T24 acceptance is claimed. |
| Partial source-home packaged first launch | Not a comparative run | 3.204 s overall; step 1 1.102 s; step 2 0.006 s; step 5 0.008 s | 2,002 files examined; 1,997 converted; three oversized files kept; one corrupt and one unknown-version file skipped. Six routines had 120 recorded attempts, six linked to sessions. This is a partial fixture observation, not T10/T32 acceptance. |
| M1–M5 at the prior checkpoint | Unmeasured then | Unmeasured then | Superseded by the authorized user-login measurements below. |

[Actual CDP resources and run samples](07-cdp-m6-diagnostic.json) retain all 14 runs. [Partial upgrade observation](07-partial-upgrade.json) records the log and source-file hash comparison. The source transcript hashes and inactive-profile hashes are checked separately from intentionally changed migration records. The partial producer records its dirty generator provenance; it is not exact committed-generator fixture acceptance. The partial archive retains its seeded 30 MB history; the specified acceptance-time regeneration remains unfinished.

### Decisions and remaining gates

- The dormant-release version is still a coordinator question. No dormant or dormant-to-pre-rewrite fixture is inferred from an unshipped branch.
- The user authorized the real logged-in shipped home for performance. The synthetic generator still refuses the perf fixture under the strict source-proxy path. No fetch instrumentation was used.
- The bridge consumer column, frozen exact bridge sets, final parity row schema, notes and packaged per-area demonstrations remain C5 work. Existing partial reports remain partial.
- C6–C14 are unimplemented. Legacy deletion, renderer move, preload/raw IPC removal, generation collapse, wire cleanup, transition writer removal, dependency and locale cleanup, restore command, support article and release notes remain outstanding.
- Spec 07 §19 still needs decisions about absolute performance caps, the proposed 150 MB companion RSS cap, rollout stages and the 14-day N+1 soak, and ownership of fallback-reader copy. The source proxy decision and the failed M6 number do not resolve those questions.
- Signed/notarized macOS, physical notch/external-display/haptics/TCC/microphone checks, Windows signed upgrade/scaling/taskbar/uninstall and Linux packaged/native-frame checks need pipeline or hardware evidence. None passes by omission.


## User-login performance follow-up, 1 October 2026

The user authorized the logged-in shipped v1.0.85 home for M1–M5. The original home was copied into a private temporary directory outside the repository before any app launch or API write. No file from that home, app log, private producer manifest or credential-file hash is committed. `.build/` was already ignored; `git check-ignore .build/cutover/probe` confirmed it, and the initial `git status --short` was clean.

The private producer records `"user-login, shipped v1.0.85, not source-generated"`, `provenance: "user-login"` and `sourceGenerated: false`. The original home had no bots or sessions. The shipped build's `window.api` created 12 bots, 40 sessions and 2,000 synthetic histories on the scratch copy. The target session has 1,000 messages; the other histories contain two short messages. This is the authorized performance workload, not the oversized synthetic migration fixture in §13.3. Source shell admission uses the user's login. Neither the synthetic account stub nor main-debugger fetch instrumentation was used. macOS outbound network access is blocked during the runs.

The candidate production build and unsigned arm64 directory package were rebuilt from application source at `1b14bc91`. A separate candidate scratch copy ran the packaged migrations before timing. Step 1 converted all 2,000 histories; steps 2 and 5 completed. Both private file manifests are hash-checked before each run. The driver creates a new private home for each launch and removes it after stopping the owned process. Incidental Chromium state, logs and runtime files are excluded from the measured copies.

The comparison alternates seven old/new pairs on this machine, discards pair 1, and reports the median and nearest-rank p90 of the six remaining samples. M3 is sampled 60 seconds after M1; M4 follows explicit heap-profiling enablement and garbage collection. The common readiness probe requires a visible fixture bot in the sidebar and a composer that can take focus. The shipped shell opens a short regular session and reopens Bots; the candidate opens the fixture bot. That route difference limits M1 comparability. M5 opens the same 1,000-message session in both builds and times the session click until its last message is visible.

CDP now selects the main `index.html` or `index-next.html` document, records resources separately for each page, and excludes the notch document. The additional resource-tracking connection closes after first paint before idle/heap sampling. Earlier setup attempts produced no complete comparison. One attempt stopped after its discarded pair when the next old-build GC request timed out. It contributes no samples to the final medians or p90 values.

The existing M6 static proxy above is unchanged. Wrong-theme screencast classification, separate companion RSS attribution, Windows reference hardware, Linux Xvfb reporting, signed RC checks and the packaged phase budgets remain open. This work supplies local numerical evidence and does not complete R7-T24 or C5.


All 432 original-home file hashes are unchanged after the comparison. [Reviewed numerical samples and build hashes](07-user-login-perf.json) retain all 14 runs, per-process RSS, per-resource gzip bytes and unrounded summaries. Private paths, process command lines, the credential manifest and fixture content are omitted. The machine is an Apple M3 with 16 GiB RAM, macOS arm64.

| Metric | Old median / p90 | New median / p90 | New median budget | Numeric result |
| --- | --- | --- | --- | --- |
| M1 interactive, ms | 1,803.050 / 2,741.600 | 6,478.800 / 7,282.500 | ≤ 1,983.355 | Fail |
| M2 first paint, ms | 1,680.900 / 2,137.600 | 1,637.650 / 1,664.300 | ≤ 1,848.990 | Pass for timing; theme check open |
| M3 total process-tree RSS, bytes | 659,496,960 / 669,057,024 | 914,038,784 / 983,891,968 | ≤ 725,446,656 | Fail; companion included |
| M4 renderer JS heap, bytes | 19,180,194 / 19,262,056 | 20,159,910 / 20,167,356 | ≤ 21,098,213.4 | Pass |
| M5 long session, ms | 721.500 / 725.200 | 163.050 / 313.100 | ≤ 793.650 and < 600 | Pass |
| M6 observed initial gzip, bytes | 1,001,567 / 1,001,567 | 1,256,227 / 1,256,227 | ≤ 1,001,567 | Fail |


Milliseconds in this table are displayed to three decimals. Decisions use the unrounded JSON values; no rounding changes a failure into a pass. M3 includes the companion in the total, so it cannot establish the main-window tree or the separate 150 MB cap. M2's timing passes, but its complete gate still needs the wrong-theme frame check. Local M4 and M5 meet their numeric budgets. M1, M3 and M6 fail numerically. R7-T24 remains open; this does not authorize C6 or a release.

The prior static M6 proxy remains 1,001,567 bytes old versus 1,253,383 bytes candidate, +25.14%, failing its 1,001,567-byte budget. The new observed CDP result is 1,001,567 versus 1,256,227 bytes, +25.43%, and also fails.

No additional user login or fetch-instrumentation approval is needed for these local measurements. Windows 11 x64 reference measurements, Linux Xvfb reporting, signed RC and physical platform acceptance still need hardware or the release pipeline. Theme-frame and companion-RSS checks need implementation. Spec §19's unresolved release-policy and cap decisions remain separate user/coordinator work.

## Implementation continuation

| PR | Implementation checks | Release evidence |
| --- | --- | --- |
| C5 completion (`d8bccf17`) | Bridge consumers resolve to implementing main routers; exact bridge enumerations frozen; final feature metadata and visible-note generator. Focused: 11 tests. | Hardware, signed, comparative and packaged acceptance gaps above remain open. Green rows record implementation checks only; partial acceptance is deferred. |
| C6 (`2e4c6e3a`) | Deleted legacy renderer except locales, froze preference/starter oracles, single main entry plus notch, moved shared tool result types, removed legacy build/test/lint project. Focused: 49 tests. | Build and packaged/screenshot evidence deferred to final gates; hardware gaps remain. |
| C7 (`b28230c2`) | Moved renderer and executable scripts, rewrote consumers/aliases/configuration, regenerated bridge report, widened knip and checked five planted canaries. Focused: 16 tests pass. The initial canary failure was resolved in final validation by isolating project scope from test readers; all five areas pass. | Unused exports/dependencies found by widened knip are queued for C12. Screenshot/hardware acceptance remains open. |
| C8 (`0eef628b`) | Removed window.api, bridge/types/generator, raw legacy IPC/channels and legacy event sends; bus-only host events and subscription-only two-stage swaps. Focused: 64 tests. | Packaged handshake/smoke and hardware acceptance remain open. |
| C9 (`3473aa84`) | Collapsed generation/chrome/startup theme and notification policy; removed generation modules, legacy metrics and raw update sends. Focused: 43 tests. | Linux native-frame CI retained. The spec’s conditional webview removal cannot yet run: the new FilePreview still consumes it, so its main security guard stays. Three-OS geometry/hardware acceptance remains open. |
| C10 (`1a3249b0`) | Unconditional AG-UI spawn/health check, removed NDJSON-only host/wire selection, structured exit-64 refusal, AG-UI/compat/stdin recording, six fragmented frozen-scenario manager cases. Focused: 56 tests; all 24 NDJSON files byte-identical. | Dist-dependent spawned/recorder/golden suites deferred until dependency builds after C14. Three-OS spawned evidence remains open. |
| C11 (`3f4217fd`) | Removed live legacy preferences sync, durable-state contract and the v1 transcript/dual writer. Kept read-only startup drift import, retirement protection, repair/fallback and dual removal; old-build saves are test-only fixtures. Focused: 64 tests. | Real-build downgrade and multi-platform acceptance remain open. |
| C12 (`5d6e88cc`) | Removed unused legacy dependencies/patch, widened knip dependencies and unlisted checks, resolved unused exports, declared transitive imports, fixed five-area canary, set C5 +5% bundle limits and CI gate, removed v1Archived. Focused: 29 tests. | CSP narrowing and peak heap require final packaged evidence; licensed ConnectorMark paths remain. |
| C13 (`330d7ac7`) | Applied the keymap to all 11 locales, then pruned 3022 to 2082 leaves using parsed literal/data/prop keys, plural stems and finite dynamic families. Restored indirect data/template catalogues discovered during final validation; removed keymap/retired transition lists and their tests. Focused: 25 tests; locale and JSX i18n checks pass. | Language screenshots and platform acceptance remain open. |
| C14 (`this commit`) | Digest-checked restore command before migrations/windows, rebuilt per-profile index, generations/latest attempts, collision handling and two-cycle tests; release notes generated from visible parity metadata, support article, PLAN/PROGRESS, duplicate microphone key removed, foundation version 1.0.13. Focused: 24 tests. | Recorded notch probes/150ms haptics decision, signed RC, three-OS smoke, reference performance and release-manager go remain gaps. |


### Final implementation gates

All C5–C14 commits preceded dependency builds and production validation. Connectors, agent and updater were built before dist-dependent tests. The full unit and required Electron gates ran once; only affected files were rerun after repairs. No package or comparative probe was run in this implementation continuation. The checks below supersede earlier implementation checkpoints, without changing historical acceptance evidence.

| Gate | Result |
| --- | --- |
| `tsc -b` | Pass after stale-reference repairs. |
| Desktop unit projects, `--maxWorkers=2` | Initial full run: 4213 pass, 101 fail in 488 files. Affected main tests: 43 pass; affected renderer/shared tests: 123 pass after repairs (one obsolete legacy-dialog test removed). Additional import guards: 18 pass. Full suite was not repeated. |
| Agent / updater / connectors unit projects | 1733 pass, two skips / 14 pass / 14 pass. |
| Dist-dependent AG-UI / compatibility | 28 spawned/golden tests and five recorder tests pass. All 24 NDJSON golden files remain byte-identical to `c92812e7`. |
| Cutover Node tooling | 25 tests pass after the focused canary repair; locale consumer tooling adds three passing tests. |
| Required Electron `main-serial`, `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1` | **Not green.** Initial full run: 274 pass, five fail, 25 skipped. Affected five-file rerun: 214 pass, three fail. Startup, notch and browser functional failures are repaired. Remaining timing failures: streaming busy p95 60.404 ms, history expansion 60.9 ms, 3000-tool expansion 50.5 ms; each requires <50 ms. Thresholds were preserved. |
| oxlint / oxfmt | Pass. |
| UI registry / deletion inventory | Pass. `check:legacy-diff` was retired with the legacy renderer; parsed-import and deletion inventory guards replace it. |
| Complete knip / five-area canaries | Pass. `check:knip` replaces the retired `check:knip-next`; includes files, exports, types, duplicates, dependencies and unlisted imports. |
| React Compiler / production release checker | Pass; zero compiler diagnostics. Production output is an unsigned implementation build from the working tree, not signed RC acceptance. |
| Locale / JSX i18n | Pass; all 11 locales have 2082 leaves and dynamic consumer families are covered. |
| C5 +5% gzip size limits | Pass: main 1.2 MB, companion 600.35 kB, largest lazy chunk 162.07 kB, math 59.71 kB. [Measured bundle inventory](07-size-current.json) records this local build, not old/new reference performance. |
| Additional C12 dependency audit | **Not green.** High advisories: undici GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3, GHSA-vp8m-p9jh-q5pm; brace-expansion GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. No acceptance exemption was added. Dependency remediation remains release-blocking. |

Final validation repairs are included in C14: stale source aliases and transport mocks, real spawned default/refusal cases, restored indirect locale consumers, AG-UI input recording, source provenance, tooling canaries and CI size enforcement. The user-visible notes are in the actual Unreleased changelog section. `.build/` remains ignored and no account-home files are staged or committed.

### Still-open §19 decisions and evidence gaps

1. Whether to ship a dormant release before the flip, and thus obtain field-proven steps 1–2 and dormant fixtures.
2. Whether to set absolute cold-start and memory caps after the first C5 measurement.
3. Confirmation of the proposed 150 MB companion RSS cap after R6-T27 measurement.
4. Release-manager rollout stages and the proposed N+1 soak of at least 14 days at 100%.
5. Design ownership of the 512 MB fallback ceiling and the “too large” notice.

Signed/notarized macOS, signed Windows upgrade/scaling/taskbar/uninstall, Linux packaged/native-frame checks, physical notch/external-display geometry, microphone/TCC and recorded R6-T31 haptics (<150 ms) remain gaps. Packaged fresh-install and feature demonstrations, complete immutable shipped-source migration fixtures, Windows reference and Linux performance evidence, wrong-theme frames and separate companion RSS remain gaps. The historical M1/M3/M6 numeric failures are unchanged. CSP narrowing and heap-limit reduction still need packaged evidence; webview removal remains conditional on replacing FilePreview's active consumer. The Electron timing and dependency-audit failures above prevent a green release gate. Release-manager go is still required.


## Performance pass, 1 October 2026

These observations supersede the historical route-mismatched M1 comparison. Each measurement uses one warm-up pair and three retained alternating pairs on hash-checked private copies of the logged-in source workload. The original home is never launched or modified. Both builds now open Fixture session 01, require its final synthetic message and focus its composer. The selected routes agree. The 1,000-message session remains the common M5 workload. Profiles, logs, private manifests and account files remain outside the repository.

### Goal 1: startup and probe comparability

The historical M1 comparison opened a regular short session in v1.0.85 and a new bot-owned chat in the candidate. Opening the bot includes session creation, model selection, agent readiness and kickstart. It was not the same startup workload. The corrected baseline measures 1,951.200 ms old versus 1,860.900 ms candidate, with a candidate p90 of 5,518.800 ms. [Comparable baseline samples](07-perf-comparable-valid.json) replace that M1 comparison; the historical 6,478.800 ms remains a record of the earlier probe.

A main-process CPU profile taken before module evaluation found synchronous debug-sync history reads and an upload/retry burst. Of 4.666 seconds of sampled main work in a migrated-home diagnostic, `readFileUtf8` accounted for 1,225 ms. Its callers included the startup sweep and concurrent debug-sync attempts over the 2,000-history workload. The inspector perturbs timing, so these CPU samples explain work rather than establish M1 acceptance. Migration was measured in an untimed preparation launch. Repeat launches did not reconvert all histories. The copied archival manifests are path-bound and are rejected on scratch-home relocation; this is reported by the runner, not evidence of production migration failure.

Catch-up now begins after renderer subscriptions are ready. It reads histories as needed, yields between uploads, and limits background uploads to two concurrent attempts instead of arming 2,000 simultaneous timers. Each persisted turn still enqueues sync, retries and markers remain intact, and explicit feedback flushes retain priority. Resolving the selected local execution backend no longer probes every other backend through a synchronous login-shell spawn. No collection, transcript or agent capability was removed.

The RSS sampler also had an ancestor-filter bug: an unrelated parent command matching the agent pattern could exclude the entire app tree. It now builds the owned descendant tree first, validates a nonempty root sample, and applies the historical agent exclusion only inside that tree. One preliminary local run with zero RSS was discarded and is not acceptance evidence. Goal 2 adds complete agent-inclusive attribution.

| Metric | Comparable old median | After goal 1 median / p90 | Fresh +10% budget, except M6 | Result |
| --- | --- | --- | --- | --- |
| M1, ms | 2020.800 | 1719.900 / 1931.600 | ≤ 2222.880 | Pass |
| M2, ms | 1522.700 | 1294.600 / 1305.700 | ≤ 1674.970 | Pass |
| M3, bytes, agents excluded | 691863552.000 | 880394240.000 / 886013952.000 | ≤ 761049907.200 | Fail |
| M4, bytes | 22516868.000 | 26516064.000 / 26651544.000 | ≤ 24768554.800 | Fail |
| M5, ms | 730.800 | 85.400 / 91.900 | ≤ 803.880 | Pass |
| M6, bytes | 1001567.000 | 1207159.000 / 1207159.000 | ≤ 1001567.000 | Fail |

[Goal-1 numerical samples](07-perf-goal1.json) contain the build hashes, all eight runs and resource inventory. M1 also meets the requested historical 1,983.355 ms median cap. M2 is timing only; wrong-theme frame classification remains open. The route-corrected M4 baseline differs from the historical route, and its current +10% comparison is recorded without carrying forward the old pass.

Validation: desktop `tsc -b`, seven focused main tests, seven Node probe/copy tests, and affected lint/format checks pass. Full gates are recorded after the remaining performance goals.

### Performance pass: goal 2 — process attribution and agent demand

The session reader no longer starts an agent simply by observing a stopped
session. Editing warms it; sending starts it and restores the saved conversation
before the relay admits the command. Notch runtime imports avoid the complete
chat barrel. The idle notch remains enabled when the user's preferences require
it; hiding an expected companion would remove behaviour.

Four alternating pairs (one warm-up pair discarded) are recorded in
[07-perf-goal2-attributed.json](07-perf-goal2-attributed.json). The sampler now
includes **all** owned descendants. Earlier reports called M3 total RSS but
excluded agent descendants. Do not compare those totals without noting scope.

| Metric | Shipped median | Candidate median |
| --- | ---: | ---: |
| M1 interactive | 3,738.4 ms | 1,933.4 ms |
| M2 paint | 2,771.1 ms | 1,288.7 ms |
| M3 including agent | 868,155,392 B | 843,530,240 B |
| M4 renderer heap after GC | 22,594,376 B | 25,925,200 B |
| M5 long thread | 701.5 ms | 79.7 ms |
| M6 initial gzip | 1,001,567 B | 1,207,321 B |

| Process role | Shipped median MB | Candidate median MB |
| --- | ---: | ---: |
| Main | 276.3 | 276.2 |
| Main renderer | 263.4 | 256.6 |
| Notch/companion renderer | 0 | 152.3 |
| Agent | 173.1 | 0 |
| GPU | 109.1 | 112.9 |
| Network | 46.3 | 45.1 |

Role medians need not sum to the median process-tree total. The candidate
remains above the historical 725 MB ceiling. Initial route code splitting is
next; M4 also remains above the comparable-run budget. M1 median meets the
historical 1,983 ms ceiling, but p90 is 3,619.6 ms; shipped startup varied too.
Focused lifecycle/chat tests, sampler tests, desktop typecheck, affected lint,
and the production build/package passed before measurement.

### Performance pass: goal 3, initial route split

The interrupted draft had a conflicting type alias in the lazy chat wrapper.
Compilation now passes. Feature barrels made route loaders pull presentation
code into the boot graph. The fixture helper also lived in the chat barrel,
and the new-session preview imported file rendering with no preview open.
Routes now import their loaders and guards directly. Transcript views,
workspace tabs, draft previews, subagent details, terminal initialization and
optional sidebars load on demand. The notch router also splits its routes.
The tour loads only while a tour is active. All features remain available.

[Goal-3 samples](07-perf-goal3-final.json) contain four alternating pairs with
the first discarded. CDP first-paint gzip is 769,261 bytes versus 1,207,159
bytes after goal 1, a 36.3% reduction and below the 1,001,567-byte cap.
Every candidate sample's pre-paint resources were checked against the packaged
module graph. They contain no editor, terminal implementation, ghostty-web,
markdown, syntax grammars, notch presentation, onboarding presentation, tour
presentation or gallery code. They contain 26 named icons, not an icon catalog.
Startup route guards and shared terminal/notch RPC contracts remain necessary.
The release checker now enforces the static boot graph's presentation and
icon exclusions, and the size limit uses the M6 cap. Static HTML resources are
smaller than the observed route resources; CDP is the M6 evidence.

| Metric | Shipped median | Goal-3 median / p90 |
| --- | ---: | ---: |
| M1, ms | 1,866.0 | 1,787.6 / 1,807.2 |
| M2, ms | 1,422.7 | 1,225.8 / 1,237.2 |
| M3 including agents, bytes | 866,516,992 | 859,373,568 / 866,467,840 |
| M3 excluding agents, bytes | 692,617,216 | 859,373,568 |
| M4, bytes | 22,519,688 | 25,717,552 / 25,762,228 |
| M5, ms | 706.6 | 82.2 / 90.7 |
| M6, bytes | 1,001,567 | 769,261 / 769,261 |

M3 and M4 still exceed the fixed goal-1 budgets of 761,049,907 and 24,768,555
bytes. Candidate process medians are main 277.0 MB, main renderer 277.4 MB,
notch renderer 149.1 MB, GPU 107.9 MB and network 45.1 MB, with no agent.
The temporary workload was lost at reboot and was recreated using the same
shipped API procedure on a private copy of the original logged-in home.
The discarded exploratory run was stopped before completion after discovering
the eager preview import; it is not acceptance evidence.

Validation: desktop typecheck, 93 focused renderer tests in nine files, nine
Node bundle/probe/sampler tests, affected lint and format, production build,
unsigned directory package and release checker pass. All 24 NDJSON goldens
remain byte-identical to `c92812e7`. Final broad gates follow the other goals.

### Performance pass: goal 2b, retained memory

An idle companion imported the transcript runtime before it had a thread. It
now shares one retryable preparation promise and prepares before presenting a
thread or sending commands. Cancellation is checked after preparation. The
command menu loads on first use and stays mounted for exit/focus restoration.
The closed model picker no longer constructs the full options tree. PPTX
export loads its generator only when exporting. Syntax grammars load only
when a rendered code block needs them, with escaped code replaced by token
HTML on completion. The chat's unconditional idle math prefetch is removed;
closed math still loads temml and updates through the existing subscription.
No attention, transcript, tool, language, export or companion feature is removed.

[Goal-2b samples](07-perf-goal2b-demand-final.json) use four alternating pairs,
with the warm-up discarded. Earlier completed exploratory measurements remain
private and are not the final evidence for this commit.

| Metric | Shipped median | Candidate median / p90 |
| --- | ---: | ---: |
| M1, ms | 1354.9 | 1199.5 / 1201.0 |
| M2, ms | 944.1 | 751.0 / 753.8 |
| M3, bytes | 864698368.0 | 818429952.0 / 819560448.0 |
| M4, bytes | 22531704.0 | 24691228.0 / 24699532.0 |
| M5, ms | 499.2 | 56.0 / 59.7 |
| M6, bytes | 1001567.0 | 752449.0 / 752449.0 |

| Candidate process role | Median MB (decimal) |
| --- | ---: |
| main | 274.0 |
| GPU | 113.9 |
| network | 45.0 |
| renderer | 237.1 |
| notch/companion | 147.2 |

The candidate has no idle agent, so its total RSS is also its agent-excluded
RSS. M3 remains above the fixed 761,049,907-byte cap. The separate required
notch renderer is the largest additional process relative to shipped, which
had no notch renderer. Main, GPU and network are of similar scale to shipped;
the main renderer is smaller. Removing the companion would change required
behaviour. Process medians need not sum to the median total. M4 is now below the
fixed 24,768,555-byte cap; it is measured after the same explicit GC as shipped.

Validation: notch/runtime, model-picker, PPTX, Markdown and chat-view focused
tests, desktop typecheck, affected lint/format and production build/package
pass. Both deferred grammar and math rendering retain their update tests.
Final broad gates follow the remaining goals.

### Performance pass: goal 4, transcript hot paths

Tool grouping repeatedly searched part, segment and window arrays inside
per-part loops. They now build indexes once, preserving the first match when
entries repeat. The transcript computes tool IDs once per message/render and
indexes row/outcome data. It does not assume streamed messages are immutable.
The resize observer follows row IDs and window bounds rather than reconnecting
on each text delta, and uses the observer's supplied border-box height.
Anchor capture stops at the first fully visible row in document order.
Completed code fences reuse syntax HTML in a bounded cache (128 entries,
512 Ki retained source/output characters; large blocks bypass it).

The fresh gallery build passes all nine required Electron chat-kit tests.
[Timing samples](07-timing-goal4.json) record 171 streaming deltas and 20
activations for each expansion case. Thresholds remain unchanged.

| Required timing | Before, ms | After, ms | Required |
| --- | ---: | ---: | ---: |
| Streaming busy-task p95 | 60.404 | 4.19 | <50 |
| History expansion maximum | 60.9 | 23.5 | <50 |
| 3,000-tool expansion maximum | 50.5 | 16.8 | <50 |

History/tool peaks remain 100 mounted rows. Maximum anchor drift is
0.1328125 px (cap 1 px); prepend drift is zero.
The suite also passes rich-thread first paint, scroll FPS, replay readiness,
loader readiness and bounded-row checks.

[Packaged goal-4 samples](07-perf-goal4-final.json) remeasure M1–M6 with four
alternating pairs and the warm-up discarded.

| Metric | Shipped median | Candidate median / p90 |
| --- | ---: | ---: |
| M1, ms | 1338.9 | 1187.4 / 1205.4 |
| M2, ms | 947.9 | 742.7 / 743.5 |
| M3, bytes | 864632832.0 | 810582016.0 / 853524480.0 |
| M4, bytes | 22507556.0 | 24744940.0 / 24834044.0 |
| M5, ms | 510.7 | 55.8 / 56.4 |
| M6, bytes | 1001567.0 | 752459.0 / 752459.0 |

Focused transcript/parts/Markdown tests (35), typecheck, affected lint/format,
production build/package and release checks pass. Final broad gates follow
dependency remediation.
