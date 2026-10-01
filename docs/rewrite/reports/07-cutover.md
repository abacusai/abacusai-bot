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
| C5 | **Partial implementation; release gate open.** Default wco with unpackaged legacy override; API 2 desktop/updater; API-2 notch-entry requirement; experience classifier; AG-UI spawn CI; exact 313 feature parity ids and parsed declaration checks; legacy blob inventory; notch Settings and tour replay handoff | 4,370 unit tests / 491 files; 11 integrity tests and four health-check tests after adding the missing-notch refusal case; 122 parity/bot tests after consumer corrections; 14 updater tests; four real agent spawn cases; four Node checks. Required Electron run: 301 pass / one performance failure / two Linux skips; isolated rerun passes all nine chat-kit cases, yielding passing evidence for 302 distinct cases. TypeScript, format, lint, registry, legacy-diff, scoped knip and locale checks pass. Production release checker and experience build pass. | Bridge map consumer column, frozen bridge enumerations/sign-off, final green/retired/deferred schema with evidence and PLAN anchors, release-note generation and packaged per-area demonstrations remain unfinished. Complete synthetic shipped homes and comparative M1–M6 probes are not implemented. Unsigned macOS smoke exits 0 with readiness markers but logs an updater fatal-pattern error; it is not a full T16 pass. |
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
- R7-T24 / M1–M6 require the last shipped packaged artifact, onboarding-completed performance fixture and both specified reference machines. No comparative performance numbers have been measured yet.
- Windows and Linux packaged execution and native-frame acceptance require CI/hardware results. Signed/notarized macOS and Windows hardware checks require the private release pipeline.
- Parity requires exact static ids/consumers and packaged per-area demonstrations; prior phase reports contain partial acceptance, so they are not a blanket sign-off.

## Commit record and candidate status

- C1: `f6b2effd`.
- C2: `afaf2ba9`.
- C3: `75842556`.
- C4: `6b5d2f59`.
- C5: partial implementation, not a completed release-candidate sign-off. C6–C14 have not been implemented. This worktree is **not release N complete**.

## Local package and source-artifact observations

`electron-builder --config electron-builder.yml --dir --mac --arm64 --publish never` produced the real unsigned macOS app, with code-signing discovery disabled. The production checker passes after clearing `dist/main` explicitly; before that fix it correctly refused a stale mutation-harness chunk left by an acceptance build. The experience builder produced an API-2 archive from the production dist and agreeing renderer/agent provenance.

Launching the packaged app on an isolated empty synthetic home printed `[smoke] main process ready`, `[smoke] renderer ready`, and `[smoke] notch ready`, then exited 0. The same log contains an updater ENOENT/unhandled-rejection pattern because the unsigned `--dir` app lacks `Contents/Resources/app-update.yml`. Therefore R7-T16's no-fatal-pattern condition is **not proven**. The package is not signed or notarized, and the companion-ready outcome does not establish notched-display geometry or hardware behavior.

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
| M1–M5 median/p90, M6 CDP resources | Not measured | Completed synthetic perf-home, alternating seven runs with first pair discarded, identical probes and process-tree/heap sampling still required. |

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
| R7-T16 | Real unsigned macOS package exits 0 and prints readiness outcomes. Updater missing-config fatal pattern prevents full pass. Linux/Windows package runs, no-companion Linux and shortcut cleanup evidence remain pending. |
| R7-T17 | Signed/notarized macOS acceptance, physical notch/external-display/haptics/TCC/mic checks, Windows signed upgrade/scaling/taskbar/uninstall and Linux artifacts require pipeline/hardware. |
| R7-T18 | Production experience builds. Final asar/experience entry/provenance/CSP and removed-asset checks pending deletion and dependency steps. |
| R7-T19 | Legacy window.api is still exposed. C8 removal and both-window handshake/exposure assertions pending. |
| R7-T20 | Legacy raw IPC/IpcChannels remain. Parsed allow-list/removal assertions pending C8. |
| R7-T21 | Parsed-specifier helper and negative consumer checks exist. Inventory import-resolution negative control and final grep gate are not implemented. |
| R7-T22 | Current scoped knip passes. Main/shared/preload/script project widening, exact executable entries, five planted canaries and dependency checks pending. |
| R7-T23 | Baseline/report measurements exist; final RC limits +5% and CI package budget enforcement pending. |
| R7-T24 | Comparative M1–M6 driver and completed perf-home missing; no medians/p90 or +10% acceptance claimed. |
| R7-T25 | All 313 feature ids and parsed declarations pass. Bridge consumer mapping and frozen exact sets, final row status/evidence/owner anchors, notes and packaged per-area sign-off remain incomplete. |
| R7-T26 | Current i18n and all 11 locale schemas pass. C13 final post-keymap used-key equality and dynamic-key enumeration/purge pending. |
| R7-T27 | Main authoritative busy/keep-awake regression tests pass. |
| R7-T28 | Hidden/minimized/full-screen probe and wco-only recreate tests pass. Final absence of recreate IPC pending C8. |
| R7-T29 | macOS real Electron fixture: five pass; two Linux cases skip. Three-OS packaged production geometry/popup/browser-view/density/full-screen evidence pending. |
| R7-T30 | 302 distinct local Electron cases have passing evidence after isolated rerun, with two platform-only skips. These run dev acceptance fixtures, not the packaged RC; the specified packaged area demonstrations are missing. |
| R7-T31 | Gallery and stale-harness output were refused; production passes both admissions. Explicit fixture-flag rejection test and packaged env-override matrix remain incomplete. |
| R7-T32 | Full synthetic source homes, packaged first-launch driver, progress responsiveness and 50 MB/200 MB/1 GB timings missing. |
| R7-T33 | Local fresh-install admission, withdrawal cancellation and late completion tests pass. Real generic-feed N−1→N installation/relaunch/halt matrix, shipped-client limitation and capsule file-lock evidence require remaining implementation and platform execution. |

## Per-area sign-off still required

The bridge lacks its resolved consumer column and final frozen enumerations. Chrome needs three-OS packaged production geometry evidence. Agent wire needs the final frozen oracle/manager matrix. Foundation needs packaged screenshots/axe and hotkey checks; Chat needs packaged real approvals and reference performance; Bots/Sessions need packaged routes, terminal/device/browser and attachment cases; Routines/Artifacts/Library/Settings need packaged interaction and stress cases; Onboarding/Tour/Notifications need fresh install, settings/command-menu integration, dictation and hardware demonstrations. Static feature consumer resolution is not a substitute for these checks. Existing `partial` phase entries are deliberately not relabeled as accepted.
