The parity baseline is the sum of the final emitted renderer `.js` files (byte
length and Node `gzipSync` length, both documents, no maps or metadata) of
the recorded source commit. `check-desktop-parity.mjs` allows each total to
grow by at most 1%.

The baseline guards against accidental growth (a dependency pulled into the
renderer, a chunk split by a stray import), not against features. A feature
that needs more is measured, reviewed and recorded here as a new baseline,
in a commit of its own that says by how much it grew.

## Current: `d1aeab42` (faster navigation, connection manager)

**310 / 6144302 / 2053560.** Bumped after the navigation and interaction
work (#152) and the connection manager with the provisional browser shell
(#155) landed: hover warming, the shared notice hub, the lazy chat runtime
and the per-socket transport each add a small chunk to the Electron renderer,
and the cap was already sitting on the old tip. Against the old baseline
below: +4 chunks, +44381 bytes (+0.73%), +17127 gzip bytes (+0.84%).

## History

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
arguments it reproduces the current baseline: `d1aeab42` against its own
lockfile (sha256
`a1e15b3de8f94fffeb0fae7c46fbe72b8e0fada1a4c04bca561c73082e56360c`).
Verified on Linux x64, Node 24.20.0, pnpm 12.6.0, Vite 8.2.1, Rolldown 1.2.4;
a clean forced `turbo run build` of the same tree measures the same totals.
