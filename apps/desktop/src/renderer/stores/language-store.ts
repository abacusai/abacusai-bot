import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { changeLanguage } from "../i18n";
import { durableStorage } from "../lib/durable-storage";

interface LanguageState {
  languageCode: string;
  setLanguageCode: (code: string) => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      languageCode: "en-US",
      setLanguageCode: (code) => {
        if (get().languageCode !== code) {
          set({ languageCode: code });
          void changeLanguage(code);
        }
      },
    }),
    {
      name: "abacusai-bot-language",
      storage: createJSONStorage(() => durableStorage),
    }
  )
);
