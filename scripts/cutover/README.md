# Cut-over evidence tools

`make-legacy-home.mjs` launches an original packaged build on a fresh, marked synthetic home. It creates data through that build's `window.api`, records the source archive and executable hashes, records its calls and hashes each retained file. On macOS, a subprocess sandbox blocks outbound network access so an experience download cannot silently replace the source renderer. Chromium's own sandbox is disabled for this nested diagnostic subprocess; this is not signed-artifact acceptance.

The generator writes an incomplete producer manifest and exits 1 when a required operation cannot be proven. An incomplete archive must end in `.partial.tar.zst`. It never replaces an existing home or archive. A second synthetic profile uses the spec's permitted profile-registry construction. Normal transcripts, preferences, geometry and memories use the source API. The two corrupt/unknown-version histories are explicit exceptions. Routine evidence distinguishes recorded attempts from completed executions.

Example, with paths to an original artifact:

```sh
node scripts/cutover/make-legacy-home.mjs \
  --source /absolute/path/to/packaged/executable \
  --source-archive /absolute/path/to/original/archive.zip \
  --version v1.0.85 --kind migration \
  --out .build/cutover/fresh-source-home \
  --archive apps/desktop/src/main/migrations/__fixtures__/legacy-home-pre-rewrite-v1.0.85.partial.tar.zst
```

`--kind perf` also attempts completed onboarding and synthetic credential admission through a loopback-only account stub. The stub never forwards traffic. The shipped build currently bypasses this proxy for its main-process account fetch and rejects the key. No completed perf fixture or M1–M5 measurement is produced from that failure. Debugger instrumentation is a pending user decision. The reviewed alternative is `source-fetch-proxy.mjs`; it redirects only account/model requests to loopback, blocks every other fetch, checks the exact marked synthetic home and leaves the packaged binary unchanged. `--instrument-source-fetch` is disabled by default and has not run against the shipped app. If approved, the producer records the script and its hash.

`perf-compare.mjs` alternates seven packaged old/new pairs and discards the first pair. Both use the same injected bot/composer and long-session probes. It records median/p90, process-parent RSS without agents, a collected renderer heap and gzip bytes of JS/CSS actually observed by CDP Network before FCP. ResourceTiming alone omits the custom-scheme entry resources, so it is not used for M6.

Full measurements require a complete source-produced performance fixture and a separately migrated candidate home. Both copy only files whose hashes agree with their manifests. Use `--home`, `--producer`, `--new-home` and `--new-producer`; the candidate producer must record `alreadyMigrated`. The driver refuses an onboarding or incomplete fixture. Wrong-theme screencast classification and companion RSS attribution remain unimplemented, and the report records these gaps rather than claiming M2/M3 acceptance. The Windows parentage sampler exists but has not run on Windows hardware.

`--m6-diagnostic` measures only bundle loading on fresh onboarding homes. It cannot satisfy the full performance gate:

```sh
node scripts/cutover/perf-compare.mjs \
  --old /absolute/path/to/shipped/executable \
  --new /absolute/path/to/candidate/executable \
  --m6-diagnostic --out .build/cutover/new-m6-report.json
```

Reports are immutable. The committed diagnostic records a failed numeric M6 budget, not a release pass. Run the tooling checks with `node --test scripts/cutover/*.test.mjs`.
