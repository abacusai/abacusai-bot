# UI consistency audit

Baseline: origin/main at `07a79330`, changes since 2026-10-06. One focused pass; behavior and security disclosures remain unchanged. Source inventory includes every changed renderer TSX/CSS file below; the companion main-process changes are mostly service and browser behavior, not owned UI.

## Ranked findings

| Rank | Screen | Inconsistency | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | Web startup, failure, capacity, refusal | Custom 48px pill actions, mixed 26/15px type, plain action links/buttons, custom checklist/progress, wake pill bypasses floating tokens | High | Before capture pending |
| 2 | WhatsApp first-run and phone connect | Hand-written modal, per-screen button/input dimensions and radii, color-specific message preview | High | Before capture pending |
| 3 | Hosted routines, unattended mode | Runtime capabilities and availability need live-host coverage; avoid changing authorization | Medium | Source review pending |
| 4 | Connector consent, vault and payment approval | Service-hosted pages are outside renderer ownership; locate provider implementation before proposing restyling | High | Ownership review pending |
| 5 | Sessions, browser tabs, composer, bots, onboarding | Recent shared-control/titlebar/page-spacing changes provide the reference language | Low | Visual inventory pending |
| 6 | Notices, licenses, library and settings | Shared page spacing already applied; check narrow controls and loading/error states | Low | Visual inventory pending |

## Changed UI inventory

### apps/web/src/components/app-icon

- `apps/web/src/components/app-icon/index.tsx`

### apps/web/src/components/bot-avatar

- `apps/web/src/components/bot-avatar/index.tsx`
- `apps/web/src/components/bot-avatar/moods.css`

### apps/web/src/components/bot-tab-avatar

- `apps/web/src/components/bot-tab-avatar/index.tsx`

### apps/web/src/components/browser-surface

- `apps/web/src/components/browser-surface/index.tsx`

### apps/web/src/components/command-palette-action

- `apps/web/src/components/command-palette-action/index.tsx`

### apps/web/src/components/connector-mark

- `apps/web/src/components/connector-mark/index.tsx`

### apps/web/src/components/connector-request-card

- `apps/web/src/components/connector-request-card/index.tsx`

### apps/web/src/components/diff-view

- `apps/web/src/components/diff-view/index.tsx`

### apps/web/src/components/file-tree

- `apps/web/src/components/file-tree/index.tsx`

### apps/web/src/components/form-kit

- `apps/web/src/components/form-kit/controls.tsx`
- `apps/web/src/components/form-kit/page.tsx`

### apps/web/src/components/message-feedback

- `apps/web/src/components/message-feedback/index.tsx`

### apps/web/src/components/notch-controls.tsx

- `apps/web/src/components/notch-controls.tsx`

### apps/web/src/components/page-state.tsx

- `apps/web/src/components/page-state.tsx`

### apps/web/src/components/panel-workspace

- `apps/web/src/components/panel-workspace/index.tsx`
- `apps/web/src/components/panel-workspace/resize-handle.tsx`
- `apps/web/src/components/panel-workspace/title-region.tsx`

### apps/web/src/components/route-sheet

- `apps/web/src/components/route-sheet/index.tsx`

### apps/web/src/components/tabs-rail

- `apps/web/src/components/tabs-rail/index.tsx`
- `apps/web/src/components/tabs-rail/placement.tsx`
- `apps/web/src/components/tabs-rail/tab-label.tsx`

### apps/web/src/components/title-bar

- `apps/web/src/components/title-bar/index.tsx`

### apps/web/src/features/artifacts/index.tsx

- `apps/web/src/features/artifacts/index.tsx`

### apps/web/src/features/bots/avatar.tsx

- `apps/web/src/features/bots/avatar.tsx`

### apps/web/src/features/bots/bots.css

- `apps/web/src/features/bots/bots.css`

### apps/web/src/features/bots/chat

- `apps/web/src/features/bots/chat/decorations.tsx`
- `apps/web/src/features/bots/chat/feedback.tsx`
- `apps/web/src/features/bots/chat/identity.tsx`
- `apps/web/src/features/bots/chat/slots.tsx`

### apps/web/src/features/bots/form

- `apps/web/src/features/bots/form/bot-form.tsx`
- `apps/web/src/features/bots/form/look-picker.tsx`

### apps/web/src/features/bots/gallery

- `apps/web/src/features/bots/gallery/avatars.tsx`
- `apps/web/src/features/bots/gallery/sections.tsx`

### apps/web/src/features/bots/model

