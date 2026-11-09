/**
 * A reply in the wrong script is caught at the end of the turn.
 *
 * Reported as the Chief of Staff bot greeting in English and then, three
 * bubbles later, briefing in Chinese: the same model, drifting after a
 * run of tool results. The check is by script, on the last user message
 * against every assistant text after it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dominantScript,
  languageScript,
  RecentOwnWords,
  replyLanguageMismatch,
  replyLanguagePrompt,
  replyLanguageRepairPrompt,
  type KnownLanguage,
} from "./reply-language.js";
import {
  accountReplyLanguagePrompt,
  buildSetUserLanguageTool,
  knownReplyLanguage,
  learnUserLanguage,
  readUserLanguage,
  resolveReplyLanguage,
  writeUserLanguage,
} from "./user-language.js";
import { frameChannelMessage, ownWords } from "./user-text.js";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("dominantScript", () => {
  it("names the script most of the letters are in", () => {
    expect(dominantScript("Let me set up the daily routine for you now.")).toBe(
      "latin"
    );
    expect(
      dominantScript(
        "好了，Chief of Staff 已就位。我已在工作日安排你的每日简报"
      )
    ).toBe("cjk");
  });

  it("says nothing about a short text, or code", () => {
    expect(dominantScript("ok")).toBeNull();
    expect(
      dominantScript("```\nls -la /Users/me/.abacusai-bot/routines\n```")
    ).toBeNull();
  });
});

/** A run as `agent_end` gives it, judged by the person's words as the engine keeps them. */
const judge = (
  messages: readonly unknown[],
  recent: readonly string[] = [],
  known: KnownLanguage | null = null
) => {
  const words = new RecentOwnWords();
  for (const earlier of recent) {
    words.beginTurn(ownWords(earlier));
  }
  const last = [...messages]
    .reverse()
    .find((message) => (message as { role?: string }).role === "user") as
    | { content: string }
    | undefined;
  words.beginTurn(ownWords(last?.content ?? ""));
  return replyLanguageMismatch(messages, {
    turn: words.turn,
    recent: words.recent,
    known,
  });
};

const URDU_QUESTION = "کیا آپ مجھے کل کی میٹنگ کے بارے میں بتا سکتے ہیں";
const URDU_REPLY =
  "جی ہاں، کل صبح دس بجے آپ کی ٹیم کے ساتھ میٹنگ ہے اور اس کے بعد ایک کال ہے۔";
const ENGLISH_REPLY =
  "Yes, tomorrow at ten you have the team meeting, and a call right after it.";
const CHINESE_REPLY =
  "是的，明天上午十点你和团队有一个会议，会议结束后马上还有一个电话需要参加。";

