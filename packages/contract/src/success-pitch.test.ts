import { describe, expect, it } from "vitest";

import {
  isCleanReply,
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
