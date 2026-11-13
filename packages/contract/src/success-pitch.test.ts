import { describe, expect, it } from "vitest";

import { isStuckMessage } from "./retry-offer";
import { markClosed, markThing } from "./site-deploy";
import {
  commandFolder,
  isBigBuild,
  isCleanReply,
  isLongRunningCommand,
  KEEP_RUNNING_CAPS,
  rememberOffered,
  isComplaint,
  isPositiveReaction,
  isPositiveReactionEmoji,
  mainlyInChatApps,
  SUCCESS_PITCH_GAP_MS,
  successPitchAllowed,
  underHalfOfFreeCredits,
} from "./success-pitch";

describe("isPositiveReaction", () => {
  it.each([
    "thanks",
    "Thank you!",
    "thank you so much, this is amazing",
    "Perfect 👌",
    "great job",
    "wow",
    "Obrigado!",
    "obrigada, ficou incrível",
    "valeu",
    "Perfeito, deu certo",
    "harika olmuş, çok teşekkürler!",
    "Teşekkürler",
    "süper",
    "eline sağlık",
    "gracias!!",
    "genial",
    "merci beaucoup",
    "danke",
    "grazie mille",
    "terima kasih",
    "ありがとうございます",
    "감사합니다",
    "👍",
    "🙏🙏",
    "🔥🔥🔥",
    "❤️",
  ])("praise: %s", (text) => {
    expect(isPositiveReaction(text)).toBe(true);
  });

  it.each([
    // A complaint after the praise.
    "thanks but it's broken",
    "thanks, it doesn't work",
    "thank you, still not working",
    "obrigado mas não funcionou",
    "valeu, mas ainda dá erro",
    "teşekkürler ama çalışmıyor",
    "harika ama hata veriyor",
    "gracias pero no funciona",
    "merci mais il y a une erreur",
    // A question, or another request after the praise.
    "thanks! can you also add a contact form?",
    "great, but make it blue",
    "deu certo?",
    // Not a reaction.
    "no thanks",
    "hayır teşekkürler, değil",
    "nenhum deu certo",
    "siktir et hallettim ben",
    "would be nice if it worked",
    "make me a site for my bakery",
    "",
    "   ",
    "👎",
    // Praise that only comes late in a long message is a new request.
    "I need you to look at the invoice folder and pull every receipt from last month into one sheet, thanks",
    "thanks ".repeat(40),
  ])("not praise: %s", (text) => {
    expect(isPositiveReaction(text)).toBe(false);
  });
});

describe("isComplaint", () => {
  it.each([
    "it doesn't work",
    "the button is broken",
    "still the same error",
    "não funcionou",
    "ainda está com erro",
    "çalışmıyor",
    "olmadı",
    "no funciona",
    "es funktioniert nicht",
    "where is the file",
  ])("complaint: %s", (text) => {
    expect(isComplaint(text)).toBe(true);
  });

  it.each([
    "thanks!",
    "now add a contact form",
    "can you make the header blue?",
    "teşekkürler, şimdi bir de logo ekle",
  ])("not a complaint: %s", (text) => {
    expect(isComplaint(text)).toBe(false);
  });
});

describe("isPositiveReactionEmoji", () => {
  it("counts praise emoji, not the rest", () => {
    expect(isPositiveReactionEmoji("👍")).toBe(true);
    expect(isPositiveReactionEmoji("❤️")).toBe(true);
    expect(isPositiveReactionEmoji("🙏")).toBe(true);
    expect(isPositiveReactionEmoji("😢")).toBe(false);
    expect(isPositiveReactionEmoji("👀")).toBe(false);
  });
});

describe("isCleanReply", () => {
  it("a reply that ends by offering more, or a short one, is clean", () => {
    expect(
      isCleanReply(
        "Your todo app is ready. Want me to add due dates, or multiple lists?"
      )
    ).toBe(true);
    expect(isCleanReply("Done.")).toBe(true);
  });

  it("a reply that says it failed is not", () => {
    expect(isCleanReply("I couldn't start the server, the port is busy.")).toBe(
      false
    );
    expect(isCleanReply("Não consegui abrir o arquivo.")).toBe(false);
    expect(
      isCleanReply("Honestly: the file still does not open in Excel.")
    ).toBe(false);
    expect(isCleanReply("El archivo todavía no abre en Excel.")).toBe(false);
    expect(isCleanReply("لم أتمكن من ترجمة الملف كاملاً.")).toBe(false);
  });
});

describe("isStuckMessage", () => {
  it.each([
    "it still doesn't work",
    "this is rubbish",
    "you did not make the actual design",
    "the file won't open",
    "el archivo no abre en excel",
    "inventaste cosas",
    "o arquivo não abre",
    "bu hesap yanlış",
    "das sieht schlecht aus",
    "ما يشتغل",
    "ترجمة حرفية",
    "опять ошибка",
    "не працює",
    "nie działa",
    "det virker ikke",
    "werkt niet",
    "לא עובד",
    "まだ動かない",
    "打不开",
  ])("stuck: %s", (text) => {
    expect(isStuckMessage(text)).toBe(true);
  });

  it.each([
    "thanks!",
    "now add a contact form",
    "can you make the header blue?",
    "agora traduza para inglês",
    "شكرا، الآن أضف شعار",
    "спасибо, теперь добавь логотип",
    "x".repeat(301) + " doesn't work",
  ])("not stuck: %s", (text) => {
    expect(isStuckMessage(text)).toBe(false);
  });
});

