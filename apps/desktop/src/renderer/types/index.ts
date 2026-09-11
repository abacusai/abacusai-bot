export type Theme = "light" | "dark" | "system";

export interface Language {
  code: string;
  label: string;
}

export const LANGUAGES: Language[] = [
  { code: "en-US", label: "English (United States)" },
  { code: "fr-FR", label: "Français (France)" },
  { code: "de-DE", label: "Deutsch (Deutschland)" },
  { code: "hi-IN", label: "हिन्दी (भारत)" },
  { code: "id-ID", label: "Indonesia (Indonesia)" },
  { code: "it-IT", label: "Italiano (Italia)" },
  { code: "ja-JP", label: "日本語 (日本)" },
  { code: "ko-KR", label: "한국어(대한민국)" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "es-419", label: "Español (Latinoamérica)" },
  { code: "es-ES", label: "Español (España)" },
];
