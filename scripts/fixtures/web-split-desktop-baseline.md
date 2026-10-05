The parity baseline is the sum of the final emitted renderer `.js` files (byte
length and Node `gzipSync` length, both documents, no maps or metadata) of
source commit `99f20795`. `check-desktop-parity.mjs` allows each total to grow
by at most 1%.

Regenerate with `bash scripts/fixtures/regenerate-web-split-desktop-baseline.sh`.
It builds a `git archive` of `99f20795` against the dependencies of a fresh,
frozen-lockfile install of `6f9b4c10` (lockfile hash checked by the script) and
prints JSON to compare with `web-split-desktop-baseline.json`; it never
overwrites the fixture or touches a worktree. Reusing an existing install can
change the graph (a nested `@tanstack/store`), which is why the script installs
fresh. Verified on Linux x64, Node 24.20.0, pnpm 12.6.0, Vite 8.2.1, Rolldown
1.2.4: **306 / 6099921 / 2036433**.
