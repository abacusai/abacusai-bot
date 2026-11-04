/**
 * A turn that ends on a promise. Cheap models close a reply with "Reading them
 * now." or "Devam ediyorum." and make no tool call, so the run ends and nothing
 * happens until the user nudges it. One policy for both loops (session.ts,
 * forever/engine.ts): the model is told once, out of sight, to do it now.
 *
 * A long reply can end this way too, so the closing words decide, not the whole
 * reply. Words that hand back to the user, or wait on something else, win over a
 * promise anywhere in the closing paragraph: a missed stall costs a nudge, a
 * false one spends credits on work nobody asked for.
 */

import { liveBackgroundJobCount } from "./background-processes.js";
import { creditWallActive } from "./credit-wall.js";
import { budgetStopReason } from "./extensions/budgets.js";
import { isOwnerAudience } from "./owner-tools.js";
import { AgentMode } from "./protocol.js";

/** Extra calls a turn may spend on a promise. Reset only by a new user send. */
export const PROMISED_WORK_RECOVERIES = 1;

/** Marks the continuation in the session log as ours rather than the user's. */
export const PROMISED_WORK_TYPE = "abacusai-bot:promised-work";

export const PROMISED_WORK_PROMPT =
  "This message comes from the app, not the user. Your last message said you would carry on, but it " +
  "called no tool, so nothing ran and the turn was about to end. Do that work now, starting with a " +
  "tool call. Do not repeat what you said or apologize. If it needs something only the user can " +
  "give, or there is nothing left to do, say that plainly in one or two sentences, in the user's " +
  "language.";

/** The closing sentence's own length limit: past it, it is prose. */
const MAX_CLOSING_CHARS = 220;

/** A last sentence this short may trail the promise: "Reading it. One sec." */
const SHORT_SENTENCE_CHARS = 60;

/** Actions a promise names. An allowlist: "I'll be happy to help" must not match. */
const EN_ACTIONS =
  "view|check|look|load|read|open|list|examine|analy[sz]e|search|find|locate|create|write|draft|edit|" +
  "update|fix|run|start|begin|implement|generate|proceed|continue|dive|explore|review|verify|test|" +
  "inspect|scan|parse|build|refactor|apply|add|modify|upgrade|compare|trace|investigate|debug|" +
  "install|execute|fetch|retrieve|query|download|save|rename|move|copy|compile|deploy|convert|" +
  "clean|replace|restore|pull|push|revert|delete|remove|patch|migrate|extract|split|merge|wire|" +
  "switch|correct|adjust|finish|complete|validate|commit|configure|set up|enable|disable|change|" +
  "compile|work through|go through|get|do|grab|pick up|keep going|carry on|try|send|prepare|process";

const EN_ACTIVE =
  "continuing|carrying on|moving on|proceeding|starting|reading|writing|checking|fixing|running|" +
  "building|updating|searching|fetching|pulling|looking|applying|implementing|creating|generating|" +
  "processing|compiling|finishing|verifying|testing|installing|downloading|saving|adding|opening|" +
  "working on|getting on|rebuilding|rewriting|re-running|retrying|trying";

/**
 * How each language says "I am going on now", at the start of a closing
 * sentence: mid-sentence it follows a condition ("send it, and I'll check").
 */
