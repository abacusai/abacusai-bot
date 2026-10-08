# UI consistency audit

Reviewed changes since 2026-10-06 on `origin/main`. Initial baseline `07a79330`; refreshed through `ddd41395` after routines and vault settings landed. The rewritten root is `12831a743d4c8c5bd9f4b81a4e253a32eede191f`.

The source inventory covers all changed renderer TSX/CSS files, grouped below. Main-process changes were reviewed for UI ownership: browser snapshots, connector/vault/payment services and phone tools do not own the platform's approval pages. A source review is not a live provider-page audit.

| Rank | Area and origin | Finding | Severity | Outcome |
| --- | --- | --- | --- | --- |
| 1 | Web startup, #212/#217, sreemanti-abacusai | Per-screen 48px pill controls, mixed title/body scale, raw refusal actions, custom progress markup and wake pill outside floating tokens | High | Fixed with FlowPage/FlowHeader, Base UI buttons, named native progress, semantic status ink and floating tokens |
| 2 | WhatsApp phone/first-run, #181/#198, sreemanti-abacusai | Role-only modal without portal/focus isolation; bespoke control heights/radii, manual field label and green-only preview | High | Fixed with shared flow composition, Dialog, Field/FieldLabel, Input and semantic preview colors; explicit linking/Skip dismissal preserved |
| 3 | Hosted routines and unattended access, #271, sreemanti-abacusai | Ad-hoc reach notices, non-wrapping access row, custom result rows/status styling and blank loading state | Medium | Fixed with Item/ItemGroup, Badge, Empty and Skeleton; confirmation steps, copy, callbacks, read markers and ordering retained |
| 4 | Connector consent, vault, login/payment approvals, #213/#217/#253/#257 | Provider-owned pages are linked by this repo, not implemented here | High | Backlog: inspect platform implementation in its owning repo with a disposable account; no security flow changed |
| 5 | Standalone startup avatars, #212 + avatar rig #221 | Animated BotAvatar reads DB prefs before the full boot installs DbProvider | High | Existing boot-context issue; capture fixture supplies DbProvider. Keep separate from this presentation-only pass |
| 6 | Routine create/edit form, #271 | Custom modal radius/padding; crowded capability controls need a narrow-width pass | Medium | Backlog. Existing Base UI/TanStack Form, confirmation and runner selection remain unchanged |
| 7 | Browser messaging link sheet, #169/#172 | Separate larger mobile control treatment remains in the older link-code flow | Medium | Backlog. The bot-number first-run and phone flow are fixed here |
| 8 | Bots, Sessions, titlebar, composer, palette, #221/#223/#226/#231/#239/#266 | Shared avatar, controls and titlebar rules provide the reference; native gaps and dock behavior are already normalized | Low | Retained. Gallery captures cover these compositions; live browser content and remote devices are not connected |
| 9 | Settings, Library, artifacts, notices/licenses, #224/#233/#243/#253 | Shared page/row layout is already applied; account-linked and large/long provider data need live coverage | Low | Retained. Capture fixtures cover available pages, including notices and license sections |
| 10 | Companion and native material, #210/#239 | Platform-specific appearance cannot be proven on this Mac | Medium | Backlog: Windows/Linux material fallback, focus, narrow heights and translated labels |

## Capture and verification scope

