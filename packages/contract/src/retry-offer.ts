/**
 * The retry offer: when a task goes badly, one line under the reply offering
 * the same task again on one of the plan's top models. The renderer reads the
 * reason off the chat. On a free account a tap opens the upgrade dialog, and
 * once paid the message runs again on that model; half the free accounts get
 * it, so what it does to upgrades can be read against the half that do not.
 * A paying account's plan already runs the model: a tap moves the chat onto
 * it and runs the message again. Either way the chat stays on that model.
 */
import { isCleanReply, normalizedText, wordsPattern } from "./success-pitch";

export const RETRY_OFFER_REASONS = ["failed", "complaint", "repeat"] as const;
export type RetryOfferReason = (typeof RETRY_OFFER_REASONS)[number];

/** What the user says when the last attempt did not work. */
const STUCK_WORDS = [
  // English
  "still not",
  "still doesn't",
  "still broken",
  "still the same",
  "still failing",
  "still getting",
  "doesn't work",
  "does not work",
  "didn't work",
  "did not work",
  "not working",
  "isn't working",
  "same error",
  "same problem",
  "same issue",
  "nothing changed",
  "didn't fix",
  "not fixed",
  // Portuguese
  "não funciona",
  "não funcionou",
  "não está funcionando",
  "ainda não",
  "mesmo erro",
  "mesmo problema",
  "não mudou",
  // Spanish
  "no funciona",
  "no funcionó",
  "sigue sin",
  "sigue igual",
  "mismo error",
  "mismo problema",
  "no cambió",
  // Turkish
  "çalışmıyor",
  "çalışmadı",
  "olmadı",
  "hâlâ",
  "hala",
  "aynı hata",
  "aynı sorun",
  "düzelmedi",
  "değişmedi",
  // German
  "funktioniert nicht",
  "geht nicht",
  "immer noch",
  "gleicher fehler",
  "gleiche fehler",
  // French
  "ne marche pas",
  "ne fonctionne pas",
  "toujours pas",
  "même erreur",
  "même problème",
  // Italian
  "non funziona",
  "non ha funzionato",
  "ancora non",
  "stesso errore",
  "stesso problema",
  // Indonesian
  "tidak berfungsi",
  "tidak jalan",
  "masih error",
  "masih sama",
  "belum berhasil",
  // Quality, in every language: the result is bad, will not open, or is made up
  "rubbish",
  "garbage",
  "stupid",
  "useless",
  "terrible",
  "horrible",
  "awful",
  "nonsense",
  "makes no sense",
  "not what i asked",
  "not what i wanted",
  "you didn't",
  "you did not",
  "won't open",
  "doesn't open",
  "does not open",
  "can't open",
  "cannot open",
  "not opening",
  "completely wrong",
  "all wrong",
  "is wrong",
  "made up",
  "too literal",
  "fake data",
  "made it worse",
  "why didn't you",
  "why have you not",
  "not showing",
  "doesn't show",
  "no abre",
  "no se abre",
  "no sirve",
  "basura",
  "pésimo",
  "está mal",
  "esta mal",
  "inventaste",
  "no es lo que",
  "no tiene sentido",
  "no aparece",
  "no aparecen",
  "no se guarda*",
  "não abre",
  "nao abre",
  "não está abrindo",
  "lixo",
  "péssimo",
  "está errado",
  "esta errado",
  "inventou",
  "piorou",
  "não faz sentido",
  "não foi",
  "nao foi",
  "não fez",
  "nao fez",
  "não aparece*",
  "nao aparece*",
  "não está legal",
  "nao ta legal",
  "açılmıyor",
  "berbat",
  "saçma",
  "yanlış",
  "uydurma",
  "rezalet",
  "olmamış",
  "kötü",
  "açamıyorum",
  "göremiyorum",
  "bozulmuş",
  "öffnet nicht",
  "öffnet sich nicht",
  "schlecht",
  "scheiße",
  "scheisse",
  "schrott",
  "falsch",
  "erfunden",
  "sinnlos",
  "ne s'ouvre pas",
  "n'importe quoi",
  "c'est faux",
  "c'est nul",
  "non si apre",
  "pessimo",
  "sbagliato",
  "inventato",
  "tidak bisa dibuka",
  "jelek",
  "ngawur",
  // Arabic
  "غبي",
  "سيء",
  "سيئ",
  "خطأ",
  "غلط",
  "ما يشتغل",
  "ما اشتغل",
  "لا يعمل",
  "ما يفتح",
  "لا يفتح",
  "مو صح",
  "ليس صحيح",
  "حرفي*",
  "زفت",
  "خربان",
  // Russian
  "не работает",
  "не открывается",
  "ерунда",
  "бред",
  "плохо",
  "ужасно",
  "неправильно",
  "фигня",
  "опять ошибка",
  "опять не",
  "всё равно не",
  "все равно не",
  "не сделал",
  "не видит",
  // Ukrainian
  "не працює",
  "не відкривається",
  "погано",
  "жахливо",
  "маячня",
  "не зробив",
  "не бачить",
  // Polish
  "nie działa",
  "nie otwiera",
  "bzdury",
  "brednie",
  "źle",
  "beznadziej*",
  "do niczego",
  "dalej nie",
  "nadal nie",
  // Danish, Norwegian, Swedish
  "virker ikke",
  "fungerer ikke",
  "fungerar inte",
  "funkar inte",
  "åbner ikke",
  "stadig ikke",
  "dårligt",
  "elendig",
  "forkert",
  // Dutch
  "werkt niet",
  "opent niet",
  "klopt niet",
  "nog steeds niet",
  // Hebrew
  "לא עובד",
  "לא נפתח",
  "גרוע",
  "זבל",
  // Persian
  "کار نمی‌کند",
  "کار نمیکنه",
  "افتضاح",
  // Hindi, romanized and Devanagari
  "kaam nahi",
  "nahi chal raha",
  "galat",
  "bekar",
  "bakwas",
  "काम नहीं",
  "गलत",
  "बेकार",
  // Vietnamese
  "không chạy",
  "không mở được",
  "sai rồi",
];
const STUCK = wordsPattern(STUCK_WORDS);

