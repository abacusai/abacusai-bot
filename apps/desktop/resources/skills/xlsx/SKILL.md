---
name: Excel / Spreadsheets
description: >-
  Read, edit, analyse, and create .xlsx, .xlsm, and .csv spreadsheets: adding columns, writing formulas, formatting cells, building charts, and cleaning messy tabular data. Use whenever a spreadsheet is the input or the deliverable.
---

# Working with spreadsheets

Write a CommonJS script (`sheet.cjs`) and run it with the app's own Node:

```sh
"$ABACUSAI_BOT_NODE" sheet.cjs
```

`require("exceljs")` works with nothing to install. It reads and writes
values, formulas, styles, number formats, merged cells, column widths and
data validation.

## What survives a rewrite

**exceljs does not carry charts, pivot tables, slicers or macros through a
read-and-save.** A workbook that has them comes back without them. If the
user's file has any of these and they expect it back intact, say so before
you change it. Then either write your results to a new sheet or file, or edit
only the cells by changing the sheet XML in place with `jszip`.

For heavy analysis (joins, group-bys, statistics), Python with `pandas` in the
shell is the better tool, when it is there. Write the result with exceljs if
the deliverable needs formatting.

## Look before you write

Never assume row 1 is the header. Real files have title rows, logos and blank
spacers above the table:

```js
const ExcelJS = require("exceljs");
(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("in.xlsx");
  const ws = wb.worksheets[0];
  ws.eachRow({ includeEmpty: true }, (row, n) => { if (n <= 20) console.log(n, row.values); });
})();
```

Find the actual header row, then read the data from the row below it.

## Writing

```js
const ws = wb.addWorksheet("Budget");
ws.columns = [{ header: "Item", key: "item", width: 24 }, { header: "Cost", key: "cost", width: 12 }];
ws.addRows([{ item: "Hotel", cost: 120 }, { item: "Food", cost: 45 }]);
ws.getRow(1).font = { bold: true };
ws.getColumn("cost").numFmt = "#,##0.00";
await wb.xlsx.writeFile("out.xlsx");
```

## Formulas

exceljs writes formulas as text and does **not** evaluate them:

```js
ws.getCell("B4").value = { formula: "SUM(B2:B3)" };
```

A file you wrote has no cached value until Excel opens it. If a later step
needs the number, compute it in the script as well. Give the cell
`{ formula, result }` when you know the answer, so viewers that do not
recalculate still show it.

Reading a formula cell gives `{ formula, result }`. `result` is the value
**Excel** last cached, which is missing on a file Excel has never opened.

## Common pitfalls

- **Rows and columns are 1-indexed** (`ws.getCell(1, 1)` is `A1`). Mixing in a
  0-based loop index silently writes to the wrong place.
- **Dates** come back as `Date` objects when the cell is formatted as a date,
  and as plain numbers (Excel serials) when it is not. Check before you do
  arithmetic.
- **Merged cells** hold their value in the top-left cell only; the others read
  as that same cell (`cell.isMerged`, `cell.master`).
- `writeFile` on an existing path **replaces the whole file**. To add a sheet,
  read the workbook, add to it, then write it back.
- **Numbers stored as text** are very common in exported data. A value that
  is a string of digits is the tell; convert it before you sum.
- For `.csv`, use `wb.csv.readFile` / `wb.csv.writeFile`, or plain `fs` for a
  simple file.