- Disposable home/userdata under `/tmp/abacus-ui-pass`; no API key. Desktop dev uses CDP 9611 and Vite 9612. No personal profile or real provider data was copied.
- Before/after matrices for fixed views use 640, 900, 1280, 1710 and 2560px at 900px height, requesting light and dark. The standalone capture fixture paints both palettes to check tokens, bypassing the document theme effect. Setup/failure retain their production light-only scope; a separate CDP check exercises that scope with ThemeEffect mounted. Phone boot's existing light-only policy remains.
- Fixed screens: 170 before + 170 after captures, attached as 34 paired contact sheets. The broader inventory has 360 valid gallery captures and 180 additional settings/library captures. PNGs and capture fixtures stay outside git.
- Validation: all 15 workspace typecheck tasks, oxlint, knip, i18n/locales and 129 focused Vitest tests pass. Touched formatting passes; full oxfmt reports two unchanged main failures in `mcp-agent-tools-server.ts` and `browser-task-tool.test.ts`, reproduced against origin/main blobs. CDP confirms setup/failure light scopes, capacity dark, intro Tab containment, Escape preservation and Skip dismissal.
- Net diff against the rebased main: 168 added code/test/CSS lines, including 60 lines for the shared flow layout and 49 for its tests/guards; audit documentation is separate. This pass has no net line removal.
- The startup/WhatsApp captures mount the real components with dummy queries and a fixture DbProvider. The additional gallery captures mount real settings/routine components in the app's gallery context. They do not certify server authorization, a live hosted runner, payment checkout, provider sign-in or a remote device.
- Dev startup on main requires the user's separate CSP/Fast Refresh fix. CDP supplies the preamble for this isolated run; that change is not part of this PR. A fresh worktree also requires building the updater before desktop dev resolves its provenance export.

## Changed UI files by area

Each filename below is relative to its area. Layouts, helpers and browser/desktop variants are grouped with the screen they support. Tests, locales, generated data and non-rendering TypeScript service files are excluded from this rendered-file list.

