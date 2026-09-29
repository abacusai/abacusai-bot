# Installer size measurements

The comparison starts at main commit `85665750`, which already moved renderer packages to devDependencies, excluded source maps from the ASAR, and enabled maximum compression. Those existing reductions are not counted again.

The final app revision is `d45b4073`. This branch adds staged-file cleanup before signing, XZ level 9 for DEB, and separate Windows installers when both architectures are requested together. Both builds use Electron 43.4.1 without signing or notarization. The baseline uses electron-builder 26.15.3; the final build uses 26.17.0.

The [baseline test build](https://github.com/abacusai/openwork-package/actions/runs/36556739581) and [optimized test build](https://github.com/abacusai/openwork-package/actions/runs/36560792023) measure the actual artifact files, not GitHub's surrounding artifact ZIP. Small differences in version stamps and build timestamps remain. The package repo's `measure-installer-sizes` branch records every format and validates updater SHA-512 values and sizes against the finished artifacts.

MB means 1,000,000 bytes.

| OS / architecture | Format | Before, MB | After, MB | Reduction |
| --- | --- | ---: | ---: | ---: |
| macOS x64 | dmg | 154.84 | 143.46 | 7.35% |
| macOS x64 | zip | 170.74 | 152.45 | 10.71% |
| macOS arm64 | dmg | 153.43 | 142.02 | 7.43% |
| macOS arm64 | zip | 168.25 | 149.88 | 10.92% |
| Windows x64 | exe | 154.23 | 152.40 | 1.19% |
| Windows arm64 | exe | 134.00 | 134.08 | -0.06% |
| Linux x64 | deb | 147.96 | 117.43 | 20.63% |
| Linux x64 | AppImage | 148.23 | 136.15 | 8.15% |
| Linux arm64 | AppImage | 136.09 | 123.95 | 8.92% |
| Linux arm64 | deb | 136.69 | 107.77 | 21.16% |

The cleanup preserves every regional and gender variant of the app's supported languages. Chromium native UI for other languages falls back to English; web content, ICU data, and spellcheck dictionaries remain. The hook derives supported languages from the renderer locale files rather than maintaining a second list.

The hook removes tens of megabytes of uncompressed files per target, including 59.3 MB in the local macOS arm64 build. The final cleanup also omits copied platform icons that the runtime does not load, Zod TypeScript sources, and node-forge browser distributions. It retains the generated macOS icon, compiled Node entry points, and licenses. Other removals are agent dependency source maps, type declarations, incremental-build stamps, foreign-platform sandbox binaries, and foreign-platform Python parsers. Python parser sources are removed only when a target parser or compiled fallback exists. The hook changes the staged app, leaving installed dependencies intact. It retains licenses, Java proxy support, native addons, WebAssembly, graphics fallbacks, codecs, and snapshots.

The broader configuration review covered these choices:

| Area | Decision |
| --- | --- |
| ASAR and unpacking | Keep ASAR and the existing narrow native-module unpack rules. ASAR is not a compression format. Unpacking more files does not shrink downloads. |
| Production dependency collection | Keep the current runtime dependency tree. Inlined updater code still has bare imports of transitive dependencies. Removing their parent packages breaks those imports. |
| Electron languages | Use `afterPack` to handle macOS underscores and Chromium's gender variants while retaining every supported language. The built-in `electronLanguages` option uses exact/prefix matching, not the application's language list. |
| DEB | Set `deb.compression: xz` and `--deb-compression-level=9`. Global maximum compression does not set FPM's default XZ level of 3. |
| NSIS | Preserve differential packages and the elevation helper. Do not force solid compression or a larger dictionary at the expense of update downloads. `buildUniversalInstaller: false` prevents multi-architecture invocations from combining payloads. The measured CI already builds each architecture separately. |
| DMG | Keep the stable builder's smaller UDBZ output after comparing LZFSE. ULMO is smaller but requires v27 support; v27 was still `27.0.0-alpha.9` when checked. |
| macOS ZIP | Keep the ZIP target, maximum Deflate compression, and symlink-preserving archive creation. The updater needs this format. |
| AppImage | Compare the modern static runtime and Zstandard against the current XZ output. The modern 1.0.3 runtime removes the external FUSE2 dependency, but produced 167.84 MB on x64 and 160.41 MB on arm64, versus 137.98 MB and 125.78 MB with XZ. Retain XZ for smaller downloads. |
| Package metadata and PDBs | Script/keyword stripping and PDB exclusion already have size-conscious defaults. Repeating those defaults adds no reduction. |
| Renderer assets | Retain the speech-recognition WASM CPU fallback, editor workers, and bundled fonts. Their removal would disable features or reduce hardware coverage. |
| RPM, Snap, MSI and web installers | These are not current release targets. Adding them would change distribution behavior without reducing the existing artifacts. |

The DMG and alternative AppImage benchmarks used electron-builder 26.15.3. Local DMG tests used the same pruned macOS arm64 app. UDBZ was 141,170,235 bytes; ULFO was 151,983,372 bytes. A native `hdiutil` conversion to ULMO produced 116,476,658 bytes. ULMO remains a measured future option, not a schema bypass or a prerelease dependency in this branch.

Windows arm64 install testing exposed a preexisting [NSIS archive-filter regression](https://github.com/electron-userland/electron-builder/issues/9983). Both baseline and initial optimized installers exited successfully but omitted the executable. The 26.17.0 builder uses an archive filter its install-time extractor supports. This update is included in the final size measurements. Its compatible archive filter compresses less effectively: Windows arm64 is 85,236 bytes (0.06%) larger than baseline despite the smaller installed payload. Windows x64 is 1.19% smaller. Earlier measurements with the broken extractor were smaller but are not the final results.

Validation includes 26 passing packaging, startup-import, agent-dependency, and license-notice tests; desktop typechecking; formatting and lint; packaged resource checks; macOS startup; and actual imports of the pruned agent's Python parser, sandbox runtime, terminal UI, and Photon WASM. The [final native-runner checks](https://github.com/abacusai/openwork-package/actions/runs/36560846296) passed on all six OS/architecture combinations: DMG mount/copy and launch on macOS, NSIS installation and launch on Windows, and AppImage extraction and launch on Linux. Windows checks also execute the installed ripgrep and fd binaries and confirm native addons survived extraction. All six builds passed update-feed hash/size validation. DEB installation and a FUSE-mounted AppImage launch were not exercised. The macOS x64 test was rerun after its artifact wait expired while the build was still running.

These unsigned tests do not validate Gatekeeper, notarization, certificate trust, or a complete signed update installation. Signing settings, update URLs, artifact names, channels, and update code are unchanged. The [afterPack lifecycle](https://www.electron.build/v26/docs/configuration/#afterpack) runs cleanup before signing and artifact generation; no hook rewrites completed installers or their blockmaps.

References: [application contents](https://www.electron.build/v26/docs/contents/), [NSIS differential packages](https://www.electron.build/v26/docs/nsis/#differentialpackage), [DMG formats](https://www.electron.build/v26/docs/dmg/), [AppImage toolsets and compression](https://www.electron.build/v26/docs/appimage/), [FPM DEB compression implementation](https://github.com/jordansissel/fpm/blob/main/lib/fpm/package/deb.rb), and [v27 changes](https://www.electron.build/docs/migration/whats-new-v27/). Configuration choices were also checked against the installed builder implementations because current documentation includes options introduced after that version.
