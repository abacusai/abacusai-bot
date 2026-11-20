/**
 * Standing instructions: the rule notes About you (memory/you/), which every
 * chat follows, Memory on or off, and with Memory on the user's preferences.
 * The user adds and edits them on the Memory page; a chat may save one when
 * the user asks, but never changes one the user wrote (memory/tool.ts). One
 * block for every loop that writes to the user, re-read per turn so edits land
 * on the next message.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir } from "./config.js";
import { MAX_NOTE_CHARS } from "./memory/gate.js";
import { declaredLane, followsYourPreferences } from "./memory/lanes.js";
import {
  commit,
  type FileWrite,
  oneLine,
  listNotes,
  memoryDir,
  type Note,
  noteDelete,
  noteWrite,
  slugify,
  today,
} from "./memory/notes.js";
import type { UserTextTags } from "./protocol.js";
import { isRoutineFire } from "./user-text.js";

/** Bounded because this lands in every request; a page of house style fits. */
export const MAX_CUSTOM_INSTRUCTIONS = 8_000;

const MOVED_MARKER = ".migrated-instructions";

/** The file the instructions lived in before they were rule notes. */
export function customInstructionsPath(): string {
  return path.join(abacusBotDir(), "INSTRUCTIONS.md");
}

const legacyText = (): string => {
  if (fs.existsSync(path.join(memoryDir(), MOVED_MARKER))) return "";
  try {
    return fs.readFileSync(customInstructionsPath(), "utf8").trim();
  } catch {
    return "";
  }
};

const rules = (): Note[] =>
  listNotes({ kind: "you" }).filter((note) => note.type === "rule");

const preferences = (): Note[] =>
  followsYourPreferences(declaredLane())
    ? listNotes({ kind: "you" }).filter((note) => note.type === "preference")
    : [];

/** Every instruction, one per paragraph, or "" for none. Never throws. */
export function readCustomInstructions(): string {
  try {
    const text = rules()
      .map((note) => note.body.trim())
      .join("\n\n");
    // Until the old file has moved in (the desktop does it at start), it still applies.
    return [legacyText(), text].filter((part) => part.length > 0).join("\n\n");
  } catch {
    // Missing or unreadable must never stop a session starting.
    return "";
  }
}

/** Text cut into notes: one per paragraph, none longer than a note holds. */
const paragraphs = (text: string): string[] =>
  text
    .trim()
    .slice(0, MAX_CUSTOM_INSTRUCTIONS)
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const pieces: string[] = [];
      for (let at = 0; at < part.length; at += MAX_NOTE_CHARS)
        pieces.push(part.slice(at, at + MAX_NOTE_CHARS));
      return pieces;
    });

const ruleNotes = (text: string, taken: Set<string>, now: Date): Note[] =>
  paragraphs(text).map((body) => {
    const base = slugify(
      body.split(/\s+/).slice(0, 6).join(" "),
      "instruction"
    );
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
    taken.add(name);
    return {
      scope: { kind: "you" },
      name,
      description: (body.split("\n")[0] ?? body).slice(0, 150),
      type: "rule",
      body,
      updated: today(now),
      by: "you",
    };
  });

/**
 * Replace the instructions the user wrote with `text`, one rule per
 * paragraph; rules a chat saved stay. Empty clears the user's own.
 */
export async function writeCustomInstructions(
  text: string,
  now = new Date()
): Promise<void> {
  const result = await commit({ by: "you" }, () => {
    const all = listNotes({ kind: "you" });
    const own = all.filter((note) => note.type === "rule" && note.by === "you");
    const taken = new Set(
      all.filter((note) => !own.includes(note)).map((note) => note.name)
    );
    const writes: FileWrite[] = [
      ...own.map((note) => noteDelete(note.scope, note.name)),
      ...ruleNotes(text, taken, now).map(noteWrite),
    ];
    return { writes, value: null };
  });
  if (!result.ok) throw new Error(result.message);
}

/**
 * The old instructions file, moved into rule notes once (a marker records it).
 * The file is left where it was.
 */
export async function moveInstructionsIn(now = new Date()): Promise<void> {
  if (fs.existsSync(path.join(memoryDir(), MOVED_MARKER))) return;
  await commit({ by: "app" }, () => {
    const marker = path.join(memoryDir(), MOVED_MARKER);
    if (fs.existsSync(marker)) return { writes: [], value: null };
    const text = legacyText();
    const taken = new Set(listNotes({ kind: "you" }).map((note) => note.name));
    return {
      writes: [
        ...ruleNotes(text, taken, now).map(noteWrite),
        { file: marker, contents: now.toISOString() },
      ],
      value: null,
    };
  });
}

/**
 * What this chat follows: the instructions, then the preferences (Memory on,
 * and only in the user's own chats and runs, lanes.ts). "" for none; never throws.
 */
