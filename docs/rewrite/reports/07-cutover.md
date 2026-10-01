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
| C4–C14 | Pending | Pending | Pending |

## Open evidence gaps

- R7-T10–T13, T11b and T32 require homes created by each retained real shipped build with synthetic data, including dormant-release drift, profiles, clearing and oversized histories. Hand-authored unit fixtures do not prove these gates.
- R7-T24 / M1–M6 require the last shipped packaged artifact, onboarding-completed performance fixture and both specified reference machines. No comparative performance numbers have been measured yet.
- Windows and Linux packaged execution and native-frame acceptance require CI/hardware results. Signed/notarized macOS and Windows hardware checks require the private release pipeline.
- Parity requires exact static ids/consumers and packaged per-area demonstrations; prior phase reports contain partial acceptance, so they are not a blanket sign-off.
