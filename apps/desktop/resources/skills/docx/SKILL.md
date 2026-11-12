---
name: Word documents
description: >-
  Create, read, and edit .docx Word documents: headings, tables, styles, headers and footers, tracked changes, and converting content into a polished document. Use whenever a Word document is the input or the deliverable.
---

# Working with Word documents

Write a CommonJS script (`make-doc.cjs`) and run it with the app's own Node:

```sh
"$ABACUSAI_BOT_NODE" make-doc.cjs
```

`require()` finds these with nothing to install:

| Need | Use |
|---|---|
| Read the text or the structure | `mammoth` |
| Create a document | `docx` |
| Change an existing document in place | `jszip`, editing its XML |

## Reading

```js
const mammoth = require("mammoth");
const { value } = await mammoth.extractRawText({ path: "in.docx" });
```

For headings, lists and tables, convert to HTML instead. The tags keep the
structure, and paragraph styles show up as `h1`, `h2` and so on:

```js
const { value: html, messages } = await mammoth.convertToHtml({ path: "in.docx" });
```

`messages` lists what mammoth could not map. Read it before you trust the
output. Wrap top-level `await` in `(async () => { ... })()`, since a `.cjs`
script has none.

## Writing

Use the built-in heading styles and real lists rather than manual formatting.
They are what make a document look native, and what its table of contents and
navigation pane read:

```js
const fs = require("fs");
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell,
  WidthType, Header, TextRun } = require("docx");

const cell = (text) => new TableCell({ children: [new Paragraph(text)] });
const doc = new Document({
  sections: [{
    headers: { default: new Header({ children: [new Paragraph("Quarterly report")] }) },
    children: [
      new Paragraph({ text: "Title", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("Body text, "), new TextRun({ text: "bold", bold: true })] }),
      new Paragraph({ text: "A point", bullet: { level: 0 } }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: [cell("Day"), cell("Plan")] })],
      }),
    ],
  }],
});
Packer.toBuffer(doc).then((buffer) => fs.writeFileSync("out.docx", buffer));
```

## Editing an existing document

`docx` only creates documents. To change one the user gave you, so that it
keeps their template and styles, edit its XML with `jszip`. The body is in
`word/document.xml`:

```js
const fs = require("fs");
const JSZip = require("jszip");
(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync("in.docx"));
  let xml = await zip.file("word/document.xml").async("string");
  xml = xml.replace("{{CLIENT}}", "Acme Ltd");
  zip.file("word/document.xml", xml);
  fs.writeFileSync("out.docx", await zip.generateAsync({ type: "nodebuffer" }));
})();
```

To fill a template with placeholders, `patchDocument` from `docx` replaces
`{{name}}` markers with paragraphs, runs or tables, and keeps everything else.

## Common pitfalls

- **Runs fragment.** One visible sentence is often several `<w:r>` runs, split
  mid-word wherever formatting or a spellcheck marker changed. A plain string
  replace over the XML misses any match that straddles runs. Find the
  paragraph (`<w:p>`) by its text, then rewrite its runs.
- **Images need an explicit size.** An `ImageRun` takes
  `transformation: { width, height }` in pixels. Size it to the page (about
  600 px wide for a portrait page with normal margins), or it inserts at the
  image's native size.
- **Tracked changes are not applied by any of these.** `mammoth` shows
  insertions and ignores deletions. Accepting or rejecting changes means
  editing the `w:ins` and `w:del` elements in `word/document.xml` directly.
- Headers and footers belong to a section (`headers`/`footers` on it), not to
  the document. In an existing file they are separate parts:
  `word/header1.xml` and the like.
- `.doc` (the old binary format) is **not** supported. Convert it with
  LibreOffice first: `soffice --headless --convert-to docx`.