export function readStandingInstructions(): string {
  try {
    const liked = preferences().map((note) => `- ${oneLine(note.body)}`);
    return [
      readCustomInstructions(),
      liked.length > 0
        ? ["What they prefer by default:", ...liked].join("\n")
        : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The block appended last to the system prompt of every loop that writes to
 * the user (a chat, a routine's run, a bot's or the phone's chat, a sub-agent),
 * or null when nothing is set or nobody is watching (`unattended`: a page the
 * run reads could ask for it back). Framed so the model can tell instruction
 * from context, and so it outranks older text in front of it, such as a
 * routine's saved report template. It cannot widen permissions (the gate
 * decides), and saying so keeps a refusal from reading as the rule failing.
 */
export function customInstructionsPrompt(unattended = false): string | null {
  if (unattended) return null;
  const text = readStandingInstructions();

  if (text.length === 0) return null;

  return [
    "The user's standing instructions, which they set for every conversation.",
    "Follow them in everything you write to or for the user: replies, routine",
    "reports, messages and emails you send for them, files you make, reactions.",
    "Where they disagree with the general guidance above about tone, format or",
    "how to approach work, these win. They also win over older text in front",
    "of you that says otherwise, such as a routine's saved instruction or",
    "report template, an example, or your own earlier replies: do that text's",
    "task, written the way these say. Only what the user asks in this",
    "conversation outranks them, for that request. They do not grant access:",
    "approvals and the permission mode still decide what may actually run.",
    "",
    text,
  ].join("\n");
}

const EMOJI_WORD = String.raw`(?:[eé]mojis?|[eé]moji's|emoticons?|smileys?|smilies)`;
/** Up to three words between the "no" and the emoji, each one that does not change the ban. */
const FILLER = (words: string): string => String.raw`(?:(?:${words})\s+){0,3}`;

/**
 * A ban on emojis, one pattern per language the app speaks: a "no" that
 * governs the word itself ("never use emojis", "keine Emojis", "絵文字は使わ
 * ないで"). A sentence that only has both words ("use emojis, never plain
 * bullets") or limits them ("don't overdo the emojis") is no ban; an unclear
 * rule still reaches the model in the block.
 */
const EMOJI_BANS: readonly RegExp[] = [
  // en
  new RegExp(
    String.raw`\b(?:no|not|never|don'?t|do not|without|avoid|stop|zero)\s+${FILLER("ever|use|using|send|sending|add|adding|put|putting|include|including|any|the|more|me|my|of|with|in|your")}${EMOJI_WORD}|${EMOJI_WORD}[- ]free\b`,
    "iu"
  ),
  // de
  new RegExp(
    String.raw`\b(?:keine?n?|nie(?:mals)?|ohne)\s+${FILLER("mehr|irgendwelche|benutzen|verwenden|die")}${EMOJI_WORD}`,
    "iu"
  ),
  // es
  new RegExp(
    String.raw`(?:^|[^\p{L}])(?:no|sin|nunca|nada de|ningún|ninguno)\s+${FILLER("uses|use|usar|utilices|pongas|poner|envíes|incluyas|me|más|los|las|ningún")}${EMOJI_WORD}`,
    "iu"
  ),
  // pt
  new RegExp(
    String.raw`(?:^|[^\p{L}])(?:não|nao|sem|nunca|nada de|nenhum)\s+${FILLER("use|usar|usa|coloque|colocar|mande|envie|inclua|me|mais|os|nenhum")}${EMOJI_WORD}`,
    "iu"
  ),
  // fr
  new RegExp(
    String.raw`(?:pas|jamais|sans|aucun)\s+(?:d'|de\s+|des\s+)?${EMOJI_WORD}`,
    "iu"
  ),
  // it
  new RegExp(
    String.raw`\b(?:niente|senza|nessun[oa]?|non\s+usare|mai)\s+${EMOJI_WORD}`,
    "iu"
  ),
  // nl
  new RegExp(String.raw`\b(?:geen|zonder|nooit)\s+${EMOJI_WORD}`, "iu"),
  // pl
  new RegExp(
    String.raw`(?:^|[^\p{L}])(?:bez|żadnych|nie\s+używaj)\s+${EMOJI_WORD}`,
    "iu"
  ),
  // tr: the "no" follows the word
  new RegExp(
    String.raw`${EMOJI_WORD}(?:ler|lar)?(?:i|ı|leri|ları)?\s+(?:kullanma|olmasın|koyma|yok)|\bemojisiz\b`,
    "iu"
  ),
  // id
  new RegExp(
    String.raw`\b(?:tanpa|jangan|tidak)\s+${FILLER("pakai|pake|gunakan|menggunakan|usah|ada")}${EMOJI_WORD}`,
    "iu"
  ),
  // ja
  /(?:絵文字|顔文字)(?:は|を|も)?\s*(?:一切)?(?:使わ|使用しない|使用禁止|禁止|なし|不要|使うな)/u,
  // zh
  /(?:不要|别|勿|禁止|不用|无需|請勿|请勿)\s*(?:使用|用|加|添加|发|發)?\s*(?:表情符号|表情符號|表情包|emoji)/iu,
  // ko
  /(?:이모지|이모티콘)(?:는|를|은|을|도)?\s*(?:(?:사용하|쓰|넣)지\s*마|금지|빼)/u,
];

/**
 * Whether the user's standing instructions ban emojis. The one style rule
 * with something to enforce outside the prompt: an emoji is a character a
 * saved template carries and a reaction is made of, and a model copies both
 * whatever it is told.
 */
export function standingInstructionsRuleOutEmoji(): boolean {
  return readStandingInstructions()
    .split(/[\n.!?;,。！？；，]+/u)
    .some((sentence) => EMOJI_BANS.some((ban) => ban.test(sentence)));
}

/**
 * An emoji with its joiners, modifiers and variation selector, and one space
 * after it; not ©, ® or ™. A keycap ("1️⃣") keeps its digit.
 */
const EMOJI =
  /(?![©®™])(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D|\p{Emoji_Modifier}|\p{Extended_Pictographic}|\p{Regional_Indicator})*[ \t]?|\uFE0F?\u20E3/gu;

/**
 * A routine's fire as its run is given it: a saved report template's emojis
 * end up in the report whatever the standing instructions say, so they are
 * taken out when those rule emojis out. Any other message is left alone.
 */
export function routineFireAsInstructed(
  text: string,
  tags?: UserTextTags
): string {
  if (tags?.routineFire !== true && !isRoutineFire(text)) return text;
  return standingInstructionsRuleOutEmoji() ? text.replace(EMOJI, "") : text;
}