const PROMISE_PATTERNS: readonly RegExp[] = [
  // English.
  new RegExp(
    `^(?:(?:ok(?:ay)?|alright|right|good|great|now|next|first|then|so|and)[,:]?\\s+)*` +
      `(?:i'?ll|i will|i'?m going to|i am going to|let me|let's|about to|going to)\\s+` +
      `(?:\\w+\\s+){0,2}?(?:re-?)?(?:${EN_ACTIONS})\\b`
  ),
  new RegExp(`^(?:(?:and|now|so)\\s+)?(?:${EN_ACTIVE})\\b.*\\bnow$`),
  new RegExp(`^now\\s+(?:${EN_ACTIVE})\\b`),
  /^(?:(?:and|now|so)\s+)?(?:continuing|carrying on|moving on|proceeding|on it|on them|starting now)\b/,
  /^i'?m on (?:it|them|that|this)\b/,
  /^(?:one|just a) (?:sec|second|moment|minute)\b/,
  /\bis next\b/,
  // Spanish. Present tense announces here; object pronouns glue to the verb.
  /^(?:(?:y|ahora|ya|luego|primero|vale|ok|bien)[,:]?\s+)*(?:sigo|contin[uú]o|empiezo|comienzo|arranco|ejecuto|procedo|voy a (?:\S+\s+){0,1}?(?:ver|leer|revisar|abrir|crear|escribir|editar|corregir|ejecutar|empezar|comenzar|continuar|seguir|analizar|probar|buscar|actualizar|implementar|generar|instalar|construir|validar|hacer|aplicar|ajustar|preparar|montar|compilar|mirar|comprobar|guardar|enviar|descargar|terminar|acabar)|voy con|voy por|paso a|paso al|me pongo|lo hago|los? leo|las? leo|busco|reviso|compruebo)\b/,
  /^\p{L}+(?:ando|iendo)\b.*\b(?:ya|ahora)$/u,
  // Portuguese.
  /^(?:(?:e|agora|j[aá]|depois|primeiro|ok|certo)[,:]?\s+)*(?:vou (?:\S+\s+){0,1}?(?:ver|verificar|analisar|ler|checar|revisar|abrir|criar|escrever|editar|corrigir|executar|rodar|come[cç]ar|continuar|seguir|testar|buscar|procurar|atualizar|implementar|gerar|instalar|construir|validar|fazer|aplicar|ajustar|preparar|montar|compilar|olhar|conferir|salvar|enviar|baixar|terminar|finalizar|l[eê]-l[oa]s?)|sigo|continuo|come[cç]o|prossigo|inicio|executo|implemento|aplico|passo para|parto para)\b/,
  /^\p{L}+(?:ando|endo|indo)\b.*\b(?:agora|j[aá])$/u,
  /^(?:continuando|seguindo|prosseguindo|come[cç]ando|iniciando|implementando|aplicando|executando|verificando)\b/,
  // Catalan.
  /^(?:(?:i|ara|ja)\s+)*(?:segueixo|continuo|arrenco|comen[cç]o|ho faig|vaig a)\b/,
  // Turkish: the verb closes the sentence.
  /^(?:\S+\s+){0,1}devam$/,
  /^(?:\S+\s+){0,1}?(?:devam ediyorum|devam ediyoruz|başlıyorum|başlıyoruz|geçiyorum|ilerliyorum|bakıyorum|kontrol ediyorum|düzeltiyorum|yazıyorum|ekliyorum|gönderiyorum|çalıştırıyorum|hazırlıyorum|inceliyorum|okuyorum|uyguluyorum|yapıyorum|bitiriyorum)(?:$|[,\s])/,
  /^(?:şimdi|sıradaki|sırada)\b.*(?:ıyorum|iyorum|uyorum|üyorum|acağım|eceğim)$/,
  // French.
  /^(?:(?:et|maintenant|ok|bien|alors)[,:]?\s+)*(?:je vais (?:\S+\s+){0,1}?(?:lire|v[eé]rifier|consulter|ouvrir|cr[eé]er|[eé]crire|[eé]diter|corriger|ex[eé]cuter|lancer|commencer|continuer|analyser|tester|chercher|rechercher|mettre|impl[eé]menter|g[eé]n[eé]rer|installer|faire|regarder)|je (?:continue|commence|poursuis|passe|lance|reprends|pr[eé]pare|m'en occupe|m'y (?:re)?mets)|on (?:continue|y va)|c'est parti)\b/,
  // German.
  /^(?:(?:ok|gut|jetzt|nun|dann|als nächstes)[,:]?\s+)*(?:ich (?:mache|starte|beginne|prüfe|lese|schaue|fange|arbeite|setze|werde)|mache (?:ich )?(?:jetzt|gleich|weiter)|weiter geht|los geht)\b/,
  // Italian.
  /^(?:(?:e|ora|adesso|ok|bene)[,:]?\s+)*(?:continuo|procedo|proseguo|inizio|comincio|passo a|passo al|mi metto|vado (?:a|avanti)|faccio subito)\b/,
  // Indonesian.
  /^(?:(?:oke|baik|sekarang)[,:]?\s+)*(?:saya|aku|kita)?\s*(?:lanjut|lanjutkan|akan|mulai|kerjakan|cek|periksa)\b/,
  // Russian: the verb carries it; the lookahead drops the polite imperative.
  /^(?:сейчас|теперь|далее|итак)?\s*(?:начина|начну|приступ|прочита|посмотр|провер|откро|созда|напиш|испра|запущ|запуска|продолж|обнов|перехож|перейд)(?!\S*(?:ите|йте|ьте)$)/,
  // Chinese: needs a forward-looking lead-in, "我更新了首页" is a report.
  /(?:^|[，,])\s*(?:(?:继续|繼續|好的|接下来|接下來|现在|現在)[，,]?\s*)?(?:(?:让我|讓我)\s*(?:先|来|來)?|(?:我|我们|我們)\s*(?:先|会|會|将|將|要|来|來|马上|馬上|立刻|现在|現在|接着|接著)|(?:先|接着|接著|马上|馬上|立刻))\s*(?:看|查|检查|檢查|确认|確認|读取|讀取|打开|打開|创建|創建|修改|更新|修复|修復|运行|執行|开始|開始|分析|测试|測試|搜索|搜尋|处理|處理|继续|繼續)/,
  // Japanese and Korean: the polite verb ending closes the sentence.
  /(?:続けます|進めます|始めます|開始します|確認します|修正します|実行します|取り掛かります|調べます)$/,
  /(?:계속|진행|시작|확인|수정|실행)(?:합니다|할게요|하겠습니다)$/,
];

/**
 * Hand-backs and waits, in the closing sentences: "say go and I'll write it" is
 * a hand-back whatever it promises, and "I'll report when it finishes" is
 * already right. Each is matched at the start of a word, so a stem covers its
 * endings.
 */
const NOT_NOW_MARKERS: readonly string[] = [
  // English.
  "let me know",
  "if you",
  "if that",
  "when you",
  "once you",
  "after you",
  "as soon as",
  "say go",
  "say the word",
  "your call",
  "tell me",
  "message me",
  "text me",
  "want me",
  "would you",
  "shall i",
  "should i",
  "do you",
  "up to you",
  "whenever",
  "feel free",
  "your go-ahead",
  "your ok",
  "please",
  "confirm and",
  "confirm that",
  "waiting",
  "wait for",
  "when it",
  "when they",
  "once it",
  "once they",
  "when the",
  "once the",
  "when that",
  "once that",
  "tomorrow",
  "tonight",
  "next time",
  "next week",
  "next session",
  "next scheduled",
  "later",
  "in the morning",
  "you can",
  "you'll",
  "you will",
  "you should",
  "you need",
  "paste",
  "stand by",
  "tap ",
  "here's",
  "here is",
  // Spanish.
  "si quieres",
  "si prefieres",
  "si me",
  "si te",
  "dime",
  "dímelo",
  "avísame",
  "cuando",
  "en cuanto",
  "mañana",
  "esper",
  "te aviso",
  "tu decides",
  "tú decides",
  // Portuguese.
  "se quiser",
  "se preferir",
  "me diga",
  "me avise",
  "quando",
  "assim que",
  "amanhã",
  "aguard",
  "te aviso",
  "você decide",
  // Catalan.
  "si vols",
  "si em",
  "digues",
  "quan ",
  "demà",
  // Turkish.
  "istersen",
  "isterseniz",
  "söyle",
  "onay",
  "bekl",
  "yarın",
  "haber ver",
  "bitince",
  "olunca",
  "gelince",
  "verince",
  "diyorsan",
  "dersen",
  "anlatırsan",
  "yaz,",
  "at,",
  "ver,",
  // French.
  "si tu",
  "si vous",
  "dis-moi",
  "dites-moi",
  "quand",
  "dès que",
  "demain",
  "j'attends",
  // German.
  "wenn du",
  "wenn sie",
  "sag mir",
  "sobald",
  "morgen",
  "warte",
  // Italian.
  "se vuoi",
  "dimmi",
  "domani",
  "appena",
  "aspetto",
  // Indonesian.
  "kalau",
  "kabari",
  "nanti",
  "besok",
  "tunggu",
  // Russian.
  "скажи",
  "сообщи",
  "подтверди",
  "дай знать",
  "дайте знать",
  "когда",
  "завтра",
  "если",
];

/** Scripts with no word breaks: matched anywhere. */
const NOT_NOW_CJK =
  /告诉我|告訴我|请确认|請確認|如果|等您|等你|明天|ください|お待ち|알려/;

const NOT_NOW = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${NOT_NOW_MARKERS.join("|")})`,
  "u"
);

/**
 * A label for the next step. Mid-task it is the same promise; before any tool
 * it opens a plan the user is reading.
 */
const NEXT_STEP =
  /^(?:next|up next|sırada|sıradaki|siguiente|pr[oó]ximo|a seguir|ensuite|als n[aä]chstes|prossimo|selanjutnya|berikutnya)\b\s*(?:[:→—–-]|step:)/;

/** Refusals: "I won't run that" is the model's last word. */
const NEGATED =
  /\b(?:not|never|won'?t|can'?t|cannot|don'?t|no voy|no puedo|não vou|não posso|je ne|nicht|non posso|tidak|gak|не\s)\b/;

/** What may trail the words: markup, a closing tag, emoji. */
const TRAILING_DECORATION =
  /(?:[\s*_`~>"'”’)\]\p{Extended_Pictographic}]|\u200d|\ufe0f)+$/u;

