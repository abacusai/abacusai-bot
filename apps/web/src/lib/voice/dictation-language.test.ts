/**
 * The spoken language decides dictation; the user's language breaks only a
 * close race, Hindi/Urdu take their script from the user, and every answer
 * is a code the model supports.
 */
import {
  WHISPER_BASE_MODEL_ID,
  WHISPER_SMALL_MODEL_ID,
} from "@abacus-ai/contract/voice";
import { describe, expect, it } from "vitest";

import {
  chooseDictationLanguage,
  dictationLanguageCode,
  dictationModel,
  type LanguageScore,
} from "./dictation-language";

const scores = (entries: Record<string, number>): LanguageScore[] =>
  Object.entries(entries).map(([code, p]) => ({ code, p }));

/** A slice of whisper's own language tokens, in its order. */
const SUPPORTED = ["en", "zh", "de", "es", "fr", "pt", "hi", "ur", "yue"];

describe("chooseDictationLanguage", () => {
  it.each([
    [
      "a confident top beats the user's language",
      { fr: 0.97, en: 0.02 },
      "en",
      [],
      "fr",
    ],
    [
      "a close race goes to the user's language",
      { es: 0.48, pt: 0.42, gl: 0.05 },
      "pt",
      [],
      "pt",
    ],
    [
      "a user's language far behind the top does not win",
      { de: 0.7, nl: 0.2, en: 0.1 },
      "en",
      [],
      "de",
    ],
    [
      "a user's language outside the top three does not win",
      { es: 0.3, it: 0.28, pt: 0.27, fr: 0.15 },
      "fr",
      [],
      "es",
    ],
    [
      "no user's language leaves the audio's top",
      { es: 0.5, pt: 0.4 },
      null,
      [],
      "es",
    ],
    [
      "English never overrides Hindi split across its two scripts",
      { ur: 0.5, hi: 0.45, en: 0.04 },
      "en",
      ["en-US"],
      "hi",
    ],
    [
      "English never overrides Hindi the small model scores 0.74",
      { hi: 0.74, ur: 0.14, en: 0.08 },
      "en",
      ["en-US"],
      "hi",
    ],
    [
      "Hindi/Urdu takes the user's Hindi over the audio's order",
      { ur: 0.5, hi: 0.45 },
      "hi",
      [],
      "hi",
    ],
    [
      "Hindi/Urdu takes the user's Urdu over the audio's order",
      { hi: 0.85, ur: 0.1 },
      "ur",
      ["hi-IN"],
      "ur",
    ],
    [
      "Hindi/Urdu takes the locale's language when the user's is neither",
      { ur: 0.5, hi: 0.45 },
      "en",
      ["hi-IN"],
      "hi",
    ],
    [
      "Hindi/Urdu takes the locale's region after its language",
      { ur: 0.5, hi: 0.45 },
      "en",
      ["en-IN"],
      "hi",
    ],
    [
      "Hindi/Urdu reads a Pakistan locale as Urdu",
      { hi: 0.6, ur: 0.35 },
      null,
      ["en-PK"],
      "ur",
    ],
    [
      "Hindi/Urdu is written in Hindi when nothing else says",
      { ur: 0.5, hi: 0.45 },
      "en",
      ["en-US", "not a tag!"],
      "hi",
    ],
  ])("%s", (_case, audio, code, localeTags, expected) => {
    expect(chooseDictationLanguage(scores(audio), { code, localeTags })).toBe(
      expected
    );
  });

  it("falls back to the user's language, then English, without scores", () => {
    expect(chooseDictationLanguage([], { code: "fr", localeTags: [] })).toBe(
      "fr"
    );
    expect(chooseDictationLanguage([], { code: null, localeTags: [] })).toBe(
      "en"
    );
  });
});

describe("dictationLanguageCode", () => {
  it.each([
    ["French", "fr"],
    ["english", "en"],
    ["Brazilian Portuguese", "pt"],
    ["Swiss High German", "de"],
    ["Cantonese", "yue"],
    ["Hindi", "hi"],
  ])("maps %s to %s", (name, code) => {
    expect(dictationLanguageCode(name, SUPPORTED)).toBe(code);
  });

  it.each([["Klingon"], ["Tagalog"], [""], ["  "]])(
    "answers null for %j, which the model cannot transcribe",
    (name) => {
      expect(dictationLanguageCode(name, SUPPORTED)).toBeNull();
    }
  );

  it("ignores a supported code with no English name instead of throwing", () => {
    expect(dictationLanguageCode("French", ["jw", "x-bad", "fr"])).toBe("fr");
  });

  it("an unsupported user language leaves the audio to decide", () => {
    const code = dictationLanguageCode("Klingon", SUPPORTED);
    expect(
      chooseDictationLanguage(scores({ es: 0.5, pt: 0.45 }), {
        code,
        localeTags: [],
      })
    ).toBe("es");
  });
});

describe("dictationModel", () => {
  it.each([
    ["en", true, WHISPER_BASE_MODEL_ID],
    ["en", false, WHISPER_BASE_MODEL_ID],
    ["fr", true, WHISPER_SMALL_MODEL_ID],
    ["fr", false, WHISPER_BASE_MODEL_ID],
    ["hi", true, WHISPER_SMALL_MODEL_ID],
  ])("%s with small ready=%s runs on %s", (language, ready, model) => {
    expect(dictationModel(language, ready)).toBe(model);
  });
});
