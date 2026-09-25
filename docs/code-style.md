# Code style

## Comments

A comment says what the code cannot say about itself: the constraint it
satisfies, the failure it prevents, the reason a simpler-looking option was
rejected. Everything else is noise for the reader.

- **Length.** One to three lines is normal. A file header is at most six lines
  and says what the module is for, not why it was built. An inline comment is a
  sentence or two, never a paragraph.
- **Keep the why, drop the story.** One sentence on the reason stays. How the
  code used to work, what was tried, how the bug was found, and who reported it
  all go. Git history holds that.
- **No history words.** "Used to", "no longer", "previously" and "the
  regression" describe a version the reader never saw.
- **No internal references.** No pull-request or issue numbers, no people, no
  field logs quoting a real user or chat.
- **Type fields.** Document a field only when its name does not say what it is,
  and then in one line.
- **Tests.** The test name carries the case. A file header, if any, says in two
  lines what the file pins.

Before:

```ts
// The requested model cannot run (no key for it, or a free pool with
// nothing left in it), so the first model that CAN takes the turn.
//
// Silently. This used to open the conversation with a paragraph about
// a pool being empty and a substitution being made, which is the app
// explaining its own plumbing to someone who asked it a question. The
// substitution is not hidden: the composer's picker names the model
// that is actually running, which is where a user looks to find out.
// The case worth interrupting for is the one below, where there is no
// model at all and nothing can happen until they add a key.
```

After:

```ts
// The requested model cannot run (no key, or an empty free pool), so the
// first model that can takes the turn. Silently: the picker already shows
// which model is running, and only "no model at all" is worth interrupting for.
```
