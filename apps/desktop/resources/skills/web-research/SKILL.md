---
name: Web research
description: Research a topic online and report what is actually supported — finding primary sources, cross-checking claims, and separating fact from consensus. Use when asked to look something up, compare options, or check whether something is true or current.
---

# Web research

## Go to the source

Rank what you find:

1. **Primary** — the spec, the RFC, the official docs, the paper, the source code
2. **Official secondary** — the vendor's changelog, release notes, status page
3. **Community** — Stack Overflow, blog posts, forum threads
4. **Aggregators** — content farms, listicles, anything summarising the above

A blog post explaining an API is evidence about what the API did *when it was
written*. The docs are evidence about now. When they disagree, the docs win —
and if the docs disagree with observed behaviour, the behaviour wins.

## Check the date on everything

This is the single biggest source of wrong answers in technical research. A
top-ranked answer from 2019 describing a library that has since had two major
versions will be confidently, specifically wrong. Look for the publication date
before you read the content, not after.

For anything versioned, find out which version the source is talking about.

## Cross-check

Two sources that both trace to the same original are one source. Follow the
citation before counting it as corroboration — a claim can appear in fifty
places and have exactly one origin.

Be most suspicious of the claims that are most convenient for you: the ones that
would let you stop researching.

## Report

- Separate what you **confirmed** from what you **inferred**.
- Give the source for anything load-bearing, so it can be checked.
- Say when sources disagree, and which you found more credible and why.
- Say what you could **not** establish. A gap named is useful; a gap papered
  over is a trap.
- Prefer "as of <date>, the docs say X" over a bare assertion for anything that
  changes.

## When something looks wrong

If a result contradicts what you expected, do not just accept the first
explanation. Check whether you are looking at a different version, a different
product with a similar name, a regional difference, or a deprecated path.