/** The same, in scripts without spaces between words: matched anywhere. */
const STUCK_UNSPACED = [
  "動かない",
  "開かない",
  "間違って",
  "ダメ",
  "不行",
  "不能用",
  "打不开",
  "错了",
  "没用",
  "垃圾",
  "안 돼",
  "안돼",
  "작동 안",
  "열리지 않",
  "ไม่ทำงาน",
  "เปิดไม่ได้",
];

/** Longer than this is a new brief, whatever words it uses. */
const STUCK_MAX_LENGTH = 300;

/** The message says the last attempt did not work. */
export const isStuckMessage = (text: string): boolean => {
  const message = normalizedText(text);
  return (
    message.length <= STUCK_MAX_LENGTH &&
    (STUCK.test(message) ||
      STUCK_UNSPACED.some((word) => message.includes(word)))
  );
};

const askWords = (text: string): Set<string> =>
  new Set(normalizedText(text).match(/[\p{L}\p{N}]+/gu) ?? []);

/** Fewer words than this is "continue" or "yes", which repeats nothing. */
const SAME_ASK_MIN_WORDS = 4;
const SAME_ASK_OVERLAP = 0.8;

/** The two messages ask for the same thing: nearly the same words. */
export const isSameAsk = (a: string, b: string): boolean => {
  const first = askWords(a);
  const second = askWords(b);
  if (first.size < SAME_ASK_MIN_WORDS || second.size < SAME_ASK_MIN_WORDS)
    return false;
  const shared = [...first].filter((word) => second.has(word)).length;
  return shared / (first.size + second.size - shared) >= SAME_ASK_OVERLAP;
};

export interface RetryOfferTurn {
  /** The user's words that opened the latest turn. */
  ask: string;
  /** Their last messages before it, the latest first. */
  earlierAsks: readonly string[];
  /** The turn's final reply. */
  reply: string;
  /** The turn ran tools that build or change something. */
  ranWork: boolean;
  /** So did the turn before it. */
  earlierRanWork: boolean;
}

/**
 * Why this turn went badly, or null. A failure counts only after work: a reply
 * that declines a request runs no tools, and a better model is no answer to it.
 */
