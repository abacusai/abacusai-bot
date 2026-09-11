---
name: Word documents
description: Create, read, and edit .docx Word documents — headings, tables, styles, headers and footers, tracked changes, and converting content into a polished document. Use whenever a Word document is the input or the deliverable.
---

# Working with Word documents

Use `python-docx`. It covers everything below except tracked changes, which need
raw XML.

## Reading

```python
from docx import Document
doc = Document("in.docx")
for p in doc.paragraphs:
    if p.text.strip():
        print(p.style.name, "|", p.text)
```

Paragraphs and tables are **separate collections**, and iterating `doc.paragraphs`
silently skips every table. If document order matters, walk the body XML instead:

```python
from docx.table import Table
from docx.text.paragraph import Paragraph
for child in doc.element.body.iterchildren():
    if child.tag.endswith('}p'):
        print(Paragraph(child, doc).text)
    elif child.tag.endswith('}tbl'):
        print(Table(child, doc))
```

## Writing

Use the built-in styles rather than manual formatting — they are what make a
document look native and what the user's own template expects:

```python
doc.add_heading("Title", level=1)
doc.add_paragraph("Body text")
doc.add_paragraph("A point", style="List Bullet")
table = doc.add_table(rows=1, cols=3)
table.style = "Light Grid Accent 1"
```

To match a house style, **start from the user's template** (`Document("template.docx")`)
and add to it. Styles are defined per-document; a style name that exists in their
template will not exist in a blank one.

## Common pitfalls

- **Runs fragment.** A single visible sentence is often many runs, split
  mid-word wherever formatting or a spellcheck marker changed. Naive
  find-and-replace over `run.text` misses matches that straddle runs. Match on
  `paragraph.text`, then rewrite the runs.
- **`add_picture` needs an explicit width** or it inserts at native pixel size,
  which is usually far wider than the page: `doc.add_picture(p, width=Inches(6))`.
- **Tracked changes are not exposed** by python-docx. Accepting or rejecting them
  means editing `w:ins`/`w:del` elements in the XML directly.
- Headers and footers live on `section.header` / `section.footer`, not on the
  document.
- `.doc` (the old binary format) is **not** supported — convert with LibreOffice
  first: `soffice --headless --convert-to docx`.
