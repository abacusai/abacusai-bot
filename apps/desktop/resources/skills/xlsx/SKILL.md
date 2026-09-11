---
name: Excel / Spreadsheets
description: Read, edit, analyse, and create .xlsx, .xlsm, and .csv spreadsheets — adding columns, writing formulas, formatting cells, building charts, and cleaning messy tabular data. Use whenever a spreadsheet is the input or the deliverable.
---

# Working with spreadsheets

## Choosing an approach

| Need | Use |
|---|---|
| Analysis, aggregation, joins | `pandas` |
| Preserving formatting, formulas, charts | `openpyxl` |
| Very large files (read-only streaming) | `openpyxl` with `read_only=True` |
| CSV only | the stdlib `csv` module, or `pandas` |

The decision that matters: **`pandas` throws away everything that is not
values.** Round-tripping a formatted workbook through `pandas` destroys its
formulas, styles, merged cells, and charts. If the user's file has any of that
and they expect it back, use `openpyxl` and edit in place.

## Look before you write

Never assume row 0 is the header — real files have title rows, logos, and blank
spacers above the table:

```python
import pandas as pd
raw = pd.read_excel("in.xlsx", header=None, nrows=20)
print(raw.to_string())
```

Find the actual header row, then re-read with `header=<n>` (or `skiprows`).

## Formulas

`openpyxl` writes formulas as strings, and does **not** evaluate them:

```python
ws["D2"] = "=SUM(B2:C2)"
```

This means a file you wrote will show the formula's *cached* value as `None`
until Excel opens it. If a downstream step needs the computed number, compute it
in Python as well — do not read it back expecting a value.

Reading with `data_only=True` gives you the last value **Excel** cached. On a
file that Excel has never opened, that is `None`.

## Common pitfalls

- **Columns are 1-indexed** in `openpyxl` (`ws.cell(row=1, column=1)`), and
  `ws["A1"]` is the same cell. Mixing conventions silently writes to the wrong
  place.
- **Dates** come back as `datetime` sometimes and as floats (Excel serials)
  other times, depending on cell formatting. Check `type()` before arithmetic.
- **Merged cells** hold their value only in the top-left cell; the others read
  as `None`.
- Writing with `pandas.to_excel` on an existing path **replaces the whole file**,
  not the sheet.
- Numbers stored as text are extremely common in exported data — `df.dtypes`
  showing `object` for a numeric column is the tell.
