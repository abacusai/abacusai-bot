/** Finite translation families resolved from runtime enums and catalogues. */
export const DYNAMIC_KEYS = [
  {
    pattern: "bots.avatar.accessories.*",
    sources: ["features/bots/form/look-picker.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.avatar.colors.*",
    sources: ["features/bots/form/look-picker.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.avatar.shapes.*",
    sources: [
      "features/bots/form/look-picker.tsx",
      "features/bots/gallery/sections.tsx",
      "features/bots/start/bot-start-page.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.checkIn.*",
    sources: [
      "features/bots/panel/bot-side-panel.tsx",
      "features/bots/check-in/fields.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.start.categories.*",
    sources: ["features/bots/start/bot-start-page.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.status.*",
    sources: ["features/bots/chat/identity.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.templates.*.description",
    sources: ["features/bots/start/bot-start-page.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "bots.templates.*.name",
    sources: [
      "features/bots/start/bot-start-page.tsx",
      "routes/_shell/(bots)/bots.new.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "capabilities.toolDescriptions.*",
    sources: ["features/library/skills-tools.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "capabilities.toolsets.*",
    sources: [
      "features/library/skills-tools.tsx",
      "routes/_shell/(library)/library.tools.$toolsetId.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "chat.mode.*",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "chat.permission.action.*",
    sources: ["features/chat/kit/permissions/permission-card.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "chat.permission.chip.*",
    sources: ["features/chat/kit/permissions/permission-list.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "chat.permission.title.*",
    sources: [
      "features/chat/kit/layout.tsx",
      "features/chat/kit/permissions/permission-card.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "chat.permission.verb.*",
    sources: ["features/chat/kit/permissions/permission-card.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "execBackends.*.label",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "library.pages.*",
    sources: ["features/library/index.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "messaging.fields.*",
    sources: ["features/library/messaging.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "messaging.platforms.*",
    sources: ["features/library/index.tsx", "features/library/messaging.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "messaging.states.*",
    sources: ["features/library/messaging.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "onboardingFlow.steps.*",
    sources: ["features/onboarding/index.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.always",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.ask",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.backendBlockers.*",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.botSounds.*",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.categories.*",
    sources: ["features/library/connectors.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.comfortable",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.compact",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.cues.*",
    sources: [
      "features/settings/personal.tsx",
      "components/sound-preview/index.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.deviceTools.*",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.end",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.formats.*",
    sources: ["features/artifacts/index.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.imports.*",
    sources: ["features/library/mcp.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.inviteChannels.*",
    sources: [
      "features/settings/invite.tsx",
      "features/settings/account-usage.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.mcpFields.*",
    sources: ["features/library/mcp.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.memoryTargets.*",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.modeDescriptions.*",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.never",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.off",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.on",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.open.*",
    sources: ["features/artifacts/index.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.outcomes.*",
    sources: ["features/routines/page.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.presets.*",
    sources: ["features/routines/form.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.schedule.*",
    sources: ["features/routines/data.ts"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.skillImport.*",
    sources: ["features/library/skills-tools.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.sorts.*",
    sources: ["features/artifacts/index.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.start",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.states.*",
    sources: ["features/routines/sidebar.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.system",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.updates.*",
    sources: ["features/settings/updates.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.validation.*",
    sources: ["components/form-kit/index.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "referrals.errors.*",
    sources: ["features/settings/invite.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "routines.templates.*.name",
    sources: ["features/routines/form.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "settings.keyboard.actions.*",
    sources: ["lib/keyboard/actions.ts"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "settings.pages.*",
    sources: [
      "features/settings/index.tsx",
      "features/settings/search-index.ts",
      "features/shell/command-menu.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "shell.panel.tabs.*",
    sources: ["features/shell/side-panel.tsx", "features/shell/top-bar.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "shell.rail.*",
    sources: [
      "features/shell/rail.tsx",
      "features/shell/command-menu.tsx",
      "features/gallery/gallery.tsx",
    ],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "terminalShells.*.label",
    sources: ["features/settings/environment.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "theme.*",
    sources: ["features/settings/personal.tsx"],
    reason: "Runtime enum or catalogue key at these translation calls.",
  },
  {
    pattern: "phase5.settings.launchAtLogin",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.defaultWorkspace",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.defaultMode",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.botMode",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.mode-AUTO",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.mode-DEFAULT",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.mode-ACCEPTEDITS",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.mode-PLAN",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.mode-YOLO",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.theme",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.density",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.textSize",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.reduceMotion",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.bubbleTint",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.notify",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.sounds",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.quietHours",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.customInstructions",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.language",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.browserEnabled",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.browserEngine",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.chromeExtension",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.browserHomepage",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.browserApproval",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.browserData",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.deviceEnabled",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.deviceApproval",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.device-ios",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.device-android",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.device-maestro",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.sandbox",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.identity",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.plan",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.credits",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.organization",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.inviteLink",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.forgetAccount",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.abacusCredits",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.openrouterUsage",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.weekUsage",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.appVersion",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.updates",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.logs",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
  {
    pattern: "phase5.settings.changelog",
    sources: ["features/settings/search-index.ts"],
    reason: "Static Settings search group ID.",
  },
] as const;
