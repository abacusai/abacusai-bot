The parity baseline is the sum of the final emitted renderer `.js` files (byte
length and Node `gzipSync` length, both documents, no maps or metadata) of
the recorded source commit. `check-desktop-parity.mjs` allows each total to
grow by at most 1%.

The baseline guards against accidental growth (a dependency pulled into the
renderer, a chunk split by a stray import), not against features. A feature
that needs more is measured, reviewed and recorded here as a new baseline,
in a commit of its own that says by how much it grew.

## Current: `924f48c4` (panel workspace, routines panel, split start-up)

**384 / 7205714 / 2419049.** Records the renderer as merged through `924f48c4`.
Against `700190fc`: +62 chunks (+19.25%), +705580 bytes (+10.85%), +230916
gzip bytes (+10.55%). The 1% allowance is unchanged.

Where it grew, measured per merge from clean builds (bytes / gzip bytes):

- The session panel workspace: the dockable panel layout behind the title bar
  (#223), +400415 / +95020, then the unified workspace tabs (#239), +19764 /
  +7620 with four fewer chunks.
- The routines panel and unattended mode (#271): +78896 / +26862, +3 chunks.
- Start-up and onboarding (#292): React's DOM client and the start-up screens
  load in their own chunks, +35 chunks for +10814 / +27216.
- Selectable replies and link previews (#285): +31632 / +12520.
- Browser attachments that name their source (#303): +26674 / +9613.
- Shared page spacing and controls (#243): +25877 / +7613.
- Account controls in the left rail (#286): +25755 / +9377.
- Session drafts and compact composer attachments (#308): +20810 / +7754.
- Model setup from the composer picker (#300): +17891 / +6004.
- Files and workspace selection on the web (#295): +13260 / +4989.
- The command palette's navigation (#231): +11132 / +4926.
- Individual avatar faces (#270), with #306/#307, measured together across
  the lockfile fix (#310) they needed to install: +7095 / +2869.
- Removing routine approval (#299): -12770 / -3482.
- Everything else together: +12 chunks, +28335 / +12015.

Measured from clean source-archive builds of each merge (frozen-lockfile
install, Linux x64, Node 24). The regeneration helper now gives its throwaway
install a repository of its own, since the install's `prepare` step installs
git hooks; it still never touches a worktree. This baseline-only commit
changes no renderer code.

## History

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
