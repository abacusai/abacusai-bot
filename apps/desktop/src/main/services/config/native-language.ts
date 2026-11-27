/**
 * The app's language in the main process: the same resolution as the
 * renderer's (contract/languages.ts), from the OS's preferred languages, so
 * the native menus and dialogs, the UI and the agent's reply fallback agree.
 * Native words come from the app's locale files (`native.*`).
 */
import {
  type AppLanguage,
  resolveAppLanguage,
} from "@abacus-ai/contract/contract/languages";
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { app } from "electron";

import { channelWords, loadedWords } from "../messaging/channel-words";

/** The OS's preferred languages, then Electron's locale, without repeats. */
export const osLanguages = (): string[] => [
  ...new Set(
    [...app.getPreferredSystemLanguages(), app.getLocale()].filter(
      (tag) => tag.trim().length > 0
    )
  ),
];

/** The app's language for a prefs pick ("system" or a shipped locale). */
export const appLanguage = (
  pick: PrefsRow["language"] | null | undefined
): AppLanguage => resolveAppLanguage(pick, osLanguages());

let nativeLocale: AppLanguage["ui"] = "en-US";

/**
 * Loads the native words for `locale`; true when the language changed, so
 * the caller rebuilds what it labelled (the application menu).
 */
export async function setNativeLanguage(
  locale: AppLanguage["ui"]
): Promise<boolean> {
  await channelWords(locale);
  if (locale === nativeLocale) return false;
  nativeLocale = locale;
  return true;
}

/** A native word in the current language, English until it has loaded. */
/** The language the native words are in, for dates beside them. */
export const nativeLocaleTag = (): string => nativeLocale;

export const nativeT = (key: string, values?: Record<string, string>): string =>
  loadedWords(nativeLocale).t(`native.${key}`, values);
