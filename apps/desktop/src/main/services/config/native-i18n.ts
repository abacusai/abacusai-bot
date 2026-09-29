import { createInstance } from "i18next";

import deDE from "../../../renderer/locales/de-DE.json";
import enUS from "../../../renderer/locales/en-US.json";
import es419 from "../../../renderer/locales/es-419.json";
import esES from "../../../renderer/locales/es-ES.json";
import frFR from "../../../renderer/locales/fr-FR.json";
import hiIN from "../../../renderer/locales/hi-IN.json";
import idID from "../../../renderer/locales/id-ID.json";
import itIT from "../../../renderer/locales/it-IT.json";
import jaJP from "../../../renderer/locales/ja-JP.json";
import koKR from "../../../renderer/locales/ko-KR.json";
import ptBR from "../../../renderer/locales/pt-BR.json";

const instance = createInstance();
void instance.init({
  lng: "en-US",
  fallbackLng: "en-US",
  initImmediate: false,
  interpolation: { escapeValue: false },
  resources: {
    "en-US": { translation: enUS.native },
    "de-DE": { translation: deDE.native },
    "es-ES": { translation: esES.native },
    "es-419": { translation: es419.native },
    "fr-FR": { translation: frFR.native },
    "hi-IN": { translation: hiIN.native },
    "id-ID": { translation: idID.native },
    "it-IT": { translation: itIT.native },
    "ja-JP": { translation: jaJP.native },
    "ko-KR": { translation: koKR.native },
    "pt-BR": { translation: ptBR.native },
  },
});

export function setNativeLanguage(code: string): void {
  void instance.changeLanguage(code);
}

export function nativeT(
  key: keyof typeof enUS.native,
  values?: Record<string, string>
): string {
  return instance.t(key, values);
}
