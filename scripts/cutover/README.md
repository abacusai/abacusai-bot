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

`--kind perf` also attempts completed onboarding and synthetic credential admission through a loopback-only account stub. The stub never forwards traffic. The shipped build currently bypasses this proxy for its main-process account fetch and rejects the key. No completed perf fixture or M1–M5 measurement is produced from that failure. The synthetic admission failure remains separate from the user-authorized logged-in fixture described below. Debugger instrumentation has not been used. The reviewed alternative is `source-fetch-proxy.mjs`; it redirects only account/model requests to loopback, blocks every other fetch, checks the exact marked synthetic home and leaves the packaged binary unchanged. `--instrument-source-fetch` is disabled by default and has not run against the shipped app. If approved, the producer records the script and its hash.

`perf-compare.mjs` alternates seven packaged old/new pairs and discards the first pair. `--pairs 4` provides a warm-up and three retained alternating pairs. With `fixture.initialSessionName` and `initialSessionId`, both builds open the same short session; readiness requires its final synthetic message and a composer that takes focus. The selected route is recorded. The bot-chat fallback is reserved for fixtures without an initial session. The thread probe opens the Sessions section before timing the long-session click. CDP selects the main `index.html` or `index-next.html` document, excludes the notch document, and keeps per-page Network resource records. M3 follows 60 seconds of idle; M4 follows explicit GC. M6 records gzip bytes of JS/CSS observed before FCP.

`profile-startup.mjs --executable <candidate> --home <fixture> --producer <private manifest> --out <fresh private directory>` copies the fixture through `perf-home.mjs`, attaches the main inspector before module evaluation, and saves a CPU profile plus the CDP route timeline. Profiles and logs must remain private scratch artifacts. Inspector overhead means its timeline is diagnostic, not an M1 sample.

Full measurements accept a complete source-produced performance fixture or a distinct `user-login` producer, and require a separately migrated candidate home. Both copy only files whose hashes agree with their manifests. Use `--home`, `--producer`, `--new-home` and `--new-producer`; the candidate producer must record `alreadyMigrated`. The driver refuses an onboarding or incomplete fixture. Wrong-theme screencast classification and companion RSS attribution remain unimplemented, and the report records these gaps rather than claiming M2/M3 acceptance. The Windows parentage sampler exists but has not run on Windows hardware.

`--m6-diagnostic` measures only bundle loading on fresh onboarding homes. It cannot satisfy the full performance gate:

```sh
node scripts/cutover/perf-compare.mjs \
  --old /absolute/path/to/shipped/executable \
  --new /absolute/path/to/candidate/executable \
  --m6-diagnostic --out .build/cutover/new-m6-report.json
```

Reports are immutable. The committed diagnostic records a failed numeric M6 budget, not a release pass. Run the tooling checks with `node --test scripts/cutover/*.test.mjs`.

## User-login performance homes

The user authorized a logged-in shipped v1.0.85 home for this comparison. Copy it to a private temporary directory outside the repository before any launch or API write. Never launch the original home or put its files, logs or credential manifests in the repository. `.build/` is ignored, but private home copies still belong outside the checkout. The launcher requires `.user-login-cutover-copy` on these scratch copies and blocks outbound traffic on macOS.

A private `producer.json` must record `kind: "perf"`, `provenance: "user-login"`, `sourceVersion: "v1.0.85"`, `sourceGenerated: false`, the description `"user-login, shipped v1.0.85, not source-generated"`, `status: "complete"`, `shellObserved: true`, and `workload.longSessionMessages: 1000`. Record the workload creation method separately. Supply the common `fixture` probe labels and a private `files` hash manifest. The candidate manifest needs `alreadyMigrated: true` after an untimed packaged candidate launch. Incomplete homes and unknown provenance are refused.

The driver creates a private directory with mode 0700 for every run, copies manifest-verified files and removes the run home after stopping the app. Put `--out` outside the repository so app logs stay private. Public measurement output omits the user-login fixture and file manifest. Only reviewed numerical evidence and build provenance may be committed. Compare private original-home hashes before and after the experiment to prove that the source stayed unchanged.

The user-login fixture is an authorized alternative for M1–M5. It does not establish the synthetic migration fixture gates R7-T10–T15 or dormant-release coverage. The 1 October comparison uses API-created data on the copy: 12 bots, 40 sessions, 2,000 histories, and a 1,000-message session. The other histories contain two short synthetic messages. It is not the oversized migration workload of spec 07 §13.3.