const SENTENCE_BREAK = /(?<=[.!?…。！？])\s+/;

const closingParagraph = (text: string): string =>
  text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

/** A sentence as the patterns read it: bare, lower case, no end mark. */
const bare = (sentence: string): string =>
  sentence
    .replace(/[*_`~]/g, "")
    .replace(/[.!…。！]+$/, "")
    .trim();

/**
 * Whether a reply ends promising work the model is about to do, with nothing
 * needed from anyone first. `ranTools`: the run already called a tool, so it is
 * mid-task and a closing colon promised output. Before any tool a colon is as
 * often the start of an offer.
 */
export function promisesMoreWork(reply: string, ranTools: boolean): boolean {
  if (reply.trimEnd().endsWith("```")) return false;
  const text = reply
    .replace(/<\/?reply>/gi, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/İ/g, "i")
    .replace(TRAILING_DECORATION, "")
    .toLowerCase();
  const paragraph = closingParagraph(text);
  const sentences = paragraph.split(SENTENCE_BREAK).map(bare).filter(Boolean);
  const last = sentences.at(-1) ?? "";
  // The promise, or the promise and one short sentence after it.
  const closing =
    last.length <= SHORT_SENTENCE_CHARS ? sentences.slice(-2) : [last];
  // A question, or a link to go and open, hands the turn back.
  if (/[?？]/.test(paragraph) || /https?:\/\/\S+$/.test(paragraph))
    return false;
  if (NOT_NOW.test(paragraph) || NOT_NOW_CJK.test(paragraph)) return false;
  if (/[:：]$/.test(last)) return ranTools && last.length <= MAX_CLOSING_CHARS;
  return closing.some(
    (sentence) =>
      sentence.length <= MAX_CLOSING_CHARS &&
      !NEGATED.test(sentence) &&
      ((ranTools && NEXT_STEP.test(sentence)) ||
        PROMISE_PATTERNS.some((pattern) => pattern.test(sentence)))
  );
}

interface RunMessage {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
}

const blocksOf = (message: RunMessage): { type?: string; text?: string }[] =>
  Array.isArray(message.content) ? message.content : [];

/**
 * Whether this run's last model message closed the run on a promise. A reply
 * cut off, stopped or failed has its own handling, and a tool call in the
 * message means the work is under way.
 */
export function endedOnPromise(messages: readonly unknown[]): boolean {
  const said = (messages as readonly RunMessage[]).filter(
    (message) => message.role === "assistant"
  );
  const last = said.at(-1);
  if (last?.stopReason !== "stop") return false;
  const blocks = blocksOf(last);
  if (blocks.some((block) => block.type === "toolCall")) return false;
  const text = blocks
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
  const ranTools = said.some((message) =>
    blocksOf(message).some((block) => block.type === "toolCall")
  );
  return promisesMoreWork(text, ranTools);
}

/**
 * Whether anyone is waiting on this run to go on. Only the user's own chats
 * (a routine's closing summary is its last word; a contact's "I'll check" is
 * an answer) and only where the model may act. A run closing out on a budget,
 * or at the credit wall, is meant to stop. A job still running in the
 * background wakes the run itself when it settles.
 */
export const mayAskForPromisedWork = (mode: AgentMode): boolean =>
  isOwnerAudience() &&
  mode !== AgentMode.PlanMode &&
  mode !== AgentMode.Unattended &&
  budgetStopReason() == null &&
  !creditWallActive() &&
  liveBackgroundJobCount() === 0;

/** Spent per user send; nothing but `begin` gives one back. */
export class PromisedWork {
  private spent = 0;

  /** A new turn. */
  begin(): void {
    this.spent = 0;
  }

  /** Whether this turn may still ask, spending the ask if so. */
  claim(): boolean {
    if (this.spent >= PROMISED_WORK_RECOVERIES) return false;
    this.spent += 1;
    return true;
  }
}
