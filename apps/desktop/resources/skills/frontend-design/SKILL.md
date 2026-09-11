---
name: Frontend design
description: Design and build user interfaces that look considered rather than generated — layout, spacing, type, colour, and states. Use when building or restyling any UI, or when a screen works but looks wrong and it is not obvious why.
---

# Frontend design

Most "AI-looking" UI fails for the same handful of reasons. Fix these before
reaching for anything clever.

## Spacing carries the structure

Use one scale and never improvise values: `4 8 12 16 24 32 48 64`.

The rule that does the most work: **related things must be closer together than
unrelated things.** A label 16px from its input and 16px from the section above
it reads as unstructured. Make it 6px from its input and 32px from the section.

Whitespace is not wasted space. Cramped is the single most common failure.

## Type

- Two sizes and two weights is usually enough for a whole screen.
- Body text at 14–16px. Below 13px is a hint, not content.
- Line height 1.5 for body, ~1.2 for headings.
- Cap line length at ~70 characters (`max-width: 65ch`).
- **Never centre a paragraph.** Centre a single line at most.

## Colour

- One accent. Use it for the primary action and almost nothing else — if
  everything is emphasised, nothing is.
- Greys carry the interface; the accent points at the one thing to do next.
- Semantic colour must never be the *only* signal — colour-blind users and
  greyscale printing both lose it. Pair it with an icon or text.
- Check contrast: 4.5:1 for body text, 3:1 for large text. This is not optional.

## States

An unstyled state is a bug. Every interactive element needs: default, hover,
active, focus, disabled — and focus must be **visible**, because keyboard users
navigate by it. Never `outline: none` without a replacement.

Every async surface needs: loading, empty, error, and loaded. The empty state is
the one people forget, and it is the first thing a new user sees.

## Motion

- 150–200ms for local feedback, 200–300ms for entrances.
- Ease-out for things arriving, ease-in for things leaving.
- Animate `transform` and `opacity` only — animating `width`, `top`, or `height`
  causes layout thrash.
- Respect `prefers-reduced-motion`.

## Before calling it done

- Does it survive a 320px-wide viewport?
- Does it survive dark mode, if the app has one?
- Does it survive the longest realistic string, and the empty case?
- Can you tab through it and always see where you are?
