The parity baseline is the sum of the final emitted renderer `.js` files (byte
length and Node `gzipSync` length, both documents, no maps or metadata) of
the recorded source commit. `check-desktop-parity.mjs` allows each total to
grow by at most 1%.

The baseline guards against accidental growth (a dependency pulled into the
renderer, a chunk split by a stray import), not against features. A feature
that needs more is measured, reviewed and recorded here as a new baseline,
in a commit of its own that says by how much it grew.

## Current: `5504c7cf` with Channels (#678)

**430 / 8224918 / 2753945.** Records the renderer with Channels (#678): the
channel page and its details (one lazy route chunk of 37719 bytes, 13197
gzip, and a 2762-byte second chunk), the channel rows the bots list shares
with it (`group-rows`, 5817 bytes), and the `channels.*` strings in every
locale chunk. Against `ce39b54f5` with #664: +4 chunks (+0.94%), +79868
bytes (+0.98%), +28941 gzip bytes (+1.06%); gzip was 28941 bytes over the
allowance's 27250. `apps/web`'s dependencies did not change. The 1% allowance
is unchanged.

Measured from a build of main at `5504c7cf` merged with #678 (Linux x64),
summed the same way as `check-desktop-parity.mjs`; the totals equal what CI
reported on the branch. This baseline-only change touches no renderer code.

## History

### `ce39b54f5` with Share (#664)

**426 / 8145050 / 2725004.** Records the renderer with the paid welcome (#662)
and Share (#664), which took it 3926 bytes past the 1% allowance. Against
`bd66921c9`: +3 chunks (+0.71%), +84531 bytes (+1.05%), +29668 gzip bytes
(+1.10%). The growth is not split by change here; `apps/web`'s dependencies did
not change. The 1% allowance is unchanged.

Measured from a frozen-lockfile build of `ce39b54f5` with #664 (Linux x64),
summed the same way as `check-desktop-parity.mjs`. This baseline-only change
touches no renderer code.

### `bd66921c9` (the features merged since #630)

**423 / 8060519 / 2695336.** Records the renderer after the work merged since
#630, the last of it #661's turn credits line. Against `de9cd7eba`: +3 chunks
(+0.71%), +76320 bytes (+0.96%), +25229 gzip bytes (+0.94%). That left 3522
bytes of the 1% allowance, so the next feature's strings would fail the check.
The growth is not split by change here; `apps/web`'s dependencies did not
change. The 1% allowance is unchanged.

Measured from a frozen-lockfile build of `bd66921c9` (Linux x64), summed the
same way as `check-desktop-parity.mjs`. This baseline-only change touches no
renderer code.

### `de9cd7eba` (the failure card for a model off Abacus, #630)

**420 / 7984199 / 2670107.** Records the renderer with #630's handling of a
failed model off Abacus: the line that says the chat moved to RouteLLM - Open,
and the card that names the failed model with the plan's full offer when the
credits are used up. Against `0ba0d4315`: -2 chunks, +87597 bytes (+1.11%),
+19931 gzip bytes (+0.75%). Main at `f208fea31` (#620, before #630) stood at
420 / 7965493 / 2665540 (+0.87% bytes, under the 1% allowance); #630 adds
+18706 bytes (+0.24%) and +4567 gzip bytes on top of it: about 4.8 kB in the
shared `ui` chunk for the card and the notice, the rest its new strings in each
locale chunk. No dependency or chunk split. The 1% allowance is unchanged.

Measured from a frozen-lockfile build of `de9cd7eba` and of `f208fea31`
(Linux x64), summed the same way as `check-desktop-parity.mjs`. This
baseline-only change touches no renderer code.

### `0ba0d4315` (the first-run screen)

**422 / 7896602 / 2650176.** Records the renderer with onboarding's first-run
screen (what to do first, and the inbox pass after a Gmail sign-in). Against
`49eb0f84`: +5 chunks (+1.20%), +55119 bytes (+0.70%), +17597 gzip bytes
(+0.67%). Main at `fb0c2714a` stood at 417 / 7844523 / 2633149 (+0.04%
bytes, under the 1% allowance); the screen adds +5 chunks, +52079 bytes
(+0.66%) and +17027 gzip bytes (+0.65%) on top of it. The five chunks are
small modules the onboarding route now shares with other lazy chunks (two
icons, the build examples list, the tool-call reader and the attention cues),
split out of the chunks that used to hold them alone. The 1% allowance is
unchanged.

Measured from a frozen-lockfile build of `0ba0d4315` and of main at
`fb0c2714a` (Linux x64), summed the same way as `check-desktop-parity.mjs`.
This baseline-only change touches no renderer code.

### `49eb0f84` (GitHub PR review, #517)

**417 / 7841483 / 2632579.** Records the renderer with the session's pull
request tab (the PR's conversation, checks, files and review composer) and
its chip in the context tray. Against `e38c6a995`: +12 chunks (+2.96%),
+117944 bytes (+1.53%), +42198 gzip bytes (+1.63%). Main at `64dddfe0` stood
at 406 / 7744214 / 2597595 (+0.27% bytes, under the 1% allowance); the PR
tab adds +11 chunks, +97269 bytes (+1.26%) and +34984 gzip bytes (+1.35%) on
top of it. Two chunks are the tab itself (`pr-tab`, `pr-presentation`); the
other nine are modules the lazy PR tab now shares with other lazy chunks
(the diff view, markdown, a few icons and UI primitives), split out of the
chunks that used to hold them alone. The 1% allowance is unchanged.

Measured from a frozen-lockfile build of `49eb0f84` and of main at
`64dddfe0` (macOS arm64), summed the same way as
`check-desktop-parity.mjs`. This baseline-only change touches no renderer
code.

### `e38c6a995` (turn checkpoints, #500)

**405 / 7723539 / 2590381.** Records the renderer with the turn checkpoint
card (a turn's changed files, their diffs and restore). Against `1096c705`:
+1 chunk (+0.25%), +89589 bytes (+1.17%), +25144 gzip bytes (+0.98%). Main at
`7b091dc0f` stood at 404 / 7701643 / 2583091 (+0.89% bytes, under the 1%
allowance); the checkpoint card adds +1 chunk, +21896 bytes (+0.28%) and
+7290 gzip bytes on top of it. The 1% allowance is unchanged.

Measured with `regenerate-web-split-desktop-baseline.sh e38c6a995 e38c6a995
7dc9b5d46877f308e5b869cf1e29aafd08d2fbf9dbbb25a87c6a84dc0eccb750` (isolated
archives, frozen-lockfile install, Linux x64), and main the same way at
`7b091dc0f`. This baseline-only change touches no renderer code.

### `1096c705` (the app in Turkish)

**404 / 7633950 / 2565237.** Records the renderer with the Turkish locale
(`tr-TR`). Against `cb77304c`: +3 chunks (+0.75%), +198146 bytes (+2.66%),
+65418 gzip bytes (+2.62%). The Turkish strings are one lazily loaded chunk
of 164411 bytes (54240 gzip), the same shape as every other locale; the rest
is what merged to main after `cb77304c` (main stood under the 1% allowance).
The 1% allowance is unchanged.

Measured with `regenerate-web-split-desktop-baseline.sh 1096c705 1096c705
bc25648568bcc79597a09c974e0a8e56e2481596411e5ae84cc9e48fdff2e3a8` (isolated
archives, frozen-lockfile install, Linux x64); the totals equal what CI
reported on this branch. This baseline-only change touches no renderer code.

### `cb77304c` (the routine page's runs, #455)

**401 / 7435804 / 2499819.** Records the renderer with the routine page's
run report, runs rail and title-bar actions (#455). Against `27f265ae`: +6
chunks (+1.52%), -9701 bytes (-0.13%), -1984 gzip bytes (-0.08%). Main at
`665924aa` stood at 395 chunks. The six are shared modules Rollup now splits
out because the routine route imports them too: five lucide icons, the title
bar and the sessions deliverables card, less `resizable`, which folds back
in. The 1% allowance is unchanged.

Measured from a clean local build of `cb77304c` (frozen-lockfile install,
Linux x64); this baseline-only change touches no renderer code.

### `27f265ae` (the tool UI redesign, #436)

**395 / 7445505 / 2501803.** Records the renderer at the merge of main into
the tool UI branch (#436): grouped tool runs, the sessions deliverables card,
per-pane title bar tabs, markdown tables, the visualizer widget, bash output
and component tool rows, plus the sub-agent detail and dock fixes. Against
`bc75d297c`: +5 chunks (+1.28%), +98481 bytes (+1.34%), +36134 gzip bytes
(+1.47%). Part of that is what merged to main after `bc75d297c` (main stood
just under the 1% allowance). The 1% allowance is unchanged.

Measured from a local build of the merged tree (`check:react-compiler` build,
macOS arm64); the chunk count equals what CI reported on this branch (395).
This baseline-only change touches no renderer code.

### `bc75d297c` (the Routines landing)

**390 / 7347024 / 2465669.** Records the renderer at `bc75d297c`, the Routines
landing (#431): with no routine open, the area shows the way to make one and
the six routine templates. Against `43330457`: +2 chunks (+0.5%), +75321 bytes
(+1.04%), +24174 gzip bytes (+0.99%). Most of that is what merged to main
after `43330457` (main stood just under the 1% allowance); the landing, its
template cards and four strings in every locale took the byte total over it.
The 1% allowance is unchanged.

Measured with `regenerate-web-split-desktop-baseline.sh bc75d297c bc75d297c
bc25648568bcc79597a09c974e0a8e56e2481596411e5ae84cc9e48fdff2e3a8` (isolated
archives, frozen-lockfile install, Linux x64); this baseline-only change
touches no renderer code.

### `43330457` (renderer as merged while CI was red)

**388 / 7271703 / 2441495.** Records the renderer as merged through
`43330457` (#369). Main's CI has failed since early October on other steps,
so this guard ran on every merge but its failure was never the first one
anyone looked at. Against `700190fc`: +66 chunks (+20.5%), +771569 bytes
(+11.9%), +253362 gzip bytes (+11.6%). The growth is spread across the
onboarding, phone, routines, billing and settings work merged in that window
and was not measured per merge. The 1% allowance is unchanged.

Measured from a clean worktree build of `43330457` with the #370 lockfile
(frozen-lockfile install, Linux x64); this baseline-only change touches no
renderer code.

### `700190fc` (renderer as merged while the guard was not running)

**322 / 6500134 / 2188133.** Records the renderer as merged through `700190fc`.
While the desktop build failed in CI (the notices step needed the Electron
binary before it was fetched), this guard never ran. Against `7926220a`:
-1 chunk, +53365 bytes (+0.83%), +22018 gzip bytes (+1.02%). The 1% allowance
is unchanged.

Where it grew, measured per merge from clean builds (gzip bytes):

- #221 (bot avatar expressions and character motion): +21522 over the build
  before it. The previous baseline was measured on the license browser's
  branch, which did not have #221, so it never counted. This is the overshoot.
- #224 (the license browser): +11426 where it merged. It was already in the
  previous baseline, which measured it at +11359, so it adds nothing here.
- #225, #229, #230: +291 together; #235: +360; #234: -222.
- The merges after it, through #238, change no renderer code.

Measured from a clean worktree build of `700190fc` (frozen-lockfile install,
Linux x64, Node 24); this baseline-only commit changes no renderer code.

### `7926220a` (open-source license browser)

**323 / 6446769 / 2166115.** The About license section and its deferred browser
add five renderer chunks. Against the same clean build of `097b0934`
(**318 / 6416930 / 2154756**), this adds 29839 bytes (+0.47%) and 11359 gzip
bytes (+0.53%). The license inventory and notices are separate static assets,
loaded on request, and add no bytes to these JavaScript totals. The chunk
count needs a new baseline; the 1% allowance is unchanged.

Measured from isolated source archives with separate fresh frozen-lockfile
installs on macOS ARM64, Node 22.19.0, pnpm 12.6.0, Vite 8.2.1 and Rolldown
1.2.4. The regeneration helper now links the installed dependencies of all
workspace packages, including contract's agent dependency, into the source
archive. This baseline-only commit changes no renderer code.

### `85fc8927` (companion controls, connect route, browser tasks)

**318 / 6416113 / 2154405.** Records the renderer as merged through `85fc8927`:
the companion controls moved out of the Electron-only notch folder into their
own shared chunks, the single connect route for MCP connectors, and the
built-in browser for phone tasks. Against `0c83c457`: +4 chunks (+1.27%),
+18805 bytes (+0.29%), +7599 gzip bytes (+0.35%). The bytes stayed inside the
1% allowance; the chunk count did not, because the split moved code into new
chunks rather than growing it. The 1% allowance is unchanged.

Measured from a clean worktree build of `85fc8927` (frozen-lockfile install,
Linux x64, Node 24); the branch that records it adds no chunks.

### `0c83c457` (merged renderer features)

**314 / 6397308 / 2146806.** Records the merged onboarding, composer,
message actions, side panel and provider marks through `1837542b`, with the
CI dependency fixes in `0c83c457`. Against the Appearance baseline below:
unchanged chunk count, +203576 bytes (+3.29%), +72125 gzip bytes (+3.48%).
The 1% allowance is unchanged.

Measured from a source archive and a fresh frozen-lockfile install on macOS
ARM64, Node 22.19.0, pnpm 12.6.0, Vite 8.2.1 and Rolldown 1.2.4. The clean
worktree build produces identical totals.

### `389b450a` (Appearance)

**314 / 6193732 / 2074681.** Bumped for the Appearance settings section: the
look's colour engine and contrast solver (`lib/look.ts`, its own chunk), the
Appearance page and VS Code theme import (their own route chunk), and the
form chunks the page now shares with other routes instead of being folded
into the General page's chunk. Against the previous tip (`d1aeab42`,
310 / 6144302 / 2053560, measured the same way): +4 chunks, +49430 bytes
(+0.80%), +21121 gzip bytes (+1.03%); against the old baseline below, +8
chunks, +1.54% bytes, +1.88% gzip.

- `d1aeab42` (faster navigation, connection manager; #160): **310 / 6144302 / 2053560**,
  +4 chunks, +0.73% bytes, +0.84% gzip over the web split.
- `99f20795` (the web split): **306 / 6099921 / 2036433**, built against
  `6f9b4c10`'s dependencies (lockfile sha256
  `0c5f8fc01514231647828025d3e0ef6c62276b7158f7db3e0cbb1f8caef9cfcd`);
  reproduce with
  `bash scripts/fixtures/regenerate-web-split-desktop-baseline.sh 99f20795 6f9b4c10 0c5f8fc01514231647828025d3e0ef6c62276b7158f7db3e0cbb1f8caef9cfcd`.

## Regenerating

`bash scripts/fixtures/regenerate-web-split-desktop-baseline.sh [source] [deps] [lock-sha256]`
builds a `git archive` of the source commit against the dependencies of a
fresh, frozen-lockfile install of the deps commit (by default the source
itself; the lockfile hash is checked) and prints JSON to compare with
`web-split-desktop-baseline.json`; it never overwrites the fixture or
touches a worktree. Reusing an existing install can change the graph (a
nested `@tanstack/store`), which is why the script installs fresh. With no
arguments it reproduces the current baseline: `7926220a` against its own
lockfile (sha256
`233e97a875f5f4a00a94b1de33b706fe28c3abbca8bcf14b4efe7f23b9729328`).
