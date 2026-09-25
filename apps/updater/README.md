# @abacus-ai/updater

The experience build toolchain: deterministic experience archives, the
canonical manifest, the change classifier, and a development-only TUF
repository (publisher plus read-only server).

- `dist/experience.mjs --renderer <dir> --agent <dir> --output <dir>` builds
  `<output>/current/{renderer,agent,manifest.json}` and a byte-reproducible
  `<output>/experience.zip`.
- `dist/publish.mjs <experience.zip>` signs the archive into the local dev
  repository as the `experience/latest.zip` TUF target.
- `dist/refresh.mjs` re-signs snapshot and timestamp with fresh expiries
  without touching targets. A scheduled job runs it between releases so
  client verification never hits an expired timestamp.
- `dist/dev.mjs` bootstraps the dev repository (ed25519 key per role) and
  serves it read-only on `127.0.0.1:4321`.
- `git diff --name-only <base>..<head> | node dist/classify.mjs` prints the
  smallest safe release for a change set: `experience`, `foundation`, or
  `none`. Unknown paths fail toward `foundation`.

The desktop verifier (`apps/desktop/src/main/experience/integrity.ts`)
recomputes every digest from the same JSON canon as `src/manifest.ts`, so
builder and verifier share one contract. Production publishing
signs the same metadata with managed keys in the release pipeline; this
repository never serves private keys and the server is GET-only.

Data lives in `.data/updater/` (override with `ABACUSAI_BOT_UPDATE_DATA`).
Non-root metadata lifetimes are tunable via `ABACUSAI_BOT_TUF_TARGETS_DAYS`
(90), `ABACUSAI_BOT_TUF_SNAPSHOT_DAYS` (30), and
`ABACUSAI_BOT_TUF_TIMESTAMP_DAYS` (14); root stays at 365. The desktop reads
`ABACUSAI_BOT_UPDATE_URL`, `ABACUSAI_BOT_UPDATE_ROOT`, and
`ABACUSAI_BOT_UPDATE_INTERVAL_MS`.