describe("successPitchAllowed", () => {
  const now = 10 * SUCCESS_PITCH_GAP_MS;
  const card = (shown: number, lastShownAt: number | null, notNow = 0) => ({
    shown,
    lastShownAt,
    notNow,
    shownOffer: null,
    answered: null,
  });

  it("allows the first pitch", () => {
    expect(successPitchAllowed(undefined, undefined, now)).toBe(true);
  });

  it("waits three days after the last one", () => {
    expect(successPitchAllowed(card(1, now - 60_000), undefined, now)).toBe(
      false
    );
    expect(
      successPitchAllowed(
        card(1, now - SUCCESS_PITCH_GAP_MS + 1),
        undefined,
        now
      )
    ).toBe(false);
    expect(
      successPitchAllowed(card(1, now - SUCCESS_PITCH_GAP_MS), undefined, now)
    ).toBe(true);
  });

  it("stops after three ever", () => {
    expect(successPitchAllowed(card(2, 0), undefined, now)).toBe(true);
    expect(successPitchAllowed(card(3, 0), undefined, now)).toBe(false);
  });

  it("stops for good after two Not nows", () => {
    expect(successPitchAllowed(card(1, 0, 1), undefined, now)).toBe(true);
    expect(successPitchAllowed(card(2, 0, 2), undefined, now)).toBe(false);
  });

  it("counts the chat-app line as a show, with its own time", () => {
    expect(successPitchAllowed(card(2, 0), { chatToldAt: 0 }, now)).toBe(false);
    expect(
      successPitchAllowed(undefined, { chatToldAt: now - 1_000 }, now)
    ).toBe(false);
    expect(successPitchAllowed(undefined, { chatToldAt: 0 }, now)).toBe(true);
  });
});

describe("underHalfOfFreeCredits", () => {
  it("is under half, and unknown is not", () => {
    expect(underHalfOfFreeCredits(999, 2000)).toBe(true);
    expect(underHalfOfFreeCredits(1000, 2000)).toBe(false);
    expect(underHalfOfFreeCredits(null, 2000)).toBe(false);
    expect(underHalfOfFreeCredits(0, 0)).toBe(false);
  });
});

describe("mainlyInChatApps", () => {
  it("is more own chat-app turns than app turns", () => {
    expect(mainlyInChatApps({ appTurns: 2, chatTurns: 3 })).toBe(true);
    expect(mainlyInChatApps({ appTurns: 3, chatTurns: 3 })).toBe(false);
    expect(mainlyInChatApps(undefined)).toBe(false);
  });
});

describe("a big build", () => {
  it("is fifteen distinct files", () => {
    expect(isBigBuild(14)).toBe(false);
    expect(isBigBuild(15)).toBe(true);
  });
});

describe("something meant to stay on", () => {
  it.each([
    "python bot.py",
    "cd btc-bot && python bot.py",
    "npm run dev",
    "npm start",
    "node server.js",
    "cd app && npx serve -l 3000",
    "uvicorn main:app --port 8000",
  ])("keeps running: %s", (command) => {
    expect(isLongRunningCommand(command)).toBe(true);
  });

  it.each([
    "npm install",
    "npm i express",
    "pnpm add zod",
    "cd app && npm run build",
    "npm test",
    "pytest -q",
    "sleep 30",
    "pip install -r requirements.txt",
    "git clone https://example.com/repo",
    "cd app",
  ])("one-off: %s", (command) => {
    expect(isLongRunningCommand(command)).toBe(false);
  });

  it("reads a leading cd as the folder", () => {
    expect(commandFolder("cd btc-bot && python bot.py")).toBe("btc-bot");
    expect(commandFolder('cd "my bot" && npm start')).toBe("my bot");
    expect(commandFolder("python bot.py")).toBeNull();
  });

  it("is remembered as offered once, newest last, the oldest dropped", () => {
    let list: string[] = [];
    for (let index = 0; index < 25; index += 1)
      list = rememberOffered(list, `t${index}`);
    expect(list).toHaveLength(20);
    expect(rememberOffered(list, "t10").at(-1)).toBe("t10");
    expect(rememberOffered(list, "t10")).toHaveLength(20);
  });

  it("has its own budget: one a day, three ever, two Not nows", () => {
    const day = 24 * 60 * 60 * 1000;
    const card = (shown: number, lastShownAt: number, notNow = 0) => ({
      shown,
      lastShownAt,
      notNow,
      shownOffer: null,
      answered: null,
    });
    const now = 10 * day;
    expect(
      successPitchAllowed(
        card(1, now - day + 1),
        undefined,
        now,
        KEEP_RUNNING_CAPS
      )
    ).toBe(false);
    expect(
      successPitchAllowed(card(1, now - day), undefined, now, KEEP_RUNNING_CAPS)
    ).toBe(true);
    expect(
      successPitchAllowed(card(3, 0), undefined, now, KEEP_RUNNING_CAPS)
    ).toBe(false);
    expect(
      successPitchAllowed(card(1, 0, 2), undefined, now, KEEP_RUNNING_CAPS)
    ).toBe(false);
  });

  it("a closed card stays closed for its thing, and for a turn an older build closed", () => {
    const mark = {
      turnId: "turn-2",
      siteDir: "/w/bot",
      at: 1,
      kind: "server" as const,
      name: "bot",
    };
    expect(markThing(mark)).toBe("server:/w/bot");
    expect(markThing({ turnId: "t", siteDir: "/w/site", at: 1 })).toBe(
      "site:/w/site"
    );
    expect(markClosed("server:/w/bot", { ...mark, turnId: "turn-9" })).toBe(
      true
    );
    expect(markClosed("turn-2", mark)).toBe(true);
    expect(markClosed("turn-1", mark)).toBe(false);
    expect(markClosed(undefined, mark)).toBe(false);
  });
});
