import { describe, expect, it } from "vitest";

import { promisesMoreWork } from "./promised-work.js";

const LONG_REPORT = `Here is what came of it. ${"Each row matched its source. ".repeat(30)}\n\n`;

describe("promisesMoreWork", () => {
  it.each([
    // The closing words decide, however long the reply is.
    ["en", `${LONG_REPORT}Starting the rebuild now.`],
    ["en", `${LONG_REPORT}Now reading them.`],
    ["en", "Let me work through the remaining ten pages."],
    ["en", "I'll read the config to find it."],
    ["en", "**Remaining:** two tabs. I'm on them now."],
    ["en", "Next: the visual pass. Carrying on."],
    ["en", "Page 2 is clean. Next: page-03."],
    ["en", "The sync is done. Continuing with page 2 onward."],
    ["en", "Let me get that ready, one sec!"],
    ["es", "**Sigo con el fichero 2.**"],
    ["es", `${LONG_REPORT}Ejecuto ahora.`],
    ["es", "Voy a revisar el archivo."],
    ["pt", "Vou analisar os dois repositórios."],
    ["pt", "Implementando agora."],
    ["tr", `${LONG_REPORT}Sıradaki: kimlik doğrulama. Devam ediyorum.`],
    ["tr", "Başlıyorum, 5 dakika."],
    ["fr", "Je vais vérifier le fichier."],
    ["fr", "Je continue."],
    ["de", "Ich mache jetzt weiter."],
    ["it", "Continuo con la fase due."],
    ["id", "Saya lanjutkan sekarang."],
    ["ru", "Теперь проверю файл."],
    ["zh", "我先看一下配置文件。"],
    ["ja", "このまま続けます。"],
    ["ko", "이어서 계속하겠습니다."],
    ["trailing markup", "Reading them now. 👍</reply>"],
  ])("a stall in %s: %s", (_language, reply) => {
    expect(promisesMoreWork(reply, true)).toBe(true);
  });

  it("reads a closing colon as a stall only mid-task", () => {
    const reply = "Applying the whole batch now, then the docs:";
    expect(promisesMoreWork(reply, true)).toBe(true);
    expect(promisesMoreWork("Here are a few ideas to start with:", false)).toBe(
      false
    );
  });

  it.each([
    // A question or a hand-back.
    "Should I read the rest now?",
    "Say go and I'll write the block.",
    "Tell me which you want and I'll start.",
    "Confirm and I'll continue tab by tab.",
    "If you'd rather I keep going, say so.",
    "Want me to start now?",
    "¿Quieres que siga?",
    "Si quieres, sigo con el fichero 2.",
    "Se quiser, vou continuar.",
    "Cevap verince başlıyorum.",
    "Istersen devam ediyorum.",
    // Waiting on something else, or on a later time.
    "I'll report back when the render finishes.",
    "I'll check again tomorrow morning.",
    "It's running in the background; I'll tell you once it's done.",
    "Vou aguardar o render fechar.",
    "Bitince sonucu getireceğim.",
    // A finished answer or a report.
    "Everything is working now.",
    "The bot is running now.",
    "Done: all three files are updated.",
    "All 12 tests pass.",
    "Dosya hazır.",
    "Te lo he dejado en la carpeta.",
    "Bu düzen iyi çalışıyor, devam edelim.",
    // The user is part of the next step, or it runs on its own.
    "I'll draft them, you send.",
    "I'll run this pass every morning at 8:00 from now on.",
    "Обновите страницу и попробуйте.",
    // Refusals and small talk.
    "I will not run that command.",
    "No voy a borrar nada.",
    "Thanks, happy to help!",
    "I'll be here.",
    // Words the promise patterns must not reach into.
    "Send the logo, and I'll build it.",
    "Top up, then I'll start.",
    "```\nI'll read it\n```",
    "Here's the link: https://example.com/start",
    "",
  ])("not a stall: %s", (reply) => {
    expect(promisesMoreWork(reply, true)).toBe(false);
  });
});
