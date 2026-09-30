import { APP_ACTIONS } from "#next/lib/keyboard/actions";
import type { SettingsPageId } from "#next/lib/navigation/areas";
import { foldSearch } from "#next/lib/use-app-context";
import { LOCAL_MODEL_CATALOG } from "#shared/local-models";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";
export interface SettingEntry {
  id: string;
  page: SettingsPageId;
  labelKey: string;
  label?: string;
}
const groups: Partial<Record<SettingsPageId, string[]>> = {
  general: [
    "launchAtLogin",
    "defaultWorkspace",
    "defaultMode",
    "botMode",
    "mode-AUTO",
    "mode-DEFAULT",
    "mode-ACCEPTEDITS",
    "mode-PLAN",
    "mode-YOLO",
  ],
  appearance: ["theme", "density", "textSize", "reduceMotion", "bubbleTint"],
  notifications: ["notify", "sounds", "quietHours"],
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
    "organization",
    "inviteLink",
    "forgetAccount",
  ],
  usage: ["abacusCredits", "openrouterUsage", "weekUsage"],
  about: ["appVersion", "updates", "logs"],
};
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  ...Object.entries(groups).flatMap(([page, ids]) =>
    ids.map((id) => ({
      id,
      page: page as SettingsPageId,
      labelKey: `phase5.settings.${id}`,
    }))
  ),
  ...PROVIDER_KEY_FIELDS.filter((p) => p.kind === "model").map((p) => ({
    id: `provider-${p.provider}`,
    page: "models" as const,
    labelKey: "",
    label: p.label,
  })),
  { id: "localModels", page: "models", labelKey: "phase5.onThisMachine" },
  ...LOCAL_MODEL_CATALOG.map((m) => ({
    id: `local-${m.id}`,
    page: "models" as const,
    labelKey: "",
    label: m.label,
  })),
  ...APP_ACTIONS.map((a) => ({
    id: `key-${a.id}`,
    page: "keyboard" as const,
    labelKey: a.labelKey,
  })),
];
export const searchSettings = (query: string, t: (key: string) => string) =>
  SETTINGS_INDEX.filter((row) =>
    foldSearch(
      `${row.label ?? t(row.labelKey)} ${t(`settings.pages.${row.page}`)}`
    ).includes(foldSearch(query))
  );