- `apps/web/src/features/bots/model/picker.tsx`

### apps/web/src/features/bots/panel

- `apps/web/src/features/bots/panel/bot-side-panel.tsx`
- `apps/web/src/features/bots/panel/wallpaper-picker.tsx`

### apps/web/src/features/bots/sidebar

- `apps/web/src/features/bots/sidebar/bots-sidebar.tsx`

### apps/web/src/features/bots/start

- `apps/web/src/features/bots/start/bot-start-page.tsx`

### apps/web/src/features/chat/chat.css

- `apps/web/src/features/chat/chat.css`

### apps/web/src/features/chat/composer

- `apps/web/src/features/chat/composer/chips.tsx`
- `apps/web/src/features/chat/composer/composer.tsx`
- `apps/web/src/features/chat/composer/start-composer.tsx`

### apps/web/src/features/chat/gallery

- `apps/web/src/features/chat/gallery/sections.tsx`

### apps/web/src/features/chat/kit

- `apps/web/src/features/chat/kit/context.tsx`
- `apps/web/src/features/chat/kit/layout.tsx`
- `apps/web/src/features/chat/kit/message-actions.tsx`
- `apps/web/src/features/chat/kit/message.tsx`
- `apps/web/src/features/chat/kit/parts.tsx`
- `apps/web/src/features/chat/kit/permissions/notch-list.tsx`
- `apps/web/src/features/chat/kit/queue-slot.tsx`
- `apps/web/src/features/chat/kit/reply.tsx`
- `apps/web/src/features/chat/kit/status/status.tsx`
- `apps/web/src/features/chat/kit/view.tsx`

### apps/web/src/features/chat/markdown

- `apps/web/src/features/chat/markdown/markdown.tsx`

### apps/web/src/features/chat/scroller

- `apps/web/src/features/chat/scroller/transcript.tsx`

### apps/web/src/features/chat/testing.tsx

- `apps/web/src/features/chat/testing.tsx`

### apps/web/src/features/gallery/gallery.tsx

- `apps/web/src/features/gallery/gallery.tsx`

### apps/web/src/features/library/connectors.tsx

- `apps/web/src/features/library/connectors.tsx`

### apps/web/src/features/library/globals.tsx

- `apps/web/src/features/library/globals.tsx`

### apps/web/src/features/library/index.tsx

- `apps/web/src/features/library/index.tsx`

### apps/web/src/features/library/mcp.tsx

- `apps/web/src/features/library/mcp.tsx`

### apps/web/src/features/library/messaging.tsx

- `apps/web/src/features/library/messaging.tsx`

### apps/web/src/features/library/skills-tools.tsx

- `apps/web/src/features/library/skills-tools.tsx`

### apps/web/src/features/library/whatsapp-phone.tsx

- `apps/web/src/features/library/whatsapp-phone.tsx`

### apps/web/src/features/notch/controls.tsx

- `apps/web/src/features/notch/controls.tsx`

### apps/web/src/features/notch/frame.tsx

- `apps/web/src/features/notch/frame.tsx`

### apps/web/src/features/notch/gallery.tsx

- `apps/web/src/features/notch/gallery.tsx`

### apps/web/src/features/notch/idle.tsx

- `apps/web/src/features/notch/idle.tsx`

### apps/web/src/features/notch/index.tsx

- `apps/web/src/features/notch/index.tsx`

### apps/web/src/features/notch/listening.tsx

- `apps/web/src/features/notch/listening.tsx`

### apps/web/src/features/notch/notch.css

- `apps/web/src/features/notch/notch.css`

### apps/web/src/features/onboarding/confetti.tsx

- `apps/web/src/features/onboarding/confetti.tsx`

### apps/web/src/features/onboarding/frame.tsx

- `apps/web/src/features/onboarding/frame.tsx`

### apps/web/src/features/onboarding/gallery.tsx

- `apps/web/src/features/onboarding/gallery.tsx`

### apps/web/src/features/onboarding/hatch.tsx

- `apps/web/src/features/onboarding/hatch.tsx`

### apps/web/src/features/onboarding/index.tsx

- `apps/web/src/features/onboarding/index.tsx`

### apps/web/src/features/onboarding/onboarding.css

- `apps/web/src/features/onboarding/onboarding.css`

### apps/web/src/features/onboarding/pairing-banner.tsx

- `apps/web/src/features/onboarding/pairing-banner.tsx`

### apps/web/src/features/onboarding/stage.tsx