describe("replyLanguageMismatch", () => {
  it("flags a Chinese reply to an English message", () => {
    expect(
      judge([
        user(
          "Introduce yourself once, then get started on your mission please."
        ),
        assistant("I'm Chief of Staff. Let me get oriented."),
        { role: "toolResult", content: "ok" },
        assistant(
          "好了，Chief of Staff 已就位。我已在工作日的每个工作日早上安排你的每日简报——它会查看你的日历、Gmail 和 Slack。现在有什么要我做的吗？"
        ),
      ])
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("lets a reply in the person's own script through", () => {
    expect(
      judge([
        user("请用中文介绍一下你自己，然后开始执行你的任务。"),
        assistant("好的，我是你的幕僚长。我已经安排了每日简报，现在就开始。"),
      ])
    ).toBeNull();
    expect(
      judge([
        user(
          "Introduce yourself once, then get started on your mission please."
        ),
        assistant(
          "I'm Chief of Staff. The routine is set for weekday mornings."
        ),
      ])
    ).toBeNull();
  });

  it("judges the last thing said, so English paragraphs ahead of the drift do not hide it", () => {
    expect(
      judge([
        user(
          "Introduce yourself once, then get started on your mission please."
        ),
        assistant(
          "I'm Chief of Staff. Before I do anything else, let me set up my morning routine: a weekday morning briefing that reviews your calendar, Gmail, and Slack."
        ),
        { role: "toolResult", content: "ok" },
        assistant(
          "好了，Chief of Staff 已就位。我已在工作日的每个工作日早上安排你的每日简报——它会查看你的日历、Gmail 和 Slack，并将结果分为三项返回。现在有什么要我做的吗？"
        ),
      ])
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("flags a Chinese reply whose English technical terms outnumber the prose", () => {
    // Han under 60% of the letters: the Han share alone still catches it.
    expect(
      judge(
        [
          user("is my github connected ?"),
          assistant(
            "是的——GitHub 已连接。✅\n\n" +
              "- **活跃账号:** `PranshuS007`（Pranshu Sharma），通过 token 认证\n" +
              "- **令牌权限范围:** `admin:org`、`project`、`repo`、`user`、`workflow`——因此私有仓库、PR 和 Issues 均可使用\n" +
              "- 你那里还有一个第二账号已登录但未激活: `pranshu-11`（keyring token）\n\n" +
              "所以 `gh` 和 git-over-HTTPS 已经可以使用了——直接告诉我你想在哪个仓库上做什么就行。"
          ),
        ],
        ["Can you check which accounts I have connected on this machine?"]
      )
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("lets English terms through in a reply to a user who writes in another script", () => {
    expect(
      judge([
        user("我的 GitHub 连接好了吗？"),
        assistant(
          "是的，GitHub 已连接。活跃账号是 PranshuS007，token 的权限范围包括 admin:org、repo、user 和 workflow，所以 gh 和 git over HTTPS 都可以直接使用。"
        ),
      ])
    ).toBeNull();
  });

  it("still flags a reply that drifted into Latin for a user who writes in another script", () => {
    expect(
      judge([
        user("请帮我看看今天的日程安排，然后告诉我有没有需要提前准备的会议。"),
        assistant(
          "You have three meetings today. The 3pm one references the Q3 deck, which needs a review before you join; the other two need nothing from you."
        ),
      ])
    ).toEqual({ expected: "cjk", got: "latin" });
  });

  it("judges a message as a whole, so a name in another script does not trip it", () => {
    expect(
      judge([
        user("Who messaged me on WhatsApp today, and what did they want?"),
        assistant(
          "Two people: 王伟 asked about the invoice, and Raj wants to move the standup to Thursday afternoon."
        ),
      ])
    ).toBeNull();
  });

  it("does not take a quote in the person's reply for drift", () => {
    // An English answer quoting an Arabic line: about a quarter of its letters.
    expect(
      judge([
        user("What does the sign in the photo I sent you say, exactly?"),
        assistant(
          'The sign says "مرحبا بكم في المدينة القديمة", which means welcome to the old city in English.'
        ),
      ])
    ).toBeNull();
  });

  it("does not judge the app's notes or a chat app's label as the person's words", () => {
    // A contact's short Urdu message under an English label, answered in Urdu.
    expect(
      judge([
        user(frameChannelMessage("WhatsApp message from Sam", "کیا حال ہے")),
        assistant(URDU_REPLY),
      ])
    ).toBeNull();
    const japanese =
      "こんにちは、太郎さん！今日の予定をお知らせします。午前十時に会議があります。";
    expect(
      judge([
        user(
          "[check-ins sent] Since the user's last message the app texted them: a reminder.\n\n今日の予定を教えてください"
        ),
        assistant(japanese),
      ])
    ).toBeNull();
    expect(
      judge([
        user(
          "hola, ¿qué tengo hoy en el calendario?\n\n<system_reminder>\nMessaging platforms connected (1): discord\n</system_reminder>"
        ),
        assistant(
          "Hoy tienes dos reuniones por la mañana y una llamada a las cuatro."
        ),
      ])
    ).toBeNull();
  });

  it("makes no judgement without words of theirs: a routine, a first run, too little to go by", () => {
    const routine =
      '[routine] "Brief" fired on schedule at 9:00.\n\nSummarise my inbox.';
    expect(judge([user(routine), assistant(URDU_REPLY)])).toBeNull();
    expect(
      judge([
        user("[first run] Introduce yourself once."),
        assistant(URDU_REPLY),
      ])
    ).toBeNull();
    expect(judge([user("hi"), assistant(URDU_REPLY)])).toBeNull();
  });

  it("knows the person by their recent turns, so one short Latin word decides nothing", () => {
    expect(
      judge([user("ok"), assistant(URDU_REPLY)], [URDU_QUESTION])
    ).toBeNull();
    // A short message in a known English chat still catches drift.
    expect(
      judge(
        [user("whats in it ?"), assistant(CHINESE_REPLY)],
        ["Please open the quarterly report and summarise it for me."]
      )
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("lets a pasted text's script through, and a language the person named", () => {
    expect(
      judge([
        user(`what does this mean? ${URDU_QUESTION}`),
        assistant(URDU_REPLY),
      ])
    ).toBeNull();
    expect(
      judge([
        user("Translate this into Urdu for my aunt: we will arrive on Friday."),
        assistant(
          "ہم جمعہ کو پہنچیں گے، انشاءاللہ۔ آپ سے ملنے کا بہت انتظار ہے۔"
        ),
      ])
    ).toBeNull();
  });

  it("lets the saved language's script through whatever the message is in", () => {
    // Chosen, or learnt from a user who types Urdu in Latin letters.
    for (const chosen of [true, false])
      expect(
        judge(
          [
            user("kal ki meeting ke baare mein batao zara, kitne baje hai"),
            assistant(URDU_REPLY),
          ],
          [],
          { script: "arabic", chosen }
        )
      ).toBeNull();
    expect(
      judge(
        [
          user("Can you tell me about tomorrow's meeting please?"),
          assistant(URDU_REPLY),
        ],
        [],
        { script: "arabic", chosen: true }
      )
    ).toBeNull();
  });

  it("lets earlier English back a short message in another script, and never a learnt English", () => {
    // A short "thanks" in Russian after English turns: an English reply stands.
    expect(
      judge(
        [user("Спасибо"), assistant(ENGLISH_REPLY)],
        ["Please open the quarterly report and summarise it for me."]
      )
    ).toBeNull();
    expect(
      judge([user(URDU_QUESTION), assistant(ENGLISH_REPLY)], [], {
        script: "latin",
        chosen: false,
      })
    ).toEqual({ expected: "arabic", got: "latin" });
    // English they chose is theirs to get.
    expect(
      judge([user(URDU_QUESTION), assistant(ENGLISH_REPLY)], [], {
        script: "latin",
        chosen: true,
      })
    ).toBeNull();
  });

  it("catches real drift both ways", () => {
    expect(judge([user(URDU_QUESTION), assistant(ENGLISH_REPLY)])).toEqual({
      expected: "arabic",
      got: "latin",
    });
    expect(
      judge([
        user("Can you tell me about tomorrow's meeting please?"),
        assistant(CHINESE_REPLY),
      ])
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("lets a language typed in Latin letters come back in its own script once it is saved", () => {
    // Bengali typed in Latin letters: detection saved Bengali from their words.
    const bengali = [
      user("amar kalker meeting kokhon ache bolo to ektu"),
      assistant("আপনার আগামীকালের মিটিং সকাল দশটায়, তারপরেই একটা কল আছে।"),
    ];
    expect(judge(bengali, [], { script: "bengali", chosen: false })).toBeNull();
    expect(judge(bengali)).toEqual({ expected: "latin", got: "bengali" });
  });

  it("catches a Latin writer's reply drifting into another script", () => {
    // They chose English: a Devanagari reply is drift, never the app picking Hindi.
    expect(
      judge(
        [
          user("Can you tell me about tomorrow's meeting please?"),
          assistant(
            "हाँ, कल सुबह दस बजे आपकी टीम के साथ मीटिंग है और उसके बाद एक कॉल है।"
          ),
        ],
        [],
        { script: "latin", chosen: true }
      )
    ).toEqual({ expected: "latin", got: "devanagari" });
    expect(
      judge([
        user("Can you tell me about tomorrow's meeting please?"),
        assistant(
          "Да, завтра в десять у вас встреча с командой, а сразу после неё звонок."
        ),
      ])
    ).toEqual({ expected: "latin", got: "cyrillic" });
  });

  it.each([
    ["Bengali", "আগামীকাল আমার কী কী মিটিং আছে বলতে পারবেন", "bengali"],
    ["Tamil", "நாளை எனக்கு என்னென்ன கூட்டங்கள் உள்ளன சொல்லுங்கள்", "tamil"],
    ["Gurmukhi", "ਕੀ ਤੁਸੀਂ ਮੈਨੂੰ ਕੱਲ੍ਹ ਦੀ ਮੀਟਿੰਗ ਬਾਰੇ ਦੱਸ ਸਕਦੇ ਹੋ", "gurmukhi"],
    [
      "Hindi, mirrored like any language",
      "क्या आप मुझे कल की मीटिंग के बारे में बता सकते हैं",
      "devanagari",
    ],
  ] as const)("catches an English reply to %s", (_label, message, script) => {
    expect(judge([user(message), assistant(ENGLISH_REPLY)])).toEqual({
      expected: script,
      got: "latin",
    });
  });
});

describe("RecentOwnWords", () => {
  it("keeps steered words with the turn, and earlier turns apart", () => {
    const words = new RecentOwnWords();
    words.beginTurn("first");
    words.add("more");
    words.beginTurn("");
    words.beginTurn("third");
    expect(words.turn).toBe("third");
    expect(words.recent).toEqual(["first\n\nmore"]);
    words.clear();
    expect([words.turn, words.recent]).toEqual(["", []]);
  });

  it("judges a resumed session as the live one did", () => {
    const transcript = [
      user(
        frameChannelMessage(
          "WhatsApp message from Sam",
          "Please open the quarterly report and summarise it for me."
        )
      ),
      assistant("Here is the summary of the quarterly report."),
      user('[routine] "Brief" fired on schedule.\n\nSummarise.'),
      assistant("Done."),
    ];
    const resumed = new RecentOwnWords();
    resumed.seed(transcript, (text) => ownWords(text));
    expect(resumed.recent).toEqual([
      "Please open the quarterly report and summarise it for me.",
    ]);
    resumed.beginTurn("whats in it ?");
    const run = [user("whats in it ?"), assistant(CHINESE_REPLY)];
    expect(
      replyLanguageMismatch(run, { turn: resumed.turn, recent: resumed.recent })
    ).toEqual({ expected: "latin", got: "cjk" });
    // Without the carried words the same run has too little to judge.
    expect(
      replyLanguageMismatch(run, { turn: "whats in it ?", recent: [] })
    ).toBeNull();
  });
});

describe("languageScript", () => {
  it.each([
    ["Urdu", "arabic"],
    ["Persian", "arabic"],
    ["Russian", "cyrillic"],
    ["Bangla", "bengali"],
    ["Bengali", "bengali"],
    ["Tamil", "tamil"],
    ["Hindi", "devanagari"],
    ["Japanese", "cjk"],
    ["Brazilian Portuguese", "latin"],
    ["Klingonese", null],
  ] as const)("writes %s in %s", (name, script) => {
    expect(languageScript(name)).toBe(script);
  });
});

describe("the reply-language prompt line", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const REQUEST =
    'When the user asks for a reply language ("answer in English", "reply in Turkish", in whatever ' +
    "language they ask it), that request wins over all of this: switch at once, and keep to it from " +
    "then on unless they asked for that one reply only.";

  it("names the user's language, sets the app's notes apart, lets an explicit request win, and names the Chinese leak", () => {
    expect(replyLanguagePrompt({ name: "Turkish", chosen: false })).toBe(
      [
        "## Reply language",
        "",
        "The user's language is Turkish. Reply in the language of the user's latest message; " +
          'when it has no words to go by (a greeting like "ok", a link), reply in Turkish. The app\'s ' +
          "own messages (a [first run] or [routine] note, a system reminder) are not the user's words: " +
          "answer them in Turkish. " +
          REQUEST +
          " Write the whole reply in that one language and its script: never switch partway, and " +
          "never mix in words or characters from another language (no Chinese characters in a " +
          "Turkish reply), whatever language the tool results, documents or messages you read were " +
          "in. Names, code and quoted text stay as they are.",
      ].join("\n")
    );
    for (const name of ["Brazilian Portuguese", "Spanish"]) {
      const line = flat(replyLanguagePrompt({ name, chosen: false }));
      expect(line).toContain(`The user's language is ${name}.`);
      expect(line).toContain(`answer them in ${name}.`);
      expect(line).toContain(`(no Chinese characters in a ${name} reply)`);
    }
    expect(replyLanguagePrompt({ name: "English", chosen: false })).toContain(
      "(no Chinese characters in an English reply)"
    );
  });

  it("never refuses or remaps a language, Hindi included", () => {
    for (const chosen of [false, true])
      for (const sender of [false, true])
        expect(
          replyLanguagePrompt({ name: "Turkish", chosen }, sender)
        ).not.toMatch(/hindi/i);
  });

  it("speaks of the person writing in a sender chat, with the user's language as the fallback", () => {
    const sender = flat(
      replyLanguagePrompt({ name: "Turkish", chosen: false }, true)
    );
    expect(sender).toContain(
      "The person writing to you here is not the user. Reply in the language of their latest message;"
    );
    expect(sender).toContain("reply in Turkish, the user's language.");
    expect(sender).toContain(
      "When the person writing asks for a reply language"
    );
    expect(sender).not.toContain("The user's language is");
  });

  it("drops the Chinese clause when the fallback itself writes Han", () => {
    const japanese = replyLanguagePrompt({ name: "Japanese", chosen: false });
    expect(japanese).toContain("The user's language is Japanese.");
    expect(japanese).not.toMatch(/Chinese characters/);
    expect(japanese).toContain(
      "never mix in words or characters from another language, whatever language"
    );
  });

  it("puts a language the user chose ahead of their message, and a new request ahead of that", () => {
    const chosen = replyLanguagePrompt({ name: "Turkish", chosen: true });
    expect(chosen).toContain(
      "The user chose Turkish for every reply: reply in Turkish, whatever language their message or the app's own notes are in."
    );
    expect(chosen).toContain(REQUEST);
    expect(chosen).not.toContain("latest message");
    expect(chosen).toContain("(no Chinese characters in a Turkish reply)");
  });

  it("carries nothing per turn: the same language gives the same bytes", () => {
    const one = replyLanguagePrompt({ name: "Turkish", chosen: false });
    expect(replyLanguagePrompt({ name: "Turkish", chosen: false })).toBe(one);
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
  });

  it("keeps a sender's rewrite inside the reply tag", () => {
    const mismatch = { expected: "arabic", got: "latin" } as const;
    expect(replyLanguageRepairPrompt(mismatch, true)).toContain(
      "inside <reply></reply>"
    );
    expect(replyLanguageRepairPrompt(mismatch)).not.toContain("<reply>");
  });
});

describe("which language replies fall back to", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "reply-language-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    vi.stubEnv("ABACUSAI_BOT_LOCALE", "");
    vi.stubEnv("ABACUSAI_BOT_SENDER_CHAT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const chosen = { name: "Turkish", source: "user" } as const;
  const detected = { name: "Spanish", source: "detected" } as const;

  it.each([
    [
      "the user's choice over everything",
      chosen,
      "pt-BR",
      false,
      "Turkish",
      true,
    ],
    [
      "the detected language over the app's",
      detected,
      "pt-BR",
      false,
      "Spanish",
      false,
    ],
    [
      "the app's language with nothing saved",
      null,
      "pt-BR",
      false,
      "Brazilian Portuguese",
      false,
    ],
    ["a bare app tag", null, "tr", false, "Turkish", false],
    ["Chinese in Taiwan", null, "zh-TW", false, "Traditional Chinese", false],
    [
      "Chinese in Hong Kong",
      null,
      "zh-HK",
      false,
      "Traditional Chinese",
      false,
    ],
    [
      "a script past a region",
      null,
      "zh-Hans-HK",
      false,
      "Simplified Chinese",
      false,
    ],
    ["bare Chinese", null, "zh", false, "Simplified Chinese", false],
    ["Chinese in China", null, "zh-CN", false, "Simplified Chinese", false],
    [
      "a regional tag the UI does not ship",
      null,
      "bn-BD",
      false,
      "Bangla",
      false,
    ],
    [
      "a regional tag reads as its language",
      null,
      "tr-TR",
      false,
      "Turkish",
      false,
    ],
    ["English with nothing at all", null, undefined, false, "English", false],
    [
      "English for a tag that names no language",
      null,
      "xx",
      false,
      "English",
      false,
    ],
    [
      "a sender's chat: the choice is only the fallback",
      chosen,
      "pt-BR",
      true,
      "Turkish",
      false,
    ],
  ] as const)(
    "resolves %s",
    (_label, saved, locale, sender, name, isChosen) => {
      expect(resolveReplyLanguage(saved, locale, sender)).toEqual({
        name,
        chosen: isChosen,
      });
    }
  );

  it("never picks Hindi on its own, and mirrors a user who writes or asks for it", () => {
    const english = { name: "English", chosen: false };
    expect(resolveReplyLanguage(null, "hi-IN")).toEqual(english);
    expect(resolveReplyLanguage(null, "hi")).toEqual(english);
    vi.stubEnv("ABACUSAI_BOT_LOCALE", "hi-IN");
    expect(accountReplyLanguagePrompt()).toContain(
      "The user's language is English."
    );
    // Learnt from what they typed, or asked for: Hindi it is.
    expect(
      resolveReplyLanguage({ name: "Hindi", source: "detected" }, "hi-IN")
    ).toEqual({ name: "Hindi", chosen: false });
    writeUserLanguage("Hindi", "user");
    expect(readUserLanguage()).toEqual({ name: "Hindi", source: "user" });
    expect(accountReplyLanguagePrompt()).toContain(
      "The user chose Hindi for every reply"
    );
    expect(knownReplyLanguage()).toEqual({
      script: "devanagari",
      chosen: true,
    });
    // A sender is someone else: the user's language says nothing of them.
    vi.stubEnv("ABACUSAI_BOT_SENDER_CHAT", "1");
    expect(knownReplyLanguage()).toBeNull();
  });

  it("saves set_user_language's Hindi as Hindi", async () => {
    const result = await buildSetUserLanguageTool().execute("t1", {
      language: "Hindi",
    });
    expect(result.isError).toBeUndefined();
    expect(readUserLanguage()).toEqual({ name: "Hindi", source: "user" });
  });

  it("forgets once a language detected before own-words detection, keeping a chosen one", () => {
    const file = path.join(home, "user-language.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ language: { name: "English", source: "detected" } })
    );
    expect(readUserLanguage()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ attempts: 3 }));
    expect(readUserLanguage()).toBeNull();
    fs.writeFileSync(
      file,
      JSON.stringify({ language: { name: "Turkish", source: "user" } })
    );
    expect(readUserLanguage()).toEqual({ name: "Turkish", source: "user" });
    // Learnt again, it stays.
    writeUserLanguage("Urdu", "detected");
    expect(readUserLanguage()).toEqual({ name: "Urdu", source: "detected" });
  });

  it("reads the app's language from ABACUSAI_BOT_LOCALE, and the saved one over it", () => {
    vi.stubEnv("ABACUSAI_BOT_LOCALE", "tr-TR");
    expect(accountReplyLanguagePrompt()).toContain(
      "The user's language is Turkish."
    );
    writeUserLanguage("Spanish", "detected");
    expect(accountReplyLanguagePrompt()).toContain(
      "The user's language is Spanish."
    );
    writeUserLanguage("German", "user");
    expect(accountReplyLanguagePrompt()).toContain(
      "The user chose German for every reply"
    );
    // Switching back is the same tool call again.
    writeUserLanguage("Turkish", "user");
    expect(accountReplyLanguagePrompt()).toContain(
      "The user chose Turkish for every reply"
    );
    vi.stubEnv("ABACUSAI_BOT_SENDER_CHAT", "1");
    expect(accountReplyLanguagePrompt()).toContain(
      "The person writing to you here is not the user."
    );
    expect(accountReplyLanguagePrompt()).toContain(
      "reply in Turkish, the user's language."
    );
  });

  const detector = (answer: string) =>
    vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: answer } }] })
        )
    );
  const sentText = (fetchImpl: ReturnType<typeof detector>): string =>
    JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).messages[0].content;

  it("never learns the language from a first run or other app-only turn", async () => {
    const fetchImpl = detector("English");
    const firstRun =
      "[first run] Introduce yourself once, then get started.\n\n<system_reminder>\nConnected: Gmail\n</system_reminder>";
    for (const turn of [firstRun, '[routine] "Brief" fired.\n\nGo.'])
      await learnUserLanguage(
        ownWords(turn),
        "key",
        fetchImpl as unknown as typeof fetch
      );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readUserLanguage()).toBeNull();
  });

  it("sends only the person's words, and saves what their typing names", async () => {
    const fetchImpl = detector("Turkish");
    const editor = [
      'You are the editor for the routine "Brief" (id r1).',
      "Then answer in one short line.",
      "",
      "The user says: her sabah dokuzda çalıştır",
    ].join("\n");
    await learnUserLanguage(
      ownWords(editor),
      "key",
      fetchImpl as unknown as typeof fetch
    );
    expect(sentText(fetchImpl)).toMatch(
      /Message:\nher sabah dokuzda çalıştır$/
    );
    expect(readUserLanguage()).toEqual({ name: "Turkish", source: "detected" });
  });
});
