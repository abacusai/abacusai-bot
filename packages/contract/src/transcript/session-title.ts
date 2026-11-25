import { Lexer, type Token } from "marked";

/**
 * The words a token shows, as CommonMark reads it: a code span keeps its
 * literal content, a link or image becomes its text, emphasis loses only
 * the marks that pair up, and anything that is not Markdown syntax (an
 * intraword `_`, a lone `*`, `2**10`) stays as typed.
 */
const plainText = (token: Token): string => {
  switch (token.type) {
    case "codespan":
    case "escape":
      return token.text;
    case "br":
      return " ";
    case "html":
      return token.raw;
    case "image":
      return token.text;
    case "list":
      return token.items.map(plainText).join(" ");
    case "checkbox":
    case "code":
    case "space":
    case "hr":
    case "def":
      return "";
    default:
      return "tokens" in token && token.tokens != null
        ? token.tokens.map(plainText).join("")
        : "text" in token && typeof token.text === "string"
          ? token.text
          : token.raw;
  }
};

/** One line of the opening message as the chat shows it: Markdown read, never stripped by pattern. */
const plainLine = (line: string): string =>
  new Lexer({ gfm: true })
    .lex(line)
    .map(plainText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The title of a chat named from its opening message: the first line with
 * words, as plain text (chat names are plain wherever they show), clipped
 * to 60 characters as the pre-rewrite session composer did.
 */
export const generateSessionTitle = (message: string): string => {
  const firstLine =
    message
      .split("\n")
      .map((line) => (line.trim() === "" ? "" : plainLine(line)))
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > 60
    ? `${firstLine.slice(0, 57).trimEnd()}…`
    : firstLine;
};
