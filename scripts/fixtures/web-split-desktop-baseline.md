The parity baseline measures final emitted renderer `.js` files from source
commit `99f20795`. Sum each file's byte length and Node `gzipSync` length,
including both renderer documents' chunks. Source maps and metadata are excluded.

Run from the main checkout:

```sh
export PATH="$(npm prefix -g)/bin:$PATH"
bash scripts/fixtures/regenerate-web-split-desktop-baseline.sh
```

Verified on Linux x64, Node **v24.20.0**, pnpm **12.6.0**, Vite **8.2.1**,
Rolldown **1.2.4**, on 2026-10-04. The script prints JSON to compare with
`web-split-desktop-baseline.json`; it leaves both temporary archives for inspection
and does not overwrite the fixture. Expected totals: **306 / 6099921 / 2036433**.

Dependency source is a separate fresh `git archive 6f9b4c10`, installed with
`pnpm install --frozen-lockfile`, using its committed `pnpm-workspace.yaml`
(`nodeLinker: hoisted`). Its `pnpm-lock.yaml` SHA-256 is
`0c5f8fc01514231647828025d3e0ef6c62276b7158f7db3e0cbb1f8caef9cfcd`, checked by the
script before installation. The source archive's historical lockfile SHA-256 is
`98db5cee9a6a38ce27d7fa73de0460cd70fde081f61f0bb54fde2e3d66ae7b0f`; that lockfile is
**not** installed. Connectors and agent outputs are built in the dependency
archive before building the historical renderer. No dependency directories are
reused from the main checkout. Reusing an existing hoisted install can retain a
nested `@tanstack/store` under `@tanstack/react-store` and change the graph, as the
r2 review observed; a lockfile hash alone does not describe such a reused install.

The historical archive links its root `node_modules` and
`apps/desktop/node_modules` to the corresponding fresh dependency archive paths.
Vite runs with cwd `apps/desktop`, using the historical config and only its client
build environment. The renderer sources/config are unmodified. The script sets
`GIT_DIR` to the main checkout's `.git` and `GIT_WORK_TREE` to the archive for
provenance. It unsets `NODE_ENV`, `NO_COLOR`, release/build commit overrides,
`VITE_UI_GALLERY`, `VITE_NEXT_DB_FIXTURES`, and `VITE_CONNECT_SRC` for the renderer;
installation unsets `NODE_ENV` and `CI`. The exact commands, including package
builds, symlinks, provenance environment and final gzip calculation, are in the
executable script beside this file. No worktree is created or modified.