- `apps/web/src/features/onboarding/stage.tsx`

### apps/web/src/features/onboarding/steps

- `apps/web/src/features/onboarding/steps/connect.tsx`
- `apps/web/src/features/onboarding/steps/connected.tsx`
- `apps/web/src/features/onboarding/steps/connectors.tsx`
- `apps/web/src/features/onboarding/steps/done.tsx`
- `apps/web/src/features/onboarding/steps/first-bot.tsx`
- `apps/web/src/features/onboarding/steps/kit.tsx`
- `apps/web/src/features/onboarding/steps/local-models.tsx`
- `apps/web/src/features/onboarding/steps/models.tsx`
- `apps/web/src/features/onboarding/steps/provider-key.tsx`
- `apps/web/src/features/onboarding/steps/welcome.tsx`

### apps/web/src/features/onboarding/whatsapp.tsx

- `apps/web/src/features/onboarding/whatsapp.tsx`

### apps/web/src/features/routines/form.tsx

- `apps/web/src/features/routines/form.tsx`

### apps/web/src/features/routines/globals.tsx

- `apps/web/src/features/routines/globals.tsx`

### apps/web/src/features/routines/page.tsx

- `apps/web/src/features/routines/page.tsx`

### apps/web/src/features/routines/row.tsx

- `apps/web/src/features/routines/row.tsx`

### apps/web/src/features/routines/run-requests.tsx

- `apps/web/src/features/routines/run-requests.tsx`

### apps/web/src/features/routines/sidebar.tsx

- `apps/web/src/features/routines/sidebar.tsx`

### apps/web/src/features/sessions/browser

- `apps/web/src/features/sessions/browser/ask-host.tsx`
- `apps/web/src/features/sessions/browser/browser-tab.tsx`

### apps/web/src/features/sessions/changes

- `apps/web/src/features/sessions/changes/changes-tab.tsx`

### apps/web/src/features/sessions/context

- `apps/web/src/features/sessions/context/context-tray.tsx`

### apps/web/src/features/sessions/device

- `apps/web/src/features/sessions/device/device-tab.tsx`

### apps/web/src/features/sessions/dock

- `apps/web/src/features/sessions/dock/session-dock.tsx`

### apps/web/src/features/sessions/files

- `apps/web/src/features/sessions/files/files-tab.tsx`

### apps/web/src/features/sessions/gallery

- `apps/web/src/features/sessions/gallery/sections.tsx`

### apps/web/src/features/sessions/globals.tsx

- `apps/web/src/features/sessions/globals.tsx`

### apps/web/src/features/sessions/session-workspace.tsx

- `apps/web/src/features/sessions/session-workspace.tsx`

### apps/web/src/features/sessions/sessions-sidebar.tsx

- `apps/web/src/features/sessions/sessions-sidebar.tsx`

### apps/web/src/features/sessions/start

- `apps/web/src/features/sessions/start/session-start-page.tsx`

### apps/web/src/features/sessions/terminal

- `apps/web/src/features/sessions/terminal/terminal-tab.tsx`

### apps/web/src/features/settings/appearance.tsx

- `apps/web/src/features/settings/appearance.tsx`

### apps/web/src/features/settings/environment.tsx

- `apps/web/src/features/settings/environment.tsx`

### apps/web/src/features/settings/index.tsx

- `apps/web/src/features/settings/index.tsx`

### apps/web/src/features/settings/license-section.tsx

- `apps/web/src/features/settings/license-section.tsx`

### apps/web/src/features/settings/licenses.tsx

- `apps/web/src/features/settings/licenses.tsx`

### apps/web/src/features/settings/models.tsx

- `apps/web/src/features/settings/models.tsx`

### apps/web/src/features/settings/personal.tsx

- `apps/web/src/features/settings/personal.tsx`

### apps/web/src/features/settings/updates.tsx

- `apps/web/src/features/settings/updates.tsx`

### apps/web/src/features/shell/app-root.tsx

- `apps/web/src/features/shell/app-root.tsx`

### apps/web/src/features/shell/browser-open.tsx

- `apps/web/src/features/shell/browser-open.tsx`

### apps/web/src/features/shell/command-menu.tsx

- `apps/web/src/features/shell/command-menu.tsx`

### apps/web/src/features/shell/connect

- `apps/web/src/features/shell/connect/index.tsx`

### apps/web/src/features/shell/credits-card.tsx

- `apps/web/src/features/shell/credits-card.tsx`

### apps/web/src/features/shell/hotkeys.tsx

