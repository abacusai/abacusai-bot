/**
 * A port of the server's deny-check for check-in texts and agenda
 * summaries: the rule a text breaks, or null. The server drops an agenda
 * item whose summary breaks one, so every summary shape the host builds is
 * run through this in its tests. Spaces, dashes, dots and slashes between
 * digits count as separators.
 */

const OTP_KEYWORDS = [
  "otp",
  "code",
  "codes",
  "pin",
  "password",
  "passcode",
  "verification",
  "código",
  "codigo",
  "contraseña",
  "senha",
  "clave",
  "mot de passe",
  "passwort",
  "kode",
  "kata sandi",
  "пароль",
  "код",
  "验证码",
  "密码",
  "驗證碼",
  "رمز",
  "كلمة المرور",
  "パスワード",
  "認証コード",
  "인증번호",
  "비밀번호",
  "ओटीपी",
  "पासवर्ड",
  "कोड",
  "şifre",
  "kod",
  "mã",
  "mật khẩu",
  "รหัส",
];
const PAYMENT_KEYWORDS = [
  "card",
  "card number",
  "cvv",
  "cvc",
  "expiry",
  "bank details",
  "tarjeta",
  "cartão",
  "cartao",
  "carte",
  "karte",
  "kartu",
  "карта",
  "карты",
  "银行卡",
  "信用卡",
  "بطاقة",
  "カード",
  "카드",
  "कार्ड",
  "kart",
  "thẻ",
  "บัตร",
];
const REQUEST_VERBS = [
  "send",
  "share",
  "tell",
  "give",
  "reply with",
  "type",
  "enter",
  "provide",
  "envía",
  "envíe",
  "envia",
  "envíame",
  "enviame",
  "manda",
  "mande",
  "mándame",
  "mandame",
  "dame",
  "pásame",
  "comparte",
  "compartilhe",
  "me envie",
  "me manda",
  "dime",
  "diga",
  "informe",
  "digite",
  "ingresa",
  "envoyez",
  "envoie",
  "donne",
  "partagez",
  "schick",
  "sende",
  "nenne",
  "kirim",
  "berikan",
  "отправь",
  "отправьте",
  "пришли",
  "пришлите",
  "скажи",
  "сообщите",
  "发送",
  "告诉",
  "提供",
  "أرسل",
  "ارسل",
  "送って",
  "教えて",
  "보내",
  "알려",
  "भेजें",
  "भेजो",
  "बताएं",
  "gönder",
  "söyle",
  "gửi",
  "cho tôi",
  "ส่ง",
];
const ALLOWED_LINK_HOSTS = ["abacus.ai"];
const MAX_SUMMARY_CHARS = 200;

const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
const DIGIT_SEPARATORS_RE = /(?<=\d)[\s./-]+(?=\d)/g;
const ID_TOKEN_RE = /[A-Za-z0-9_-]{16,}/g;
const DOCUMENT_NUMBER_RE =
  /^(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|[A-Z]{5}\d{4}[A-Z]|[A-Z]{1,2}\d{6,9})$/;

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Latin, Cyrillic and Greek words match whole; other scripts as substrings. */
const keywordRe = (keywords: readonly string[]): RegExp =>
  new RegExp(
    keywords
      .map((word) =>
        [...word].every((char) => char.codePointAt(0)! < 0x0600)
          ? `(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`
          : escape(word)
      )
      .join("|"),
    "iu"
  );

const luhn = (digits: string): boolean => {
  let total = 0;
  [...digits].reverse().forEach((char, index) => {
    const value = Number(char) * (index % 2 ? 2 : 1);
    total += value > 9 ? value - 9 : value;
  });
  return total % 10 === 0;
};

const allowedLink = (url: string): boolean => {
  let host = "";
  try {
    host = new URL(url.includes("//") ? url : `https://${url}`).hostname;
  } catch {
    return false;
  }
  return ALLOWED_LINK_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
};

export function refusedTextRule(
  text: string,
  maxChars = MAX_SUMMARY_CHARS
): string | null {
  if (text.length > maxChars) return "too_long";
  const joined = text.replace(DIGIT_SEPARATORS_RE, "");
  for (const run of joined.match(/\d{13,19}/g) ?? [])
    if (luhn(run)) return "card_number";
  if (/\d{6,}/.test(joined)) return "digit_run";
  if (
    (text.toUpperCase().match(/[A-Z0-9]+/g) ?? []).some((token) =>
      DOCUMENT_NUMBER_RE.test(token)
    )
  )
    return "document_number";
  const secretWords = keywordRe(OTP_KEYWORDS);
  for (const match of joined.matchAll(/(?<!\d)\d{4,5}(?!\d)/g)) {
    const start = Math.max(0, match.index - 30);
    if (
      secretWords.test(joined.slice(start, match.index + match[0].length + 30))
    )
      return "otp";
  }
  if (
    (text.match(ID_TOKEN_RE) ?? []).some(
      (token) => /[A-Za-z]/.test(token) && /\d/.test(token)
    )
  )
    return "id_like";
  for (const url of text.match(URL_RE) ?? [])
    if (!allowedLink(url)) return "external_link";
  const asks = new RegExp(keywordRe(REQUEST_VERBS).source, "giu");
  const secrets = keywordRe([...OTP_KEYWORDS, ...PAYMENT_KEYWORDS]);
  for (const match of text.matchAll(asks))
    if (
      secrets.test(
        text.slice(
          match.index + match[0].length,
          match.index + match[0].length + 40
        )
      )
    )
      return "asks_for_secret";
  return null;
}
