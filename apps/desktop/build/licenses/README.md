# Desktop license sources

The packager generates `THIRD-PARTY-NOTICES.txt` from installed desktop runtime
dependencies and the agent's build source maps, including transitive dependencies.
There is no separate license-check command or checked-in dependency inventory.

Upstream license and NOTICE files are preserved. If an npm package supplies only
an SPDX identifier, the output includes the standard terms and the package's
attribution metadata and README, and identifies that fallback explicitly.

`sources.json` covers copied icons and downloaded tools that npm cannot discover.
Its license texts are appended to the same output, along with the existing font
and template licenses. Keep the upstream texts when replacing these assets.
Other connector glyphs come from simple-icons (CC0-1.0); brand names and marks
remain the property of their respective owners.
