import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { changeLanguage, initialLanguage, SUPPORTED_LANGUAGES } from "../i18n";
import { durableStorage } from "../lib/durable-storage";

interface LanguageState {
  languageCode: string;
  setLanguageCode: (code: string) => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      languageCode: initialLanguage(),
      setLanguageCode: (code) => {
        if (SUPPORTED_LANGUAGES.includes(code) && get().languageCode !== code) {
          set({ languageCode: code });
          void changeLanguage(code);
        }
      },
    }),
    {
      name: "abacusai-bot-language",
      merge: (persisted, current) => {
        const saved = (persisted as Partial<LanguageState> | undefined)
          ?.languageCode;
        return {
          ...current,
          languageCode:
            typeof saved === "string" && SUPPORTED_LANGUAGES.includes(saved)
              ? saved
              : current.languageCode,
        };
      },
      storage: createJSONStorage(() => durableStorage),
    }
  )
);
