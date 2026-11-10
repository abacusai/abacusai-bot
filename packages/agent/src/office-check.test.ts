import fs from "fs";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";

import {
  checkDeliverableFile,
  checkOfficeFile,
  deliverableProblemLines,
  findTranslationSource,
} from "./office-check.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-check-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const zipFile = async (
  name: string,
  parts: Record<string, string>
): Promise<string> => {
  const zip = new JSZip();
  for (const [part, body] of Object.entries(parts)) zip.file(part, body);
  const file = path.join(dir, name);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
};

const textFile = (name: string, body: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

const workbook = (sheets: string[]): string =>
  `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s}" sheetId="${i + 1}"/>`).join("")}</sheets></workbook>`;

const sheet = (cells: string): string =>
  `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;

const docx = (text: string): string =>
  `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

describe("checkOfficeFile", () => {
  it.each([
    {
      name: "a workbook whose formulas resolve",
      file: () =>
        zipFile("ok.xlsx", {
          "xl/workbook.xml": workbook(["Data", "Flujo de caja"]),
          "xl/worksheets/sheet1.xml": sheet(
            `<c r="A1"><f>SUM(Data!B1:B3)+'Flujo de caja'!C2</f><v>3</v></c>`
          ),
        }),
      broken: false,
      problems: [],
    },
    {
      name: "a workbook rebuilt from another one",
      file: () =>
        zipFile("links.xlsx", {
          "xl/workbook.xml": workbook(["FCE"]),
          "xl/worksheets/sheet1.xml": sheet(
            `<c r="A1"><f>INDEX('[1]CANT REAL'!$I$16:$I$27,1)</f></c><c r="A2"><f>#REF!+1</f></c><c r="A3"><f>Supuestos!B2</f></c><c r="A4" t="e"><v>#DIV/0!</v></c>`
          ),
        }),
      broken: false,
      problems: [
        /another workbook/,
        /contain #REF!/,
        /does not have: .*supuestos/,
        /error value/,
      ],
    },
    {
      name: "a document with blanks left",
      file: () =>
        zipFile("form.docx", {
          "word/document.xml": docx(
            "Student: ________ Group: ________ Answer: lorem ipsum"
          ),
        }),
      broken: false,
      problems: [/blank\(s\) or placeholder/],
    },
    {
      name: "a filled document",
      file: () =>
        zipFile("filled.docx", {
          "word/document.xml": docx(
            "Student: Petro Ivanenko, group CS-21. Answer: an absolute reference keeps its cell."
          ),
        }),
      broken: false,
      problems: [],
    },
    {
      name: "a renamed file that is not an Office zip",
      file: async () => textFile("fake.xlsx", "name,score\nA,1\n"),
      broken: true,
      problems: [/not a valid Office file/],
    },
    {
      name: "a PDF cut off before its end",
      file: async () =>
        textFile("cut.pdf", "%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n"),
      broken: true,
      problems: [/not a complete PDF/],
    },
    {
      name: "a complete PDF",
      file: async () =>
        textFile(
          "ok.pdf",
          "%PDF-1.7\n1 0 obj << /Type /Page >> endobj\ntrailer\n%%EOF\n"
        ),
      broken: false,
      problems: [],
    },
    {
      name: "a JSONL file with a broken line",
      file: async () => textFile("rows.jsonl", '{"id":"a"}\n{"id":\n'),
      broken: false,
      problems: [/not valid JSON/],
    },
  ])("$name", async ({ file, broken, problems }) => {
    const check = await checkOfficeFile(await file());
    expect(check?.broken).toBe(broken);
    expect(check?.problems).toHaveLength(problems.length);
    problems.forEach((pattern, i) =>
      expect(check?.problems[i]).toMatch(pattern)
    );
  });

  it("leaves other files alone", async () => {
    expect(await checkOfficeFile(textFile("app.js", "x"))).toBeNull();
  });
});

describe("translated strings", () => {
  const source = [
    { id: "a1", text: "Has obtenido <color=#FFD700>{0}</color>." },
    { id: "a2", text: "Cazador de sombras del bosque" },
    { id: "a3", text: "Derrota a %d enemigos en la cueva oscura" },
    { id: "a4", text: "Te arrepentirás de esto, viajero" },
    { id: "a5", text: "Explora el Bosque de Ithren por completo" },
    { id: "a6", text: "Abre el cofre antiguo del templo" },
  ];
  const jsonl = (rows: Array<{ id: string; text: string }>): string =>
    rows.map((r) => JSON.stringify(r)).join("\n");

  it("passes a full translation, tags and all", async () => {
    const src = textFile("good-es.jsonl", jsonl(source));
    const out = textFile(
      "good-ar.jsonl",
      jsonl([
        { id: "a1", text: "حصلت على <color=#FFD700>{0}</color>." },
        { id: "a2", text: "صائد ظلال الغابة" },
        { id: "a3", text: "اهزم %d من الأعداء في الكهف المظلم" },
        { id: "a4", text: "ستندم على هذا أيها المسافر" },
        { id: "a5", text: "استكشف غابة إيثرين بالكامل" },
        { id: "a6", text: "افتح الصندوق القديم في المعبد" },
      ])
    );
    const check = await checkDeliverableFile(out, src);
    expect(check.problems).toEqual([]);
    expect(check.notes.join(" ")).toMatch(/compared with good-es\.jsonl/);
  });

  it("lists missing, untranslated, broken and shifted strings", async () => {
    const src = textFile("bad-es.jsonl", jsonl(source));
    const out = textFile(
      "bad-ar.jsonl",
      jsonl([
        { id: "a1", text: "حصلت على {0}." },
        { id: "a2", text: "Cazador de sombras del bosque" },
        { id: "a3", text: "اهزم الأعداء في الكهف المظلم %d" },
        { id: "a4", text: "ستندم" },
        { id: "a5", text: "استكشف غابة إيثرين بالكامل" },
      ])
    );
    const problems = (await checkDeliverableFile(out, src)).problems.join("\n");
    expect(problems).toMatch(/1 of 6 strings are missing \(a6\)/);
    expect(problems).toMatch(/1 strings changed a placeholder.*\(a1\)/);
    expect(problems).toMatch(
      /1 strings are still in the source language \(a2\)/
    );
    expect(problems).toMatch(/far shorter or longer.*a4/);
  });

  it("finds the source beside the file when none is named", () => {
    const sub = path.join(dir, "locales");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "es.jsonl"), jsonl(source));
    fs.writeFileSync(
      path.join(sub, "ar.jsonl"),
      jsonl(source.map((r) => ({ id: r.id, text: `ترجمة ${r.id}` })))
    );
    // A backup of the translation is not its source.
    fs.writeFileSync(
      path.join(sub, "ar-backup.jsonl"),
      jsonl(source.map((r) => ({ id: r.id, text: `ترجمة ${r.id}` })))
    );
    expect(findTranslationSource(path.join(sub, "ar.jsonl"))).toBe(
      path.join(sub, "es.jsonl")
    );
  });
});

describe("deliverableProblemLines", () => {
  it("asks for a fix, and the second time for the plain truth", () => {
    expect(deliverableProblemLines([], false)).toEqual([]);
    expect(deliverableProblemLines(["x.xlsx: bad"], false)[1]).toMatch(
      /Fix them and present again/
    );
    expect(deliverableProblemLines(["x.xlsx: bad"], true)[1]).toMatch(
      /Do not try the same fix again/
    );
  });
});
