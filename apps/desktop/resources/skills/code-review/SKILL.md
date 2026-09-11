---
name: Code review
description: Review a diff or pull request for correctness, security, and clarity, and report findings that are worth someone's time. Use when asked to review code, check a change before merging, or look over a PR.
---

# Code review

A review is only useful if its findings are real. Ten nitpicks bury the one bug,
and a confident false positive costs more time than saying nothing.

## Read in this order

1. **The description.** What is this *supposed* to do? A change that works but
   solves a different problem is still wrong.
2. **The tests.** They tell you what the author believes the contract is.
3. **The diff**, in dependency order — data model, then logic, then callers.
4. **What is missing.** The absent null check, the unhandled error path, the
   caller that was not updated, the test that was not written.

## What actually matters, in order

**Correctness.** Does it do what it claims? Off-by-one, wrong operator, inverted
condition, missing `await`, mutation of a shared object, error swallowed by a
bare `except`.

**Edge cases.** Empty, one, many. Null and undefined. Zero and negative. Unicode.
Concurrent callers. What happens on the second call?

**Security.** Untrusted input reaching a query, a shell, a path, or a template.
Secrets in code or logs. Authorisation checked at the right layer. Anything that
lets a user address someone else's data.

**Resource handling.** Files and sockets closed on the error path too. Unbounded
growth. A query inside a loop.

**Clarity** — but only where it will genuinely confuse the next reader. Naming
that misleads is worth raising; naming you would have chosen differently is not.

## Before you report a finding

Ask: *what input makes this fail, and what happens?* If you cannot answer
concretely, you have a hunch, not a finding — either verify it or drop it.

Trace the actual code path rather than pattern-matching. "This looks like a
SQL injection" is worth ten seconds of checking whether the value is
parameterised before you say it.

## How to say it

- Lead with the consequence: *"Returns 500 for an empty cart"* beats *"consider
  guarding this"*.
- Separate blocking from optional, explicitly.
- Praise is not padding — if something is done well, saying so tells the author
  which instincts to keep.
- If the whole approach is wrong, say that first. Line comments on code that
  should not exist waste everyone's time.
