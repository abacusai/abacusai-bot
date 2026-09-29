# Localization audit

Updated 2026-09-30 after source review and a subsequent visual pass in the development Electron app on macOS.

## Startup language

Before the first renderer paint, the app selects a saved supported language, otherwise the first matching OS preferred language, otherwise English. Browser language preferences provide a fallback when the native bridge is unavailable. Regional matching distinguishes Spain and Latin American Spanish. Native menus and the renderer use the same supported-language definitions. Explicit language changes persist and update both surfaces. OS preferences are resolved on launch; this does not promise live tracking of OS changes while the app is open.

## Catalog coverage

All 11 catalogs now contain 2,029 keys. Missing English fallback sentences were translated, interpolation tokens repaired, and plural forms supplied. The allowlist records legitimate unchanged brands, technical terms and cognates as exact key/value pairs; changes cannot silently inherit a blanket exemption.

| Locale | Keys | Missing | Extra | Approved identical values |
| --- | ---: | ---: | ---: | ---: |
| de-DE | 2029 | 0 | 0 | 63 |
| en-US | 2029 | 0 | 0 | 0 |
| es-419 | 2029 | 0 | 0 | 35 |
| es-ES | 2029 | 0 | 0 | 35 |
| fr-FR | 2029 | 0 | 0 | 50 |
| hi-IN | 2029 | 0 | 0 | 24 |
| id-ID | 2029 | 0 | 0 | 43 |
| it-IT | 2029 | 0 | 0 | 38 |
| ja-JP | 2029 | 0 | 0 | 28 |
| ko-KR | 2029 | 0 | 0 | 27 |
| pt-BR | 2029 | 0 | 0 | 38 |

The coverage guard passes with no missing translations, placeholder mismatches or missing plural forms. This measures catalog structure and exact English fallback detection, not semantic correctness. Initial translations were machine-assisted and received targeted manual corrections; native-speaker proofreading remains advisable across the ten non-English catalogs.

## Source changes

Localized native menus, application-owned dialogs and notifications, crash/recovery copy, file prompts, renderer labels and accessibility text. Audited chat, bots, routines, onboarding, settings, workspace and terminal UI. Dates, numbers, list summaries and plurals follow the selected locale. Replaced concatenated onboarding headings with complete translated messages.

The visual pass exposed registry text that bypassed catalog checks. All 26 connector descriptions, GitHub setup instructions and all 20 model-provider descriptions now resolve through translation keys, including search and tooltips. A registry coverage test prevents new entries from silently bypassing the catalog. Application-owned missing-provider notices are translated; arbitrary external errors remain verbatim.

Strengthened the JSX guard with AST parsing and added catalog checks for missing/empty entries, interpolation, plural coverage, untranslated English and stale literal exceptions. These scanners do not prove that every possible dynamically constructed UI string is localized.

## Visual verification after source review

Used an isolated development profile and a renderer-only preview account fixture; no real account, connector or scheduled task was exercised.

| Surface | Locales inspected | Observations |
| --- | --- | --- |
| Welcome/onboarding entry | All 11 | Fonts rendered and copy fit the card; Portuguese wrapped naturally. Some wording was corrected after these initial screenshots. |
| Native menus and language selection | German, Japanese | Translated menu labels; selecting Japanese updated the renderer and native menu, and survived restart. |
| Profile/sidebar/composer | German, Japanese | Checked labels and layout; found and subsequently fixed an English application-owned provider diagnostic. |
| Bots home | Japanese; German accessibility inspection | Template card UI localized; stored bot names/titles remain user content. |
| Routines list and creation dialog | Japanese | Corrected execution-related wording. Replaced crowded schedule chips with a wrapping grid; verified final layout and scroll access to lower fields and footer. |
| Connectors and models | Japanese | Found English descriptions, localized the registries, and rechecked both screens. |
| Tools settings | Japanese | Inspected rendered settings and accessibility labels. |
| MCP list and add-server dialog | Japanese | Inspected labels and layout; cancelled without creating a server. |
| MCP list | German, Hindi | Inspected translated empty-state layout. |

This was representative visual testing, not an exhaustive screen-by-language matrix. Successful authentication, real messaging, connector execution, all error/file dialogs and Windows/Linux visuals were not exercised. The Japanese time field still exposes some Chromium-managed English accessibility labels (Hours, Minutes, Show time picker), outside the app's translation catalog.

## Validation

- Source-stage full desktop suite: 322 files, 2,826 tests passed.
- After visual fixes: 11 targeted files, 158 tests passed; final schedule-layout regression run: 3 files, 33 tests passed (overlapping checks, not additive totals).
- TypeScript build checking, locale synchronization, translation coverage and JSX localization guards passed.

## Intentional original-language content and remaining review

Executable bot-template mission/persona and routine prompt bodies remain in their original language to preserve instructions and approval semantics. Template selection labels/descriptions are localized. Existing bot names, user content, generated replies, terminal output, provider messages and third-party marketplace content are not automatically translated. OS/Chromium-owned controls can follow their own locale.

Native-speaker review is still needed to certify fluency and meaning. Broader authenticated runtime testing and a complete screen-by-language/platform matrix remain outside this representative pass. The JSON companion records the current coverage and validation scope.