- `apps/web/src/features/shell/hotkeys.tsx`

### apps/web/src/features/shell/notification-clicks.tsx

- `apps/web/src/features/shell/notification-clicks.tsx`

### apps/web/src/features/shell/promo-character.tsx

- `apps/web/src/features/shell/promo-character.tsx`

### apps/web/src/features/shell/promo-host.tsx

- `apps/web/src/features/shell/promo-host.tsx`

### apps/web/src/features/shell/rail.tsx

- `apps/web/src/features/shell/rail.tsx`

### apps/web/src/features/shell/shell-layout.tsx

- `apps/web/src/features/shell/shell-layout.tsx`

### apps/web/src/features/shell/side-panel-slot.tsx

- `apps/web/src/features/shell/side-panel-slot.tsx`

### apps/web/src/features/shell/side-panel.tsx

- `apps/web/src/features/shell/side-panel.tsx`

### apps/web/src/features/shell/sidebar-slot.tsx

- `apps/web/src/features/shell/sidebar-slot.tsx`

### apps/web/src/features/shell/top-bar-slots.tsx

- `apps/web/src/features/shell/top-bar-slots.tsx`

### apps/web/src/features/shell/top-bar.tsx

- `apps/web/src/features/shell/top-bar.tsx`

### apps/web/src/features/tour/index.tsx

- `apps/web/src/features/tour/index.tsx`

### apps/web/src/lib/attention

- `apps/web/src/lib/attention/open-target.tsx`

### apps/web/src/lib/chat-appearance.css

- `apps/web/src/lib/chat-appearance.css`

### apps/web/src/lib/chrome-state.tsx

- `apps/web/src/lib/chrome-state.tsx`

### apps/web/src/lib/navigation

- `apps/web/src/lib/navigation/app-link.tsx`

### apps/web/src/lib/theme-effect.tsx

- `apps/web/src/lib/theme-effect.tsx`

### apps/web/src/main.tsx

- `apps/web/src/main.tsx`

### apps/web/src/notch-routes/__root.tsx

- `apps/web/src/notch-routes/__root.tsx`

### apps/web/src/platform/about.browser.tsx

- `apps/web/src/platform/about.browser.tsx`

### apps/web/src/platform/connect.browser.tsx

- `apps/web/src/platform/connect.browser.tsx`

### apps/web/src/platform/whatsapp-bot.browser.tsx

- `apps/web/src/platform/whatsapp-bot.browser.tsx`

### apps/web/src/platform/whatsapp-bot.electron.tsx

- `apps/web/src/platform/whatsapp-bot.electron.tsx`

### apps/web/src/platform/whatsapp-phone.browser.tsx

- `apps/web/src/platform/whatsapp-phone.browser.tsx`

### apps/web/src/router.tsx

- `apps/web/src/router.tsx`

### apps/web/src/routes/__root.tsx

- `apps/web/src/routes/__root.tsx`

### apps/web/src/routes/_bare

- `apps/web/src/routes/_bare/[__ui].tsx`
- `apps/web/src/routes/_bare/onboarding.$step.tsx`

### apps/web/src/routes/_shell.tsx

- `apps/web/src/routes/_shell.tsx`

### apps/web/src/routes/_shell

- `apps/web/src/routes/_shell/(bots)/-browser.tsx`
- `apps/web/src/routes/_shell/(bots)/bots.$botId.tsx`
- `apps/web/src/routes/_shell/(bots)/bots.$botId_.chats.$sessionId.tsx`
- `apps/web/src/routes/_shell/(bots)/bots.$botId_.edit.tsx`
- `apps/web/src/routes/_shell/(sessions)/sessions.$sessionId.tsx`
- `apps/web/src/routes/_shell/(sessions)/sessions.tsx`
- `apps/web/src/routes/_shell/settings.about.tsx`
- `apps/web/src/routes/_shell/settings.appearance.tsx`
- `apps/web/src/routes/_shell/settings.models.tsx`

### apps/web/src/styles/app.css

- `apps/web/src/styles/app.css`

### apps/web/src/styles/tokens.css

- `apps/web/src/styles/tokens.css`

### apps/web/src/test-support/app-harness.tsx

- `apps/web/src/test-support/app-harness.tsx`

### apps/web/src/test-support/notch-fit.tsx

- `apps/web/src/test-support/notch-fit.tsx`

### apps/web/src/ui/dropdown-menu.tsx

- `apps/web/src/ui/dropdown-menu.tsx`

