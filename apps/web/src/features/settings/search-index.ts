import { EXEC_BACKENDS } from "@abacus-ai/contract/exec-backends";
import { LOCAL_MODEL_CATALOG } from "@abacus-ai/contract/local-models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";

import { APP_ACTIONS } from "#renderer/lib/keyboard/actions";
import type { SettingsPageId } from "#renderer/lib/navigation/areas";
import { foldSearch } from "#renderer/lib/use-app-context";
export interface SettingEntry {
  id: string;
  page: SettingsPageId;
  labelKey: string;
  label?: string;
}
const labelKeys: Record<string, string> = {
  notchCompanion: "settings.general.notch.title",
  notchIdle: "settings.general.notch.idle",
  notchDisplays: "settings.general.notch.displays",
  notchHaptics: "settings.general.notch.haptics",
  notchShortcut: "settings.general.notch.shortcut",
  showInNotch: "settings.notifications.showInNotch.title",
  tour: "tour.replay",
  ...Object.fromEntries(
    ["AUTO", "DEFAULT", "ACCEPTEDITS", "PLAN", "YOLO"].map((id) => [
      `mode-${id}`,
      `chat.mode.${id}`,
    ])
  ),
  ...Object.fromEntries(
    EXEC_BACKENDS.map((backend) => [
      `backend-${backend.id}`,
      `execBackends.${backend.labelKey}.label`,
    ])
  ),
  ...Object.fromEntries(
    ["ios", "android", "maestro"].map((id) => [
      `device-${id}`,
      `phase5.deviceTools.${id}`,
    ])
  ),
  identity: "phase5.signOut",
  plan: "phase5.managePlan",
  credits: "phase5.credits",
  vault: "phase5.vault",
  organization: "phase5.settings.organization",
  inviteLink: "phase5.inviteLink",
  forgetAccount: "phase5.forgetComputer",
  abacusCredits: "phase5.credits",
  openrouterUsage: "phase5.openrouterBrand",
  weekUsage: "phase5.thisWeek",
  appVersion: "onboarding.welcomeTitle",
  updates: "phase5.settings.updates",
  logs: "phase5.saveLogs",
  changelog: "phase5.whatsNew",
  openSourceLicenses: "settings.licenses.title",
  appLicense: "settings.licenses.own",
  palette: "settings.theme.label",
  theme: "settings.appearance.mode",
  ...Object.fromEntries(
    [
      "accent",
      "contrast",
      "radius",
      "uiFont",
      "codeFont",
      "codeSize",
      "translucency",
      "railIconsOnly",
      "allowTwoTabRows",
      "importTheme",
    ].map((id) => [id, `settings.appearance.${id}`])
  ),
};
const groups: Partial<Record<SettingsPageId, string[]>> = {
  general: [
    "launchAtLogin",
    "notchCompanion",
    "notchIdle",
    "notchDisplays",
    "notchHaptics",
    "notchShortcut",
    "tour",
    "defaultWorkspace",
    "defaultMode",
    "botMode",
    "mode-AUTO",
    "mode-DEFAULT",
    "mode-ACCEPTEDITS",
    "mode-PLAN",
    "mode-YOLO",
  ],
  appearance: [
    "palette",
    "theme",
    "accent",
    "contrast",
    "radius",
    "density",
    "translucency",
    "railIconsOnly",
    "allowTwoTabRows",
    "textSize",
    "uiFont",
    "codeFont",
    "codeSize",
    "reduceMotion",
    "bubbleTint",
    "importTheme",
  ],
  notifications: ["notify", "sounds", "quietHours", "showInNotch"],
  memory: ["customInstructions"],
  language: ["language"],
  browser: [
    "browserEnabled",
    "browserEngine",
    "chromeExtension",
    "browserHomepage",
    "browserApproval",
    "browserData",
  ],
  devices: [
    "deviceEnabled",
    "deviceApproval",
    "device-ios",
    "device-android",
    "device-maestro",
  ],
  environment: [
    "sandbox",
    ...["local", "docker", "singularity", "modal", "daytona", "ssh"].map(
      (x) => `backend-${x}`
    ),
  ],
  account: [
    "identity",
    "plan",
    "credits",
    "vault",
    "organization",
    "inviteLink",
    "forgetAccount",
  ],
  usage: ["abacusCredits", "openrouterUsage", "weekUsage"],
  about: [
    "appVersion",
    "updates",
    "logs",
    "changelog",
    "openSourceLicenses",
    "appLicense",
  ],
};
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  ...Object.entries(groups).flatMap(([page, ids]) =>
    ids.map((id) => ({
      id,
      page: page as SettingsPageId,
      labelKey: labelKeys[id] ?? `phase5.settings.${id}`,
    }))
  ),
  ...PROVIDER_KEY_FIELDS.filter((p) => p.kind === "model").map((p) => ({
    id: `provider-${p.provider}`,
    page: "models" as const,
    labelKey: "",
    label: p.label,
  })),
  { id: "localModels", page: "models", labelKey: "phase5.onThisMachine" },
  {
    id: "terminalShell",
    page: "environment",
    labelKey: "phase5.terminalShell",
  },
  ...["sent", "received", "needs-you", "done", "failed", "routine-fired"].map(
    (cue) => ({
      id: `sound-${cue}`,
      page: "notifications" as const,
      labelKey: `phase5.cues.${cue}`,
    })
  ),
  ...["link", "gmail", "whatsapp"].map((channel) => ({
    id: `invite-${channel}`,
    page: "account" as const,
    labelKey: `phase5.inviteChannels.${channel}`,
  })),
  ...LOCAL_MODEL_CATALOG.map((m) => ({
    id: `local-${m.id}`,
    page: "models" as const,
    labelKey: "",
    label: m.label,
  })),
  ...APP_ACTIONS.filter((a) => a.terminalDefault?.windows !== undefined).map(
    (a) => ({
      id: `key-${a.id}@terminal`,
      page: "keyboard" as const,
      labelKey: a.labelKey,
    })
  ),
  ...APP_ACTIONS.map((a) => ({
    id: `key-${a.id}`,
    page: "keyboard" as const,
    labelKey: a.labelKey,
  })),
];
export const searchSettings = (
  query: string,
  t: (key: string) => string,
  entries: readonly SettingEntry[] = SETTINGS_INDEX
) =>
  entries.filter((row) =>
    foldSearch(
      `${row.label ?? t(row.labelKey)} ${t(`settings.pages.${row.page}`)}`
    ).includes(foldSearch(query))
  );

export const settingsIndexFor = (
  electron: boolean,
  uiOS: "mac" | "windows" | "linux"
) =>
  SETTINGS_INDEX.filter(
    (entry) =>
      (electron ||
        (!["browser", "devices"].includes(entry.page) &&
          (entry.page !== "about" ||
            ["openSourceLicenses", "appLicense"].includes(entry.id)) &&
          !/^(notch|local-|localModels|launchAtLogin|showInNotch|density|translucency|tour|key-notch|invite-whatsapp)/.test(
            entry.id
          ))) &&
      (uiOS !== "mac" || !entry.id.endsWith("@terminal")) &&
      (uiOS !== "linux" || entry.id !== "translucency")
  ).map((entry) =>
    !electron && ["backend-local", "forgetAccount"].includes(entry.id)
      ? {
          ...entry,
          labelKey:
            entry.id === "backend-local"
              ? "web.hostLabel"
              : "web.forgetAccount",
        }
      : entry
  );