export const retryOfferReason = (
  turn: RetryOfferTurn
): RetryOfferReason | null => {
  if (turn.ranWork && !isCleanReply(turn.reply)) return "failed";
  if (turn.earlierRanWork && isStuckMessage(turn.ask)) return "complaint";
  if (turn.earlierAsks.slice(0, 2).some((ask) => isSameAsk(ask, turn.ask)))
    return "repeat";
  return null;
};

/** FNV-1a: an account's half must not move between launches or builds. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

/** Whether this account is in the half that gets the offer. */
export const retryOfferForAccount = (accountKey: string): boolean =>
  hash(`retry-offer:${accountKey}`) % 2 === 0;

/** A model picker row, as far as the offers read it. */
interface CatalogRow {
  id: string;
  label: string;
  /** Runnable now: a credential (or the account's plan) covers it. */
  configured?: boolean;
  access?: string;
}

/**
 * What a model is, read off its catalog id, never its marketing name:
 * `abacus/claude-opus-5-5` is family `claude-opus`, version 5.5. Numbers are
 * the version, a date stamp (`-20250929`) is dropped, and every other word is
 * the family, so `claude-opus-5-5-thinking` is a family of its own.
 */
export interface ModelIdentity {
  family: string;
  version: number[];
}

/** Longer runs of digits are date stamps, not versions. */
const VERSION_MAX_DIGITS = 4;

export const modelIdentity = (id: string): ModelIdentity => {
  const words = (id.split("/").at(-1) ?? id)
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter((word) => word.length > 0);
  const numeric = (word: string) => /^\d+$/.test(word);
  return {
    family: words.filter((word) => !numeric(word)).join("-"),
    version: words
      .filter((word) => numeric(word) && word.length <= VERSION_MAX_DIGITS)
      .map(Number),
  };
};

/** Newer first: 5.5 before 5, 5 before 4.8. */
const newerFirst = (a: number[], b: number[]): number => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** The two families the offers name: Opus for a hard retry, Sonnet for every day. */
export const TOP_MODEL_FAMILIES = {
  opus: "claude-opus",
  sonnet: "claude-sonnet",
} as const;
export type TopModelFamily = keyof typeof TOP_MODEL_FAMILIES;

const usableRows = <T extends CatalogRow>(
  catalog: readonly T[],
  access: "locked" | "runnable"
): T[] =>
  catalog.filter((model) =>
    access === "locked"
      ? model.access === "locked"
      : model.configured === true && model.access !== "locked"
  );

/**
 * The catalog's model of a family, with the access asked for: `locked` for
 * one the next plan unlocks, `runnable` for one the account's own plan runs
 * now. One the plan names among its top models (`planIds`, the server's ids)
 * wins; then the newest version. Matched on the id, so a plan whose pitch
 * reorders or renames its models, or a new version, still finds it.
 */
export const familyCatalogModel = <T extends CatalogRow>(
  family: TopModelFamily,
  catalog: readonly T[],
  access: "locked" | "runnable",
  planIds: readonly string[] = []
): T | null => {
  const wanted = TOP_MODEL_FAMILIES[family];
  const rows = usableRows(catalog, access)
    .map((model) => ({ model, identity: modelIdentity(model.id) }))
    .filter(({ identity }) => identity.family === wanted)
    .sort(
      (a, b) =>
        Number(planIds.includes(b.model.id)) -
          Number(planIds.includes(a.model.id)) ||
        newerFirst(a.identity.version, b.identity.version)
    );
  return rows[0]?.model ?? null;
};

/**
 * The model to offer: the plan's Opus, else its Sonnet, else the first of the
 * plan's top models the catalog lists with the access asked for. A free
 * account asks for `locked` (the upgrade unlocks it), a paying one for
 * `runnable` (its plan runs it now). Null when none is: the rerun must land on
 * a model the plan runs.
 */
export const retryOfferModel = <T extends CatalogRow>(
  catalog: readonly T[],
  access: "locked" | "runnable" = "locked",
  planIds: readonly string[] = []
): T | null => {
  const usable = usableRows(catalog, access);
  return (
    familyCatalogModel("opus", catalog, access, planIds) ??
    familyCatalogModel("sonnet", catalog, access, planIds) ??
    planIds
      .map((id) => usable.find((model) => model.id === id) ?? null)
      .find((model) => model != null) ??
    null
  );
};
