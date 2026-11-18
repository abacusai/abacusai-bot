/**
 * A new PDF goes through the document tool. The prompt says not to build one
 * by hand, and the desktop chat still did (a certificate with the user's
 * logo: its own HTML printed with weasyprint, 2 of 3 runs). A shell command
 * or script that makes a PDF is blocked with the way to do it; reading,
 * checking and converting what exists are not.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAKES_PDF =
  /\b(weasyprint|reportlab|wkhtmltopdf|xhtml2pdf|fpdf2?|pdfkit)\b|--print-to-pdf|\.write_pdf\(|\.pdf\(\s*(path\s*=|\{\s*path)/i;

/** A new deck made by script: python-pptx with no file, or pptxgenjs. */
const MAKES_DECK = /\bPresentation\(\s*\)|\bnew\s+(PptxGenJS|pptxgen)\s*\(/i;

const scriptText = (toolName: string, input: unknown): string | null => {
  const i = (input ?? {}) as {
    command?: unknown;
    content?: unknown;
    path?: unknown;
  };
  if (toolName === "bash") return String(i.command ?? "");
  if (
    toolName === "write" &&
    /\.(py|js|mjs|cjs|ts|sh)$/i.test(String(i.path ?? ""))
  )
    return String(i.content ?? "");
  return null;
};

export const handBuiltPdf = (toolName: string, input: unknown): boolean =>
  MAKES_PDF.test(scriptText(toolName, input) ?? "");

/**
 * Live (chat, "improve my presentation"): a new deck built with python-pptx,
 * so the ppt tool and its checks never ran. Opening the user's own file to
 * change something they named is not caught.
 */
export const handBuiltDeck = (toolName: string, input: unknown): boolean =>
  MAKES_DECK.test(scriptText(toolName, input) ?? "");

/** Registered where the document or ppt tool is (session.ts, forever/components.ts). */
export default (tools: { document?: string; ppt?: string }) =>
  (pi: ExtensionAPI): void => {
    pi.on("tool_call", async (event) => {
      if (tools.document != null && handBuiltPdf(event.toolName, event.input))
        return {
          block: true,
          reason: `Make a new PDF with \`${tools.document}\`: it lays out the page, places the user's own pictures and logo (give their paths in the brief) and checks the print. To add pages to an existing PDF (a cover), make them with \`${tools.document}\` and join the files with the pdf tool's merge action. Do not build a PDF by hand.`,
        };
      if (tools.ppt != null && handBuiltDeck(event.toolName, event.input))
        return {
          block: true,
          reason: `Make a new deck with \`${tools.ppt}\`: give it every slide's words and figures and the paths of the pictures to keep (from the user's own deck, if they gave one). Do not build a deck by script.`,
        };
      return undefined;
    });
  };
