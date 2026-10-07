# Sidebar timestamp formatting

Base `origin/main` `097b0934`, measured in Electron 44.4.5 on macOS over an isolated
CDP connection (10039; Vite 5199). No Sessions UI, avatar or Settings About changes.

T3 Code [#11019](https://github.com/pingdotgg/t3code/pull/11019) reuses bounded Intl
formatters in `packages/shared/src/usageFormat.ts`. Its MIT-licensed clone is at
`611132c171f3a821bd2e32f22261135cef6330ac` in the requested `scratchpad/t3code-ref`.
This implementation is independent; no T3 code was copied.

Our `formatChatStamp` constructed a formatter on every timestamp. The shared
utility is used by Bots sidebar rows; repeated labels therefore repeat ICU setup.
A bounded 16-entry LRU now reuses four formatter shapes per locale. The cache uses
explicit UTC; local Date calendar fields are read afresh for each call, so changing
the system zone cannot leave a cached old timezone. This also preserves DST and
historical offsets. The existing time/yesterday/weekday/date choices stay intact.

| Electron renderer benchmark | Before | After |
| --- | ---: | ---: |
| 300 labels × 20 refreshes, five trials, median | 141.0 ms | 4.9 ms |
| Sample range | 134.3–144.3 ms | 4.4–4.9 ms |
| Repeat median | 155.9 ms | 5.5 ms |
| Output digest, every sample | 3,201,760 | 3,201,760 |

Input ages alternate today / 3 / 12 / 400 days; locale en-US, fixed October 7
reference time, one warmup. This measures the formatter, **not** whole-sidebar
render latency or INP. The CDP module import gets a different query key for each
candidate so browser module caching cannot return the baseline implementation.
Initial stale-import samples were rejected; retained samples use fresh modules.
Raw samples/harness remain in `/private/tmp/abacus-surface-perf`.

Regression tests compare fresh Intl output across en-US, de-DE, ar-EG and th-TH,
UTC/New York/Kolkata/Monrovia, DST spring/fall boundaries, system-zone changes, and
a historical non-minute timezone offset. The original formatter tests remain.

Follow-up: profile row subscription work and grouping with 1,000 sessions; consider
cached sort keys and finer attention/previews subscriptions after the concurrent
Sessions work lands. Review translated labels around midnight and after travel.

Validation: all 2,286 web tests pass (270 files); all 27 repository static/build
checks pass, including typecheck, oxlint, oxfmt, knip, i18n/locales, audit and UI
registry checks. React Compiler reports zero diagnostics; chat/web bundle,
release graph and size-limit gates pass. The unchanged agent suite's indexing
check timed out during simultaneous whole-repository runs and passed on isolated
retry (9 tests). The shared AG-UI golden fixture must not run in two worktrees at
once. The browser draft runs the whole repository suite sequentially. The stale
routing spy assertion already repaired in #225 is included identically here; it
asserts resulting route/query behavior and changes no production UI.

Rebased onto `420a4a54` after the avatar/license PRs landed. All 29 static/build
checks, including the new license policy gate, and 13 targeted date/routing tests
pass on that base. Production comparison numbers elsewhere retain the original
`097b0934` baseline so unrelated upstream work does not enter the comparison.
