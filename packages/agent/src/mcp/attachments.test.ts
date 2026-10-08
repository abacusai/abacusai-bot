/**
 * Filenames an MCP server sends with an attachment, made safe to write on
 * every platform the agent runs on.
 */
import { describe, expect, it } from "vitest";

import { sanitizeFilename } from "./attachments.js";

describe("sanitizeFilename", () => {
  it("keeps an ordinary name as it is", () => {
    expect(sanitizeFilename("report 2026.pdf")).toBe("report 2026.pdf");
    expect(sanitizeFilename("résumé.docx")).toBe("résumé.docx");
  });

  it("keeps only the last path segment, whichever separator", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\boot.ini")).toBe("boot.ini");
    expect(sanitizeFilename("..")).toBe("attachment");
  });

  it("drops controls and bidi marks that disguise an extension", () => {
    expect(sanitizeFilename("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFilename("a⁦b⁩‎‏.txt")).toBe("ab.txt");
    expect(sanitizeFilename("a\u0000b\u007Fc\u0085d.txt")).toBe("abcd.txt");
  });

  it("never names an NTFS stream or a Windows-forbidden character", () => {
    expect(sanitizeFilename("file.txt:hidden")).toBe("file.txt_hidden");
    expect(sanitizeFilename('a<b>c"d|e?f*g.txt')).toBe("a_b_c_d_e_f_g.txt");
  });

  it("prefixes Windows device names, with or without an extension", () => {
    for (const name of [
      "CON",
      "nul.txt",
      "Aux.tar.gz",
      "com1",
      "LPT9.log",
      "prn",
    ])
      expect(sanitizeFilename(name), name).toBe(`_${name}`);
    expect(sanitizeFilename("console.txt")).toBe("console.txt");
    expect(sanitizeFilename("com10")).toBe("com10");
  });

  it("drops leading dots and trailing dots or spaces", () => {
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename("notes.txt. . ")).toBe("notes.txt");
    expect(sanitizeFilename("NUL. ")).toBe("_NUL");
  });

  it("caps the length and keeps the extension", () => {
    const long = sanitizeFilename(`${"a".repeat(300)}.pdf`);
    expect(long).toHaveLength(128);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});
