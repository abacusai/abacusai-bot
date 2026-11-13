---
name: Artifact design
description: >-
  Build a page people can use with the artifact tool: a report, dashboard, one-pager, diagram or small working tool. Read this before calling artifact.
---

# Artifact design

An artifact is one HTML file that opens beside the chat and can be shared by
link. Use one when the answer is something people will read again, use or pass
on. A short answer stays in the chat.

## Pick the kind

| Kind | Use it for | Lead with |
| --- | --- | --- |
| report | Findings and write-ups | The conclusion, then the evidence |
| dashboard | Numbers people scan | Three or four key numbers, then charts |
| page | One-pagers, invites, landing pages | The one thing the reader should do |
| diagram | How something works | The picture, with short labels |
| tool | Calculators, planners, checklists | A working example already filled in |

## What the shell gives you

`artifact` wraps your markup in a shell. It sets the title, a light and dark
palette, the type and phone width, and keeps the page off the network. Write
only what goes inside `<body>`. The look is a serif headline, plain body text,
and monospace for labels and numbers. Colors come from these tokens, so the
page works in both themes: `--bg`, `--paper`, `--ink`, `--soft`, `--line`,
`--tint`, `--accent`, `--good`, `--warn`, `--bad`, and `--good-tint`,
`--warn-tint`, `--bad-tint`.

Ready-made classes: `.page` (the column), `section`, `.eyebrow`, `.lede`,
`.note`, `.stats` with `.stat` (number in `b`, label in `span`), `.bar` (a
progress bar, `<i style="width:60%">` inside), `.card`, `.table` around a
`table.grid` (`.n` on number columns), `.pill` with `.good`, `.warn` or `.bad`,
`.chart` (an inline SVG).

Open a report or dashboard the same way: eyebrow, `h1`, a short paragraph, then
the stats. Put the number first in each `.stat`.

## Rules

- Everything lives in the file, apart from the shell's fonts. The page cannot fetch data, and images must be
  `data:` URLs. Put the numbers in the page.
- Draw charts as inline SVG, to scale, with every label naming a real value.
  Use a chart library only for a tool that really needs one, pinned to an exact
  version on `https://cdnjs.cloudflare.com`.
- Scripts are for tools. A report, dashboard, page or diagram needs none.
- Keep real figures real. Sample data says it is sample data, on the page.
- A tool opens with a filled-in example, never an empty form.
- Give the page a real name: a short noun phrase, not a sentence.
- Never add a password field. Never ask for a card number or a login.
- Lay out with flex or grid and `gap`. Nothing may scroll sideways at phone
  width; put wide tables in `overflow-x: auto`.

## Working with it

1. Call `artifact` with `action: "create"`.
2. Call `present_deliverable` with the path it returns. The page opens beside
   the chat.
3. For a change, call `artifact` with `action: "edit"` and small replacements,
   then present it again. Each change saves a version.
4. To go back, use `action: "restore"` with the version number.

Sharing is the user's choice: they press Share. Never tell them a page is
public unless they published it.
