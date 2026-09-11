---
name: Debugging
description: Track down a bug methodically instead of guessing — reproducing it, bisecting the cause, and confirming the fix. Use when something is broken, intermittent, or behaving differently than expected, especially after a few obvious fixes have failed.
---

# Debugging

The failure mode to avoid is plausible-guess-then-change. Each guess that
"looks right" and does not fix it leaves behind an edit that now has to be
un-reasoned about later.

## Order of operations

**1. Reproduce it, reliably.** If you cannot reproduce it on demand, you cannot
know you fixed it. An intermittent bug that "seems fine now" is a bug you have
not fixed. Find the smallest input that triggers it.

**2. Read the actual error.** All of it — the message, the type, and the deepest
frame in *your* code, not the top frame in a library. Stack traces are read
bottom-up for cause and top-down for context.

**3. Verify your assumptions before theorising.** Most stuck debugging is a false
premise: the function is not being called, the config is not what you think, the
file on disk is not the one being loaded, the build is stale. Print the value.
Do not reason about what it should be.

**4. Bisect.** Halve the search space each step, in whichever dimension is
cheapest:
   - *time* — `git bisect`, or diff against the last known-good commit
   - *code path* — does it fail with the middle layer stubbed out?
   - *input* — does half the input still trigger it?

**5. Fix the cause, not the symptom.** A `try/except` around the error, a
null-check on the crash line, or a retry loop each make the symptom disappear
while leaving the bug. If you cannot explain *why* the fix works, you have not
found it.

**6. Prove it.** Re-run the reproduction from step 1. Then check the fix did not
break the neighbours.

## Techniques worth reaching for

- **Print debugging is not beneath you.** It beats a debugger for anything
  timing-related, concurrent, or inside a hot loop.
- **Rubber-ducking works** because stating the assumption out loud is what
  exposes it as an assumption.
- **When it works in one environment and not another**, diff the environments —
  versions, env vars, working directory, permissions, clock, locale.
- **When it broke "for no reason"**, something changed. A dependency resolved to
  a new version, a cache expired, a certificate rolled, data grew past a limit.
- **Intermittent almost always means** concurrency, ordering, timing, uninitialised
  memory, network, or a clock. That list is short — walk it.

## Say what you found

When reporting, separate what you *observed* from what you *concluded*. "The
request returns 403 and the token is empty" is an observation. "Auth is broken"
is a conclusion, and it might be wrong.
