---
name: Writing tests
description: Write tests that catch real regressions instead of restating the implementation — choosing what to test, structuring cases, and handling async, time, and external services. Use when adding tests, fixing a flaky suite, or asked whether something is adequately covered.
---

# Writing tests

The test worth writing is the one that fails when the behaviour breaks and
passes when it does not. Coverage percentage is not that.

## What to test

Test **behaviour through the public surface**, not internals. A test that
asserts a private method was called breaks on every refactor while catching no
bugs — it pins the implementation, not the contract.

Priority order:
1. The path the user actually takes
2. Boundaries — empty, one, many, maximum, just over
3. Error handling — what happens when the dependency fails
4. Regressions — **every bug fix gets a test that fails before the fix**

Skip: getters, framework behaviour, and anything where the test restates the
implementation line for line.

## Structure

Arrange, act, assert — with one behaviour per test. A test asserting five things
reports the first failure and hides the rest.

The name should say what breaks: `returns_401_when_token_expired`, not
`test_auth_2`. When a suite fails at 3am, the name is the whole error message.

Prefer real objects over mocks. Every mock is an assumption about a collaborator
that can drift out of date silently — mocked tests keep passing after the real
API changes. Mock at the boundary (network, clock, filesystem), not inside your
own code.

## The things that make suites flaky

- **Time.** Never assert on `now()`. Inject a clock or freeze it.
- **Sleeps.** `sleep(2)` is both slow and unreliable. Wait for the condition.
- **Order dependence.** Each test must pass alone and in any order. Shared
  mutable state between tests is the usual cause.
- **Real network.** Fine in a small integration suite, fatal in a unit suite.
- **Unseeded randomness**, including dict/set ordering across runs.
- **Parallel workers sharing a fixture** — a database, a temp path, a port.

A flaky test is worse than no test: it trains people to re-run rather than
investigate, and then a real failure gets re-run too.

## Async

Await the assertion, not the call. `expect(fn())` on an unawaited promise passes
regardless. Most async test frameworks will report an unhandled rejection *after*
the test has already reported success — treat any such warning as a failure.