| Area | Changed UI files | Audit result |
| --- | --- | --- |
| `apps/web/src/components` | `app-icon/index.tsx`, `bot-avatar/index.tsx`, `bot-avatar/moods.css`, `bot-tab-avatar/index.tsx`, `browser-surface/index.tsx`, `command-palette-action/index.tsx`, `connector-mark/index.tsx`, `connector-request-card/index.tsx`, `diff-view/index.tsx`, `file-tree/index.tsx`, `form-kit/controls.tsx`, `form-kit/page.tsx`, `message-feedback/index.tsx`, `notch-controls.tsx`, `page-state.tsx`, `panel-workspace/index.tsx`, `panel-workspace/resize-handle.tsx`, `panel-workspace/title-region.tsx`, `route-sheet/index.tsx`, `tabs-rail/index.tsx`, `tabs-rail/placement.tsx`, `tabs-rail/tab-label.tsx`, `title-bar/index.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/artifacts` | `index.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/bots` | `avatar.tsx`, `bots.css`, `chat/decorations.tsx`, `chat/feedback.tsx`, `chat/identity.tsx`, `chat/slots.tsx`, `form/bot-form.tsx`, `form/look-picker.tsx`, `gallery/avatars.tsx`, `gallery/sections.tsx`, `model/picker.tsx`, `panel/bot-side-panel.tsx`, `panel/wallpaper-picker.tsx`, `sidebar/bots-sidebar.tsx`, `start/bot-start-page.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/chat` | `chat.css`, `composer/chips.tsx`, `composer/composer.tsx`, `composer/start-composer.tsx`, `gallery/sections.tsx`, `kit/context.tsx`, `kit/layout.tsx`, `kit/message-actions.tsx`, `kit/message.tsx`, `kit/parts.tsx`, `kit/permissions/notch-list.tsx`, `kit/queue-slot.tsx`, `kit/reply.tsx`, `kit/status/status.tsx`, `kit/view.tsx`, `markdown/markdown.tsx`, `scroller/transcript.tsx`, `testing.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/gallery` | `gallery.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/library` | `connectors.tsx`, `globals.tsx`, `index.tsx`, `mcp.tsx`, `messaging.tsx`, `skills-tools.tsx`, `whatsapp-phone.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/notch` | `controls.tsx`, `frame.tsx`, `gallery.tsx`, `idle.tsx`, `index.tsx`, `listening.tsx`, `notch.css` | Reference / backlog as ranked above |
| `apps/web/src/features/onboarding` | `confetti.tsx`, `frame.tsx`, `gallery.tsx`, `hatch.tsx`, `index.tsx`, `onboarding.css`, `pairing-banner.tsx`, `stage.tsx`, `steps/connect.tsx`, `steps/connected.tsx`, `steps/connectors.tsx`, `steps/done.tsx`, `steps/first-bot.tsx`, `steps/kit.tsx`, `steps/local-models.tsx`, `steps/models.tsx`, `steps/provider-key.tsx`, `steps/welcome.tsx`, `whatsapp.tsx` | Fixed / remaining details ranked above |
| `apps/web/src/features/routines` | `form.tsx`, `globals.tsx`, `hosted-results.tsx`, `page.tsx`, `reach-panel.tsx`, `row.tsx`, `run-requests.tsx`, `sidebar.tsx` | Fixed / remaining details ranked above |
| `apps/web/src/features/sessions` | `browser/ask-host.tsx`, `browser/browser-tab.tsx`, `changes/changes-tab.tsx`, `context/context-tray.tsx`, `device/device-tab.tsx`, `dock/session-dock.tsx`, `files/files-tab.tsx`, `gallery/sections.tsx`, `globals.tsx`, `session-workspace.tsx`, `sessions-sidebar.tsx`, `start/session-start-page.tsx`, `terminal/terminal-tab.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/settings` | `account-usage.tsx`, `appearance.tsx`, `environment.tsx`, `index.tsx`, `license-section.tsx`, `licenses.tsx`, `models.tsx`, `personal.tsx`, `updates.tsx` | Reference / backlog as ranked above |
| `apps/web/src/features/shell` | `app-root.tsx`, `browser-open.tsx`, `command-menu.tsx`, `connect/index.tsx`, `credits-card.tsx`, `hotkeys.tsx`, `notification-clicks.tsx`, `promo-character.tsx`, `promo-host.tsx`, `rail.tsx`, `shell-layout.tsx`, `side-panel-slot.tsx`, `side-panel.tsx`, `sidebar-slot.tsx`, `top-bar-slots.tsx`, `top-bar.tsx` | Fixed / remaining details ranked above |
| `apps/web/src/features/tour` | `index.tsx` | Reference / backlog as ranked above |
| `apps/web/src/lib` | `attention/open-target.tsx`, `chat-appearance.css`, `chrome-state.tsx`, `navigation/app-link.tsx`, `theme-effect.tsx` | Reference / backlog as ranked above |
| `apps/web/src/main.tsx` | `apps/web/src/main.tsx` | Reference / backlog as ranked above |
| `apps/web/src/notch-routes` | `__root.tsx` | Reference / backlog as ranked above |
| `apps/web/src/platform` | `about.browser.tsx`, `connect.browser.tsx`, `whatsapp-bot.browser.tsx`, `whatsapp-bot.electron.tsx`, `whatsapp-phone.browser.tsx` | Reference / backlog as ranked above |
| `apps/web/src/router.tsx` | `apps/web/src/router.tsx` | Reference / backlog as ranked above |
| `apps/web/src/routes` | `__root.tsx`, `_bare/[__ui].tsx`, `_bare/onboarding.$step.tsx`, `_shell.tsx`, `_shell/(bots)/-browser.tsx`, `_shell/(bots)/bots.$botId.tsx`, `_shell/(bots)/bots.$botId_.chats.$sessionId.tsx`, `_shell/(bots)/bots.$botId_.edit.tsx`, `_shell/(sessions)/sessions.$sessionId.tsx`, `_shell/(sessions)/sessions.tsx`, `_shell/settings.about.tsx`, `_shell/settings.appearance.tsx`, `_shell/settings.models.tsx` | Reference / backlog as ranked above |
| `apps/web/src/styles` | `app.css`, `tokens.css` | Reference / backlog as ranked above |
| `apps/web/src/test-support` | `app-harness.tsx`, `notch-fit.tsx` | Reference / backlog as ranked above |
| `apps/web/src/ui` | `dropdown-menu.tsx` | Reference / backlog as ranked above |

Inventory: 640 changed source/test/data paths; 169 rendered UI files. Retrieve the complete path and commit attribution list with `git log --since=2026-10-06 --no-merges --name-only origin/main -- apps/web/src apps/desktop/src`.
