# Desktop license sources

The packager generates `THIRD_PARTY_NOTICES.txt` from installed desktop runtime
dependencies and the agent's build source maps, including transitive dependencies.
There is no checked-in generated dependency inventory.

Upstream license and NOTICE files are preserved. If an npm package supplies only
an SPDX identifier, the output includes the standard terms and the package's
attribution metadata and README, and identifies that fallback explicitly.

`sources.json` covers copied icons and downloaded tools that npm cannot discover.
Its license texts are appended to the same output, along with the existing font
and template licenses. Keep the upstream texts when replacing these assets.
Other connector glyphs come from simple-icons (CC0-1.0); brand names and marks
remain the property of their respective owners.

The dependency inventory and deduplicated JSON now regenerate with
`pnpm generate:licenses`. Turbo runs that task before desktop/web development
and builds. `pnpm check:licenses` runs the transform/policy tests and generation;
it is part of `pnpm check`. Packaging repeats discovery from the final source
maps and updates the renderer assets and installer notices. Generated files are
ignored, matching the existing notices convention, so no inventory can become
stale in git. The package build/dev scripts also generate before Vite. Run generation first
when invoking the Vite CLI directly.

Coverage includes the installed production closure of desktop, web, updater,
and runtime workspace packages, with pnpm's removed backends and compile-only type peers excluded. Source
maps add shipped code declared as development dependencies. Source asset
imports, copied font/template texts, and `sources.json` cover non-code assets.
Sounds are synthesized by the app. Electron's distribution supplies its MIT
license and the complete Chromium/embedded Node.js notices, copied verbatim
into both web assets and installer resources. Python is invoked from the user's
system; no Python distribution is bundled.

`license-data.mjs` contains the SPDX allowlist. MPL-2.0 requires preservation of
notices and availability of modified covered source files. Unknown terms,
unlicensed packages and strong copyleft fail with package names and versions.
`reviews.json` pins existing exceptions to a package/version/license and source
URL. BusyBox is an existing Windows separate executable under GPL-2.0-only.
Its pinned corresponding-source URL and license are disclosed; legal review
must confirm the installer source-offer obligations before release. This entry
does not authorize a new copyleft dependency or a version bump.

Vendored tool entries name their downloader pin. Generation fails when the
version changes without an updated attribution. Concurrent web/desktop builds
publish complete generated files with atomic renames. Turbo hashes the
generator, policy, manifests, asset licenses and source imports so cached
renderer builds cannot restore notices from a different input graph.
