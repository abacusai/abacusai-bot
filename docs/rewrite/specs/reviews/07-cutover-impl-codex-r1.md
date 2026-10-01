# Codex review: cut-over release N (C5–C14), range 1b14bc91..75516d5f

I’ll use the code-review and unslop skills to check the commit range against the specs, upgrade paths, tests, and claimed evidence.
exec
/bin/zsh -lc 'cat /Users/rajaniraiyn/.agents/skills/code-review/SKILL.md /Users/rajaniraiyn/.agents/skills/unslop/SKILL.md' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 8ms:
---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside two parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
---
name: unslop
description: Cut AI tells from any writing. Must always apply.
disable-model-invocation: true
---

# Unslop

Edit text to remove AI patterns.

## Process

1. Scan for the patterns below.
2. Rewrite. Preserve meaning, match intended tone.
3. Self-audit: "What makes this obviously AI generated?" Fix remaining tells.

## Patterns to detect and fix

Rule numbers are stable ids that other skills cite. A removed rule leaves a gap.

### Content

3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or expand with real sources.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete.

### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Replace with plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Just say "is" or "has".
9. **"Not just X, but Y."** State the point directly instead.
10. **Rule of three.** Forcing ideas into groups of three. Use the natural number.
11. **Synonym cycling.** Protagonist, main character, central figure, hero all in one paragraph. Pick one, repeat it.
12. **False ranges.** "from X to Y" where X and Y aren't on a meaningful scale. List topics directly.

### Style

13. **Em dash overuse.** Avoid em dashes entirely. Use periods or commas only (no parentheses, no en dashes, no hyphen-as-dash substitutes). If a thought needs separation, end the sentence or use a comma.
14. **Colon overuse.** Colons are fine before a list or example. Not as mid-sentence connectors. "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" adds nothing with the colon. Rewrite to let the point stand on its own without comparison framing. "Describing when the scheduler should fire works best as plain English." Same meaning, no crutch punctuation.
15. **Boldface overuse.** Don't bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon that restates the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine, not a tell.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove from headings and bullets.
19. **Curly quotes.** Replace with straight quotes.

### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". "It is important to note that" gets deleted.
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans or facts.

### Jargon

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, primitive (as noun), harness (as metaphor), surface (as in "API surface"), bedrock, scaffolding (as metaphor), modality, paradigm, gold-plating, ratchet (as metaphor), evacuate (for moving code), endgame, north star, flywheel. These read as technical but usually have a plainer concrete word. "Substrate" becomes "base". "Wedge in" becomes "add". "Vector" becomes "way" or "method". "Gold-plating" becomes "more than the job needs". "Ratchet" becomes the mechanism's real name or "a limit that only tightens". "Evacuate" becomes "move out". "Endgame" becomes "the last phase". Pick the concrete word.

### Plain speech

27. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you can't restate it as a concrete instruction, fact, or number, cut it. One more check: if the sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
28. **Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.
29. **Active voice.** Prefer it. Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries", "the file is parsed by the loader" becomes "the loader parses the file". Passive is fine only when the actor is unknown or genuinely doesn't matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" becomes "use", "leverage" becomes "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if". The fancier synonym is rarely clearer.
32. **Mannered prose.** Metaphor or flourish where a literal phrase exists: aphorisms ("wire it or delete it"), rhetorical fragments for effect, personified code ("the plan holds it"), figurative verbs ("rides along", "stands on"), stock framing phrases. "A dial worth turning" becomes "a parameter worth varying". Say what you mean. Rule 26 covers the metaphor nouns.
33. **Over-compression.** Dropped articles, verbless fragments, symbol-speak, and abbreviations that make the reader decode instead of read. "Parser rejects bad date → exit 2, no write" becomes "The parser rejects a bad date, exits with code 2, and writes nothing." Write whole sentences with their articles and verbs, and spell out arrows and abbreviations.

exec
/bin/zsh -lc "git status --short; git diff --stat 1b14bc91..75516d5f; rg --files -g AGENTS.md -g '07-cut-over.md' -g PLAN.md -g '07-cutover.md'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 exited 1 in 9982ms:
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-5z8zG9y9' (errno=Operation not permitted)
2026-10-01 15:20:55.600 xcodebuild[57364:4417630]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:20:55.957 xcodebuild[57364:4417629] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-s62x33zV' (errno=Operation not permitted)
2026-10-01 15:20:57.111 xcodebuild[57366:4417653]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:20:57.315 xcodebuild[57366:4417649] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-nxJAqqiS' (errno=Operation not permitted)
2026-10-01 15:21:00.048 xcodebuild[57404:4417773]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:21:00.278 xcodebuild[57404:4417772] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-p64ZV55j' (errno=Operation not permitted)
2026-10-01 15:21:01.330 xcodebuild[57406:4417789]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:21:01.620 xcodebuild[57406:4417787] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
 .github/workflows/ci.yml                           |   41 +-
 .size-limit.json                                   |  267 +-
 CHANGELOG.md                                       |   23 +-
 apps/desktop/components.json                       |   12 +-
 apps/desktop/e2e/bots-real.mjs                     |    2 +-
 apps/desktop/e2e/phase5-real.mjs                   |    2 +-
 apps/desktop/e2e/sessions-real.mjs                 |    2 +-
 apps/desktop/electron-builder.yml                  |    1 -
 apps/desktop/index-next.html                       |   17 -
 apps/desktop/index.html                            |    5 +-
 apps/desktop/notch.html                            |    2 +-
 apps/desktop/package.json                          |   54 +-
 apps/desktop/scripts/check-chat-bundle.mjs         |    2 +-
 apps/desktop/scripts/check-jsx-i18n.js             |    7 +-
 .../desktop/scripts/check-legacy-renderer-diff.mjs |  146 -
 apps/desktop/scripts/check-release-build.mjs       |    2 +-
 apps/desktop/scripts/generate-routes.mjs           |    6 +-
 apps/desktop/scripts/i18n-consumers.mjs            |   74 +
 apps/desktop/scripts/i18n-dynamic-keys.json        | 1558 +++++++
 apps/desktop/scripts/i18n-dynamic-keys.test.mjs    |   56 +
 apps/desktop/scripts/legacy-renderer-allow.json    |   47 -
 apps/desktop/scripts/locale-keymap.json            |  385 --
 apps/desktop/scripts/locale-retired.json           | 3494 ---------------
 apps/desktop/scripts/measure-release-size.mjs      |   17 +-
 apps/desktop/scripts/release-build-plugin.mjs      |    2 +-
 .../{screenshots-next.mjs => screenshots.mjs}      |   21 +-
 .../{shadcn-next-init.mjs => shadcn-init.mjs}      |   26 +-
 apps/desktop/scripts/shadcn-registry-snapshot.mjs  |   20 +-
 .../scripts/{shadcn-next.mjs => shadcn.mjs}        |   31 +-
 apps/desktop/scripts/sync-chat-fixtures.mjs        |    7 +-
 apps/desktop/scripts/sync-locales.js               |   41 +-
 apps/desktop/scripts/vite-resolution.test.ts       |    9 +-
 apps/desktop/src/main/dev/electron-app.ts          |   17 +-
 apps/desktop/src/main/dev/legacy-diff.test.ts      |  275 --
 apps/desktop/src/main/dev/mutation-harness.test.ts |    2 +-
 apps/desktop/src/main/dev/mutation-harness.ts      |   25 +-
 ....electron.test.ts => renderer.electron.test.ts} |   20 +-
 apps/desktop/src/main/dev/screenshots-gate.test.ts |    4 +-
 apps/desktop/src/main/handler.test.ts              |  113 +-
 apps/desktop/src/main/handler.ts                   | 1135 +----
 apps/desktop/src/main/index.ts                     |  419 +-
 apps/desktop/src/main/keep-awake.test.ts           |   48 -
 apps/desktop/src/main/keep-awake.ts                |   74 +-
 apps/desktop/src/main/migrations/backup.ts         |    2 +-
 .../src/main/migrations/legacy-home.test.ts        |   19 +-
 apps/desktop/src/main/migrations/record.ts         |    2 +
 .../src/main/migrations/restore-legacy.test.ts     |  228 +
 apps/desktop/src/main/migrations/restore-legacy.ts |  250 ++
 apps/desktop/src/main/migrations/runner.ts         |   11 +-
 .../steps/002-prefs-from-renderer-state.ts         |    5 +-
 .../steps/004-archive-transcripts-v1.test.ts       |    1 -
 apps/desktop/src/main/migrations/steps/index.ts    |    2 +-
 apps/desktop/src/main/notch/controller.test.ts     |    4 +-
 apps/desktop/src/main/notch/controller.ts          |   25 +-
 apps/desktop/src/main/notch/notch.electron.test.ts |    8 +-
 apps/desktop/src/main/renderer-entry.test.ts       |   34 +-
 apps/desktop/src/main/renderer-entry.ts            |   28 +-
 apps/desktop/src/main/renderer-generation.test.ts  |   42 -
 apps/desktop/src/main/renderer-generation.ts       |   29 -
 apps/desktop/src/main/renderer-host.test.ts        |   28 +-
 apps/desktop/src/main/renderer-host.ts             |   76 +-
 apps/desktop/src/main/rpc/ai-attention.test.ts     |    1 -
 apps/desktop/src/main/rpc/deps.ts                  |    5 -
 apps/desktop/src/main/rpc/emit.test.ts             |   45 +-
 apps/desktop/src/main/rpc/emit.ts                  |   13 +-
 apps/desktop/src/main/rpc/event-bus.ts             |    2 +-
 apps/desktop/src/main/rpc/handler-options.ts       |    3 -
 .../src/main/rpc/procedures/agent.start.test.ts    |    2 +-
 .../src/main/rpc/procedures/durable-state.ts       |   14 -
 apps/desktop/src/main/rpc/raw-ipc.test.ts          |   44 +
 apps/desktop/src/main/rpc/router.ts                |    2 -
 apps/desktop/src/main/rpc/swap-readiness.test.ts   |   30 -
 .../src/main/rpc/tables/collections.e2e.test.ts    |    4 +-
 apps/desktop/src/main/rpc/tables/index.ts          |   12 -
 apps/desktop/src/main/rpc/testing.ts               |    2 -
 .../rpc/transports/rpc-handshake.electron.test.ts  |    2 +-
 apps/desktop/src/main/service-host.ts              |   77 +-
 .../src/main/services/agent-tools/deck-agent.ts    |   22 -
 .../src/main/services/agent-tools/design-agent.ts  |    9 -
 .../main/services/agent-tools/model-analysis.ts    |    5 -
 .../services/agent-tools/routine-runs-store.ts     |    3 -
 .../main/services/agui/native-ids-ingress.test.ts  |    1 -
 .../src/main/services/agui/relay-service.test.ts   |   89 +-
 .../src/main/services/agui/relay-service.ts        |   56 +-
 .../src/main/services/agui/relay.e2e.test.ts       |   23 +-
 .../src/main/services/agui/run-finished.test.ts    |    1 -
 .../src/main/services/bots/bot-model.test.ts       |    1 -
 .../browser/browser-runtime-handler.test.ts        |   82 -
 .../services/browser/browser-runtime-handler.ts    |   86 -
 .../browser/electron-browser-runtime.test.ts       |    6 +-
 .../services/browser/electron-browser-runtime.ts   |    2 -
 .../src/main/services/config/legacy-prefs.test.ts  |  289 +-
 .../src/main/services/config/legacy-prefs.ts       |   60 -
 .../services/config/notification-policy.test.ts    |    6 +
 .../main/services/config/notification-policy.ts    |   12 +-
 .../main/services/config/prefs-defaults.test.ts    |    4 +-
 .../main/services/config/renderer-state.test.ts    |  101 +-
 .../src/main/services/config/renderer-state.ts     |  177 -
 .../main/services/config/system-policies.test.ts   |   11 +-
 .../services/connectors/connector-flow-service.ts  |    3 -
 .../main/services/conversation/conversation-key.ts |   15 -
 .../src/main/services/debug-sync/agui-sync.test.ts |    1 -
 .../main/services/device/device-stream-service.ts  |    7 -
 .../src/main/services/diagnostics/log-store.ts     |    4 -
 apps/desktop/src/main/services/layout.test.ts      |    2 -
 .../main/services/mcp/agent-tools-present.test.ts  |    4 +-
 .../main/services/mcp/mcp-agent-tools-server.ts    |    4 +-
 .../main/services/mcp/mcp-browser-server.test.ts   |    4 +-
 .../src/main/services/mcp/mcp-browser-server.ts    |    6 +-
 .../src/main/services/mcp/mcp-oauth-service.ts     |    3 -
 .../services/messaging/messaging-config-service.ts |   18 -
 apps/desktop/src/main/services/pptx/xml.ts         |   20 -
 .../src/main/services/providers/abacus-host.ts     |    2 -
 .../src/main/services/session/agent-busy.test.ts   |    8 +-
 .../services/session/cli-manager-service.test.ts   |    2 +-
 .../main/services/session/cli-manager-service.ts   |   47 +-
 .../main/services/session/cli-manager-taps.test.ts |   89 +-
 .../main/services/session/cli-manager-wire.test.ts |   27 +-
 .../legacy-transcript-fixture.test-support.ts      |   79 +
 .../src/main/services/session/thread-store.test.ts |   89 +-
 .../src/main/services/session/thread-store.ts      |  100 +-
 .../main/services/session/transcript-service.ts    |   55 +-
 .../updates/experience/active-experience.ts        |    3 -
 .../experience/experience-activation.test.ts       |    9 +-
 .../updates/experience/experience-updater.ts       |   12 +-
 .../updates/experience/health-check.test.ts        |   12 +-
 .../services/updates/experience/health-check.ts    |   15 +-
 .../src/main/services/updates/update-handler.ts    |   17 -
 .../src/main/services/updates/update-service.ts    |    2 -
 apps/desktop/src/main/startup-theme.test.ts        |   47 -
 apps/desktop/src/main/startup-theme.ts             |    6 +-
 .../desktop/src/main/window-chrome-options.test.ts |   52 -
 apps/desktop/src/main/window-chrome-options.ts     |   48 +-
 apps/desktop/src/main/window-chrome.e2e-entry.ts   |    2 -
 apps/desktop/src/preload/bridge.ts                 | 1090 -----
 .../src/preload/browser-runtime-bridge.test.ts     |   57 -
 apps/desktop/src/preload/index.d.ts                |  197 -
 apps/desktop/src/preload/index.ts                  |   15 +-
 apps/desktop/src/preload/main-preload.ts           |  302 +-
 apps/desktop/src/preload/parity.test.ts            |  312 --
 apps/desktop/src/preload/preload-exposure.test.ts  |   75 +-
 .../src/preload/terminal-runtime-bridge.test.ts    |   52 -
 apps/desktop/src/preload/worktree-bridge.test.ts   |   66 -
 apps/desktop/src/renderer-next/env.d.ts            |   38 -
 .../src/renderer-next/features/artifacts/parity.ts |  108 -
 .../features/bots/chat/connector-requests.ts       |    6 -
 .../features/bots/model/model-groups.ts            |    1 -
 .../src/renderer-next/features/bots/parity.ts      |  544 ---
 .../src/renderer-next/features/library/parity.ts   |  151 -
 .../src/renderer-next/features/notch/parity.ts     |   47 -
 .../renderer-next/features/onboarding/parity.ts    |  209 -
 .../src/renderer-next/features/routines/parity.ts  |  185 -
 .../src/renderer-next/features/sessions/parity.ts  | 1073 -----
 .../src/renderer-next/features/settings/parity.ts  |  194 -
 .../renderer-next/features/shell/browser-open.tsx  |   60 -
 apps/desktop/src/renderer-next/lib/changelog.ts    |   34 -
 apps/desktop/src/renderer-next/lib/cn.ts           |    1 -
 .../src/renderer-next/lib/i18n/dynamic-keys.ts     |  658 ---
 .../src/renderer-next/lib/i18n/phase5.keys.test.ts |   79 -
 .../renderer-next/lib/i18n/sessions.keys.test.ts   |   37 -
 apps/desktop/src/renderer-next/main.tsx            |  210 -
 apps/desktop/src/renderer-next/router.test.tsx     |  224 -
 apps/desktop/src/renderer-next/router.tsx          |  162 -
 .../src/renderer-next/test-support/setup.ts        |   80 -
 .../__snapshots__/router.test.tsx.snap             |    0
 apps/desktop/src/renderer/app.test.ts              |   93 -
 apps/desktop/src/renderer/app.tsx                  |  198 -
 apps/desktop/src/renderer/assets/base.css          | 1063 -----
 .../src/renderer/assets/connectors/confluence.png  |  Bin 35307 -> 0 bytes
 .../src/renderer/assets/connectors/docusign.webp   |  Bin 3858 -> 0 bytes
 .../src/renderer/assets/connectors/dropbox.png     |  Bin 21495 -> 0 bytes
 .../src/renderer/assets/connectors/figma.webp      |  Bin 7552 -> 0 bytes
 .../desktop/src/renderer/assets/connectors/gcs.png |  Bin 22740 -> 0 bytes
 .../src/renderer/assets/connectors/github.webp     |  Bin 9682 -> 0 bytes
 .../src/renderer/assets/connectors/gmail.png       |  Bin 8038 -> 0 bytes
 .../assets/connectors/google_calendar.webp         |  Bin 19598 -> 0 bytes
 .../renderer/assets/connectors/google_drive.webp   |  Bin 136014 -> 0 bytes
 .../src/renderer/assets/connectors/jira.webp       |  Bin 10914 -> 0 bytes
 .../src/renderer/assets/connectors/onedrive.webp   |  Bin 17024 -> 0 bytes
 .../src/renderer/assets/connectors/outlook.webp    |  Bin 9770 -> 0 bytes
 .../src/renderer/assets/connectors/slack.png       |  Bin 57320 -> 0 bytes
 apps/desktop/src/renderer/assets/connectors/x.webp |  Bin 17490 -> 0 bytes
 .../src/renderer/assets/connectors/zoom.webp       |  Bin 20562 -> 0 bytes
 .../src/renderer/assets/error-img-back2.webp       |  Bin 939296 -> 0 bytes
 apps/desktop/src/renderer/assets/icon2.png         |  Bin 625545 -> 0 bytes
 apps/desktop/src/renderer/assets/main.css          |    2 -
 .../components/app-icon/index.tsx                  |    0
 .../components/bot-avatar/bot-avatar.test.tsx      |    4 +-
 .../components/bot-avatar/index.tsx                |    9 +-
 .../components/bot-avatar/moods.css                |    0
 .../components/bot-memory-list/index.tsx           |    4 +-
 .../renderer/components/bots/bot-avatar-picker.tsx |  112 -
 .../src/renderer/components/bots/bot-avatar.tsx    |   83 -
 .../renderer/components/bots/bot-dialog.test.tsx   |  220 -
 .../src/renderer/components/bots/bot-dialog.tsx    |   28 -
 .../renderer/components/bots/bot-templates.test.ts |  129 -
 .../src/renderer/components/bots/bot-templates.ts  |    1 -
 .../renderer/components/bots/bots-home.test.tsx    |  280 --
 .../src/renderer/components/bots/bots-home.tsx     |  338 --
 .../renderer/components/bots/bots-tree.test.tsx    |  117 -
 .../src/renderer/components/bots/bots-tree.tsx     |  456 --
 .../components/bots/new-bot-dialog.test.tsx        |  231 -
 .../renderer/components/bots/new-bot-dialog.tsx    |  486 --
 .../renderer/components/brand/abacus-bot-logo.tsx  |   99 -
 .../components/brand/abacus-bot-mascot.tsx         |   75 -
 .../browser-surface/browser-surface.test.tsx       |    0
 .../components/browser-surface/index.test.tsx      |    0
 .../components/browser-surface/index.tsx           |    0
 .../renderer/components/browser/browser-cursor.tsx |  191 -
 .../browser/browser-permission-prompt.test.tsx     |  138 -
 .../browser/browser-permission-prompt.tsx          |  150 -
 .../browser/browser-runtime-surface.test.tsx       |  189 -
 .../components/browser/browser-runtime-surface.tsx |  559 ---
 .../browser/browser-settings-dialog.test.tsx       |  179 -
 .../components/browser/browser-settings-dialog.tsx |  414 --
 .../renderer/components/browser/pptx-viewer.tsx    |  686 ---
 .../renderer/components/browser/preview-panel.tsx  |  314 --
 .../src/renderer/components/chat/agent-message.tsx |  614 ---
 .../src/renderer/components/chat/agents-panel.tsx  |  174 -
 .../components/chat/bot-message-list.test.tsx      |  438 --
 .../renderer/components/chat/bot-message-list.tsx  |  401 --
 .../src/renderer/components/chat/branch-picker.tsx |  168 -
 .../src/renderer/components/chat/bubble-width.ts   |    7 -
 .../components/chat/chat-composer.test.tsx         |  727 ---
 .../src/renderer/components/chat/chat-composer.tsx | 2818 ------------
 .../src/renderer/components/chat/chat-panel.tsx    | 2364 ----------
 .../renderer/components/chat/component-tools.ts    |  111 -
 .../components/chat/composer-tasks.test.tsx        |   86 -
 .../renderer/components/chat/composer-tasks.tsx    |  214 -
 .../components/chat/composer-update-strip.test.tsx |  284 --
 .../components/chat/composer-update-strip.tsx      |   93 -
 .../components/chat/composer-worktree.test.ts      |   70 -
 .../renderer/components/chat/composer-worktree.ts  |   29 -
 .../chat/connector-request-card.test.tsx           |  477 --
 .../components/chat/connector-request-card.tsx     |  235 -
 .../components/chat/deliverables-pill.test.tsx     |  105 -
 .../renderer/components/chat/deliverables-pill.tsx |  141 -
 .../renderer/components/chat/deliverables.test.ts  |  149 -
 .../src/renderer/components/chat/deliverables.ts   |  144 -
 .../components/chat/dictation-button.test.tsx      |  103 -
 .../renderer/components/chat/dictation-button.tsx  |   79 -
 .../renderer/components/chat/feedback-row.test.tsx |  164 -
 .../src/renderer/components/chat/feedback-row.tsx  |  381 --
 .../components/chat/file-mention-picker.test.tsx   |   79 -
 .../components/chat/file-mention-picker.tsx        |  133 -
 .../src/renderer/components/chat/greeting.tsx      |  132 -
 .../renderer/components/chat/injected-text.test.ts |   50 -
 .../src/renderer/components/chat/injected-text.ts  |   18 -
 .../components/chat/message-authorship.test.tsx    |  143 -
 .../components/chat/message-reactions.test.tsx     |   64 -
 .../renderer/components/chat/message-reactions.tsx |   41 -
 .../renderer/components/chat/model-picker.test.tsx |  331 --
 .../src/renderer/components/chat/model-picker.tsx  |  576 ---
 .../components/chat/pending-steers.test.tsx        |   72 -
 .../renderer/components/chat/pending-steers.tsx    |  138 -
 .../components/chat/premium-upgrade-card.test.tsx  |  282 --
 .../components/chat/premium-upgrade-card.tsx       |  211 -
 .../components/chat/provider-mark.test.tsx         |   36 -
 .../src/renderer/components/chat/provider-mark.tsx |  100 -
 .../renderer/components/chat/render-utils.test.ts  |  124 -
 .../src/renderer/components/chat/render-utils.ts   |  472 --
 .../components/chat/runtime-mode-picker.tsx        |  154 -
 .../components/chat/session-starters.test.ts       |   96 -
 .../renderer/components/chat/session-starters.ts   |   81 -
 .../src/renderer/components/chat/shimmer-text.tsx  |   13 -
 .../components/chat/slash-command-menu.tsx         |   75 -
 .../src/renderer/components/chat/subtask-card.tsx  |  299 --
 .../renderer/components/chat/thinking-loader.tsx   |   45 -
 .../components/chat/tool-group-logic.test.ts       |   61 -
 .../renderer/components/chat/tool-group-logic.ts   |  144 -
 .../renderer/components/chat/tool-group.test.tsx   |   70 -
 .../src/renderer/components/chat/tool-group.tsx    | 1588 -------
 .../components/chat/workspace-picker.test.tsx      |   91 -
 .../renderer/components/chat/workspace-picker.tsx  |  120 -
 .../components/chat/worktree-picker.test.tsx       |  127 -
 .../renderer/components/chat/worktree-picker.tsx   |  141 -
 .../components/common/critical-update-dialog.tsx   |  106 -
 .../src/renderer/components/common/dialog.tsx      |  185 -
 .../renderer/components/common/error-boundary.tsx  |  196 -
 .../components/common/home-update-banner.test.tsx  |  135 -
 .../components/common/home-update-banner.tsx       |  115 -
 .../renderer/components/common/image-lightbox.tsx  |   52 -
 .../components/common/markdown-highlighter.ts      |   11 -
 .../components/common/markdown-links.test.tsx      |   84 -
 .../components/common/markdown-local-links.test.ts |   56 -
 .../components/common/markdown-local-links.ts      |   47 -
 .../renderer/components/common/markdown.test.tsx   |  106 -
 .../src/renderer/components/common/markdown.tsx    |  542 ---
 .../src/renderer/components/common/update-pill.tsx |   75 -
 .../common/update-stalled-banner.test.tsx          |   94 -
 .../components/common/update-stalled-banner.tsx    |   28 -
 .../components/common/use-update-status.ts         |   54 -
 .../components/common/visualizer-links.test.tsx    |  113 -
 .../components/common/visualizer-segment.tsx       |  383 --
 .../connector-mark/connector-mark.test.tsx         |    0
 .../components/connector-mark/index.tsx            |    2 +-
 .../connector-request-card.test.tsx                |    2 +-
 .../components/connector-request-card/index.tsx    |    8 +-
 .../components/connectors/connect-flow.tsx         |  335 --
 .../components/device/crop.test.ts                 |    0
 .../components/device/crop.ts                      |    0
 .../renderer/components/device/device-panel.tsx    | 1296 ------
 .../components/device/device-screen-stream.ts      |  406 --
 .../components/device/device-settings-dialog.tsx   |  247 --
 .../components/device/stream-player.test.ts        |    0
 .../components/device/stream-player.ts             |    0
 .../components/diff-view/index.tsx                 |    0
 .../components/empty-state/index.tsx               |    4 +-
 .../components/file-preview/deliverables-card.tsx  |    4 +-
 .../components/file-preview/file-preview.test.tsx  |    2 +-
 .../components/file-preview/file-preview.tsx       |    6 +-
 .../components/file-preview/index.ts               |    0
 .../components/file-preview/paths.ts               |    0
 .../components/file-preview/pptx-slides.tsx        |    0
 .../components/file-tree/file-tree.test.tsx        |    2 +-
 .../components/file-tree/index.tsx                 |    0
 .../components/form-kit/confirm.tsx                |    4 +-
 .../components/form-kit/controls.tsx               |    6 +-
 .../components/form-kit/index.tsx                  |   10 +-
 .../components/form-kit/page.tsx                   |    2 +-
 .../components/keymap-editor/conflicts.test.ts     |    0
 .../components/keymap-editor/index.tsx             |   12 +-
 .../renderer/components/layout/chat-stamp.test.ts  |   61 -
 .../layout/credits-exhausted-card.test.tsx         |  314 --
 .../components/layout/credits-exhausted-card.tsx   |  284 --
 .../renderer/components/layout/deepagent-card.tsx  |   34 -
 .../renderer/components/layout/focused-page.tsx    |  113 -
 .../components/layout/focused-titlebar.tsx         |   81 -
 .../components/layout/focused-tool-layout.test.tsx |  102 -
 .../components/layout/focused-tool-layout.tsx      |  134 -
 .../components/layout/in-pane-settings.tsx         |   81 -
 .../renderer/components/layout/referral-card.tsx   |   61 -
 .../layout/secondary-sidebar-panel.test.tsx        |  448 --
 .../components/layout/secondary-sidebar-panel.tsx  |  601 ---
 .../components/layout/session-list-utils.test.ts   |   53 -
 .../components/layout/session-list-utils.ts        |  301 --
 .../components/layout/sidebar-scroll.test.ts       |   45 -
 .../renderer/components/layout/sidebar-scroll.ts   |   40 -
 .../components/layout/sidebar-section-label.tsx    |   57 -
 .../src/renderer/components/layout/titlebar.tsx    |  383 --
 .../src/renderer/components/layout/upsell-card.tsx |  112 -
 .../components/layout/window-drag-region.tsx       |   13 -
 .../components/layout/workspace-sidebar.tsx        |  193 -
 .../layout/workspace-view.shell.test.tsx           |  534 ---
 .../renderer/components/layout/workspace-view.tsx  |  644 ---
 .../local-models/local-model-dialog.test.tsx       |  194 -
 .../components/local-models/local-model-dialog.tsx |  174 -
 .../local-models/local-models-section.test.tsx     |  105 -
 .../local-models/local-models-section.tsx          |  127 -
 .../mcp/abacus-connectors-summary.test.tsx         |  101 -
 .../components/mcp/abacus-connectors-summary.tsx   |   95 -
 .../components/mcp/mcp-management-panel.tsx        |  741 ----
 .../renderer/components/mcp/mcp-server-form.tsx    |  427 --
 .../components/model-groups/index.ts               |    0
 .../components/nav-list/index.tsx                  |   16 +-
 .../components/onboarding/connectors-step.test.tsx |  309 --
 .../components/onboarding/connectors-step.tsx      |  291 --
 .../onboarding/first-bot-dialog.test.tsx           |  147 -
 .../components/onboarding/first-bot-dialog.tsx     |  134 -
 .../components/onboarding/onboarding-flow.test.tsx |  518 ---
 .../components/onboarding/onboarding-flow.tsx      |  267 --
 .../components/onboarding/onboarding-steps.test.ts |  160 -
 .../components/onboarding/onboarding-steps.ts      |   94 -
 .../onboarding/provider-setup-step.test.tsx        |  394 --
 .../components/onboarding/provider-setup-step.tsx  |  413 --
 .../components/onboarding/sign-in-step.tsx         |  280 --
 .../renderer/components/onboarding/tour-stops.ts   |  128 -
 .../components/onboarding/tour-tooltip.tsx         |  159 -
 .../components/onboarding/welcome-step.tsx         |   81 -
 .../components/onboarding/welcome-tour.test.tsx    |  338 --
 .../components/onboarding/welcome-tour.tsx         |  227 -
 .../components/route-sheet/index.tsx               |    2 +-
 .../components/route-sheet/route-sheet.test.tsx    |    2 +-
 .../components/routines/routine-page.test.tsx      |  212 -
 .../renderer/components/routines/routine-page.tsx  |  493 ---
 .../components/routines/routine-runs-rail.tsx      |  116 -
 .../components/routines/routines-tree.test.tsx     |  163 -
 .../renderer/components/routines/routines-tree.tsx |  207 -
 .../components/settings/capabilities-panel.tsx     |  527 ---
 .../components/settings/changelog-panel.tsx        |   72 -
 .../components/settings/connector-logo.test.tsx    |   40 -
 .../components/settings/connector-logo.tsx         |  220 -
 .../components/settings/connector-logos.ts         |   40 -
 .../components/settings/connectors-panel.test.tsx  |  432 --
 .../components/settings/connectors-panel.tsx       |  701 ---
 .../components/settings/memory-panel.test.tsx      |  235 -
 .../renderer/components/settings/memory-panel.tsx  |  497 ---
 .../settings/messaging-connectors.test.tsx         |  286 --
 .../components/settings/messaging-connectors.tsx   | 1187 -----
 .../components/settings/models-panel.test.tsx      |  366 --
 .../renderer/components/settings/models-panel.tsx  |  500 ---
 .../settings/notification-settings-dialog.tsx      |  125 -
 .../components/settings/profile-panel.test.tsx     |  130 -
 .../renderer/components/settings/profile-panel.tsx |  205 -
 .../components/settings/provider-key-dialog.tsx    |  173 -
 .../components/settings/referrals-panel.test.tsx   |  259 --
 .../components/settings/referrals-panel.tsx        |  625 ---
 .../components/settings/routine-schedule.test.ts   |   99 -
 .../components/settings/routine-schedule.ts        |    1 -
 .../components/settings/routine-templates.ts       |  115 -
 .../components/settings/routines-panel.test.tsx    |  370 --
 .../components/settings/routines-panel.tsx         | 1049 -----
 .../components/settings/settings-menu.test.tsx     |  279 --
 .../renderer/components/settings/settings-menu.tsx |  396 --
 .../components/settings/usage-panel.test.tsx       |  157 -
 .../renderer/components/settings/usage-panel.tsx   |  413 --
 .../components/skills/skills-management-panel.tsx  |  617 ---
 .../components/sound-preview/index.tsx             |    4 +-
 .../components/sound-preview/probe.tsx             |    2 +-
 .../components/spotlight/geometry.test.ts          |    0
 .../components/spotlight/geometry.ts               |    0
 .../components/spotlight/index.tsx                 |    0
 .../components/spotlight/spotlight.test.tsx        |    0
 .../components/terminal/ghostty.test.ts            |    0
 .../components/terminal/ghostty.ts                 |    0
 .../components/terminal/keys.test.ts               |    2 +-
 .../components/terminal/keys.ts                    |    0
 .../components/terminal/terminal-output.test.ts    |  227 -
 .../components/terminal/terminal-output.ts         |  191 -
 .../components/terminal/terminal-panel.test.tsx    |  238 -
 .../components/terminal/terminal-panel.tsx         |  371 --
 .../src/renderer/components/ui/accordion.tsx       |   81 -
 .../src/renderer/components/ui/alert-dialog.tsx    |  185 -
 apps/desktop/src/renderer/components/ui/alert.tsx  |   76 -
 .../src/renderer/components/ui/attachment.tsx      |  207 -
 apps/desktop/src/renderer/components/ui/avatar.tsx |  107 -
 apps/desktop/src/renderer/components/ui/badge.tsx  |   52 -
 apps/desktop/src/renderer/components/ui/bubble.tsx |  128 -
 .../src/renderer/components/ui/button-group.tsx    |   87 -
 apps/desktop/src/renderer/components/ui/button.tsx |   56 -
 apps/desktop/src/renderer/components/ui/card.tsx   |  100 -
 .../src/renderer/components/ui/collapsible.tsx     |   19 -
 .../src/renderer/components/ui/combobox.tsx        |  298 --
 .../src/renderer/components/ui/context-menu.tsx    |  272 --
 apps/desktop/src/renderer/components/ui/dialog.tsx |  156 -
 .../src/renderer/components/ui/dropdown-menu.tsx   |  270 --
 apps/desktop/src/renderer/components/ui/empty.tsx  |  104 -
 apps/desktop/src/renderer/components/ui/field.tsx  |  236 -
 .../src/renderer/components/ui/hover-card.tsx      |   51 -
 apps/desktop/src/renderer/components/ui/index.ts   |   75 -
 .../src/renderer/components/ui/input-group.tsx     |  157 -
 apps/desktop/src/renderer/components/ui/input.tsx  |   20 -
 apps/desktop/src/renderer/components/ui/item.tsx   |  201 -
 apps/desktop/src/renderer/components/ui/label.tsx  |   18 -
 apps/desktop/src/renderer/components/ui/marker.tsx |   71 -
 .../renderer/components/ui/message-scroller.tsx    |  128 -
 .../desktop/src/renderer/components/ui/message.tsx |   92 -
 .../renderer/components/ui/native-select.test.tsx  |   37 -
 .../src/renderer/components/ui/native-select.tsx   |   65 -
 .../desktop/src/renderer/components/ui/popover.tsx |   90 -
 .../src/renderer/components/ui/resizable.tsx       |   48 -
 .../src/renderer/components/ui/scroll-area.tsx     |   55 -
 apps/desktop/src/renderer/components/ui/select.tsx |  203 -
 .../src/renderer/components/ui/separator.tsx       |   25 -
 apps/desktop/src/renderer/components/ui/sheet.tsx  |  137 -
 .../desktop/src/renderer/components/ui/sidebar.tsx |  730 ---
 .../src/renderer/components/ui/skeleton.tsx        |   13 -
 .../desktop/src/renderer/components/ui/spinner.tsx |   19 -
 apps/desktop/src/renderer/components/ui/switch.tsx |   30 -
 apps/desktop/src/renderer/components/ui/tabs.tsx   |   82 -
 .../src/renderer/components/ui/textarea.tsx        |   18 -
 .../src/renderer/components/ui/toggle-group.tsx    |   87 -
 .../src/renderer/components/ui/toggle.test.tsx     |  103 -
 apps/desktop/src/renderer/components/ui/toggle.tsx |   43 -
 .../desktop/src/renderer/components/ui/tooltip.tsx |   66 -
 .../components/workspace/artifacts-panel.test.tsx  |  226 -
 .../components/workspace/artifacts-panel.tsx       |  527 ---
 .../components/workspace/code-diff-full.tsx        |  409 --
 .../renderer/components/workspace/code-view.tsx    |   78 -
 .../components/workspace/explorer-panel.tsx        |  479 --
 .../components/workspace/monaco-file-editor.tsx    |  297 --
 .../components/workspace/sessions-tree.test.tsx    |  243 -
 .../components/workspace/sessions-tree.tsx         |  427 --
 .../workspace/workspace-activation.test.tsx        |  105 -
 .../components/workspace/workspace-activation.ts   |   70 -
 .../workspace/workspace-missing-dialog.tsx         |  110 -
 .../components/workspace/workspace-tree.tsx        | 1154 -----
 apps/desktop/src/renderer/connectors.ts            |   10 -
 .../src/renderer/conversation/agent-types.ts       |  708 ---
 .../conversation-reducer.hydrate.test.ts           |   74 -
 .../renderer/conversation/conversation-reducer.ts  | 1789 --------
 .../src/renderer/conversation/derivations.test.ts  |  177 -
 .../src/renderer/conversation/derivations.ts       | 1021 -----
 .../desktop/src/renderer/conversation/hydration.ts |  244 -
 apps/desktop/src/renderer/conversation/index.ts    |  108 -
 apps/desktop/src/renderer/conversation/labels.ts   |   71 -
 .../desktop/src/renderer/conversation/normalize.ts |   39 -
 .../conversation/notification-line.test.ts         |  154 -
 .../src/renderer/conversation/permission-mode.ts   |   14 -
 .../src/renderer/conversation/persistence.test.ts  |  222 -
 .../src/renderer/conversation/persistence.ts       |  206 -
 .../src/renderer/conversation/serialization.ts     |  189 -
 apps/desktop/src/renderer/conversation/store.tsx   |   98 -
 .../renderer/conversation/subtask-scope-store.ts   |   27 -
 .../src/renderer/conversation/temp-image-refs.ts   |   43 -
 .../src/renderer/conversation/tool-adapter.test.ts |  227 -
 .../src/renderer/conversation/tool-adapter.ts      |  130 -
 .../renderer/conversation/transport-bridge.test.ts | 1185 -----
 .../src/renderer/conversation/transport.test.ts    |   96 -
 .../desktop/src/renderer/conversation/transport.ts |  762 ----
 apps/desktop/src/renderer/conversation/types.ts    |  791 ----
 .../src/renderer/conversation/use-conversation.ts  |  662 ---
 .../renderer/conversation/user-file-refs.test.ts   |   23 -
 .../src/renderer/conversation/user-file-refs.ts    |   33 -
 .../{renderer-next => renderer}/data/ai/errors.ts  |    0
 .../{renderer-next => renderer}/data/ai/events.ts  |    0
 .../{renderer-next => renderer}/data/ai/index.ts   |    2 +-
 .../data/db/collections.test.tsx                   |    0
 .../data/db/fake-table.ts                          |    0
 .../{renderer-next => renderer}/data/db/filters.ts |    0
 .../{renderer-next => renderer}/data/db/index.ts   |    0
 .../data/db/ipc-collection-options.test.ts         |    0
 .../data/db/ipc-collection-options.ts              |    0
 .../{renderer-next => renderer}/data/db/prefs.ts   |    0
 .../{renderer-next => renderer}/data/db/status.ts  |    0
 .../{renderer-next => renderer}/data/db/tables.ts  |    0
 .../data/fixture-db/fixture-db.ts                  |    0
 .../data/fixture-db/fixture-table.ts               |    0
 .../data/fixture-db/memory-source.test.ts          |    0
 .../data/fixture-db/memory-source.ts               |    2 +-
 .../data/fixture-db/rows.ts                        |    0
 .../data/queries/invalidation.ts                   |    2 +-
 .../data/queries/live.test.ts                      |    2 +-
 .../data/queries/live.ts                           |    4 +-
 .../data/queries/settings.ts                       |    2 +-
 .../data/queries/system.ts                         |    2 +-
 .../data/queries/window.ts                         |    2 +-
 .../data/query-client.ts                           |    0
 .../data/transport/close-signal.ts                 |    0
 .../data/transport/close.test.ts                   |    0
 .../data/transport/create-transport.ts             |    0
 .../data/transport/fake-window.ts                  |    0
 .../data/transport/index.ts                        |    2 +-
 .../data/transport/lifecycle.test.ts               |    0
 .../data/transport/memory.ts                       |    0
 .../data/transport/message-port.test.ts            |    0
 .../data/transport/message-port.ts                 |    0
 .../data/transport/transport.test.ts               |    0
 .../data/transport/types.ts                        |    0
 .../data/transport/websocket.ts                    |    0
 apps/desktop/src/renderer/env.d.ts                 |   39 +-
 .../features/artifacts/data.test.ts                |    0
 .../features/artifacts/data.ts                     |    4 +-
 .../features/artifacts/gallery.ts                  |    0
 .../features/artifacts/index.tsx                   |   28 +-
 .../features/artifacts/open.test.ts                |    2 +-
 .../src/renderer/features/artifacts/parity.ts      |  159 +
 .../features/artifacts/thumbnail.tsx               |    2 +-
 .../features/artifacts/window.test.tsx             |    2 +-
 .../features/bots/avatar.tsx                       |    6 +-
 .../features/bots/bots.css                         |    0
 .../features/bots/chat/activity.test.tsx           |    8 +-
 .../features/bots/chat/activity.ts                 |    0
 .../features/bots/chat/connector-requests.test.tsx |    2 +-
 .../features/bots/chat/connector-requests.ts       |    6 +
 .../features/bots/chat/decorations.test.tsx        |    6 +-
 .../features/bots/chat/decorations.tsx             |   11 +-
 .../features/bots/chat/feedback.tsx                |    8 +-
 .../features/bots/chat/identity.tsx                |    8 +-
 .../features/bots/chat/preview.test.tsx            |    2 +-
 .../features/bots/chat/preview.ts                  |    6 +-
 .../features/bots/chat/slots.tsx                   |   12 +-
 .../features/bots/chat/transcript.test.tsx         |    6 +-
 .../features/bots/check-in/check-in-dialog.tsx     |   12 +-
 .../features/bots/check-in/fields.tsx              |   14 +-
 .../features/bots/data/attention.ts                |    0
 .../features/bots/data/bot-actions.ts              |   10 +-
 .../features/bots/data/data.test.ts                |   11 +-
 .../features/bots/data/invalidation.test.ts        |   11 +-
 .../features/bots/data/live.ts                     |    6 +-
 .../features/bots/data/loaders.ts                  |    6 +-
 .../features/bots/data/open-chat.ts                |    2 +-
 .../features/bots/data/queries.ts                  |    8 +-
 .../features/bots/data/search.ts                   |    4 +-
 .../features/bots/data/transport.ts                |    2 +-
 .../features/bots/data/unread-store.ts             |    0
 .../features/bots/data/use-attention.ts            |    2 +-
 .../features/bots/form/bot-form.tsx                |   20 +-
 .../features/bots/form/draft-store.ts              |   10 +-
 .../features/bots/form/editor.test.tsx             |    4 +-
 .../features/bots/form/form.test.tsx               |   14 +-
 .../features/bots/form/look-picker.tsx             |    8 +-
 .../features/bots/form/schema.ts                   |    4 +-
 .../features/bots/form/submit.ts                   |    6 +-
 .../features/bots/gallery/a11y.test.tsx            |    2 +-
 .../features/bots/gallery/sections.tsx             |   10 +-
 .../features/bots/index.ts                         |    6 +-
 .../features/bots/interactions.test.tsx            |    4 +-
 .../features/bots/model/model-groups.test.ts       |    0
 .../renderer/features/bots/model/model-groups.ts   |    1 +
 .../features/bots/model/picker.tsx                 |   14 +-
 .../features/bots/notify.test.ts                   |    8 +-
 .../features/bots/notify.ts                        |    8 +-
 .../features/bots/panel/bot-side-panel.tsx         |   31 +-
 apps/desktop/src/renderer/features/bots/parity.ts  |  734 +++
 .../features/bots/readiness.test.tsx               |    6 +-
 .../features/bots/sidebar/bot-menu.tsx             |    8 +-
 .../features/bots/sidebar/bot-row.tsx              |   16 +-
 .../features/bots/sidebar/bots-sidebar.tsx         |   24 +-
 .../features/bots/sidebar/delete-dialog.tsx        |   10 +-
 .../features/bots/sidebar/order.ts                 |    0
 .../features/bots/start/bot-start-page.tsx         |   18 +-
 .../features/bots/structure.test.ts                |   42 +-
 .../features/bots/watcher.tsx                      |   14 +-
 .../features/chat/chat-css.test.ts                 |    2 +-
 .../features/chat/chat.css                         |    0
 .../features/chat/composer/attachments.ts          |    0
 .../features/chat/composer/chips.tsx               |   12 +-
 .../features/chat/composer/composer.test.tsx       |    0
 .../features/chat/composer/composer.tsx            |   25 +-
 .../features/chat/composer/draft-store.ts          |    2 +-
 .../features/chat/composer/modes.ts                |    0
 .../features/chat/composer/public-api.test.tsx     |    0
 .../features/chat/composer/queue-editing.ts        |    0
 .../features/chat/composer/start-composer.tsx      |    0
 .../features/chat/composer/triggers.tsx            |    2 +-
 .../features/chat/fixtures/ai-router.ts            |    2 +-
 .../features/chat/fixtures/builders.ts             |    0
 .../features/chat/fixtures/fixtures.test.ts        |    0
 .../features/chat/fixtures/goldens.ts              |    0
 .../features/chat/fixtures/perf/bench.tsx          |    0
 .../features/chat/fixtures/perf/extension.tsx      |    0
 .../features/chat/fixtures/perf/threads.ts         |    0
 .../features/chat/fixtures/player.ts               |    0
 .../features/chat/fixtures/relay.ts                |    2 +-
 .../features/chat/fixtures/scenarios.ts            |    0
 .../fixtures/scenarios/bot-housekeeping.agui.jsonl |    0
 .../fixtures/scenarios/bot-no-model.agui.jsonl     |    0
 .../scenarios/delegate-colliding-ids.agui.jsonl    |    0
 .../fixtures/scenarios/dequeue-idle.agui.jsonl     |    0
 .../scenarios/malformed-command.agui.jsonl         |    0
 .../chat/fixtures/scenarios/null-line.agui.jsonl   |    0
 .../scenarios/openllm-exhausted.agui.jsonl         |    0
 .../fixtures/scenarios/openllm-rotation.agui.jsonl |    0
 .../scenarios/permission-accept.agui.jsonl         |    0
 .../scenarios/permission-reject-message.agui.jsonl |    0
 .../scenarios/permission-two-calls.agui.jsonl      |    0
 .../chat/fixtures/scenarios/plain-text.agui.jsonl  |    0
 .../scenarios/queue-remove-clear.agui.jsonl        |    0
 .../scenarios/reset-conversation.agui.jsonl        |    0
 .../fixtures/scenarios/reset-mid-run.agui.jsonl    |    0
 .../fixtures/scenarios/stall-recovery.agui.jsonl   |    0
 .../chat/fixtures/scenarios/stall-twice.agui.jsonl |    0
 .../fixtures/scenarios/steer-and-queue.agui.jsonl  |    0
 .../fixtures/scenarios/stop-after-text.agui.jsonl  |    0
 .../fixtures/scenarios/stop-mid-stream.agui.jsonl  |    0
 .../scenarios/stop-then-message.agui.jsonl         |    0
 .../chat/fixtures/scenarios/todo-plan.agui.jsonl   |    0
 .../chat/fixtures/scenarios/tool-bash.agui.jsonl   |    0
 .../chat/fixtures/scenarios/turn-failed.agui.jsonl |    0
 .../features/chat/gallery/a11y.test.tsx            |    0
 .../features/chat/gallery/sections.tsx             |    2 +-
 .../features/chat/guards.test.ts                   |    4 +-
 .../features/chat/index.ts                         |   29 +-
 .../features/chat/kit/clock.ts                     |    0
 .../features/chat/kit/context.tsx                  |    0
 .../features/chat/kit/layout.tsx                   |   10 +-
 .../features/chat/kit/message-scope.ts             |    0
 .../features/chat/kit/message.tsx                  |   10 +-
 .../features/chat/kit/parts.test.tsx               |    0
 .../features/chat/kit/parts.tsx                    |   12 +-
 .../features/chat/kit/permissions/decisions.ts     |    0
 .../chat/kit/permissions/lifecycle.test.tsx        |    5 +-
 .../chat/kit/permissions/notch-acceptable.test.ts  |    0
 .../chat/kit/permissions/notch-acceptable.ts       |    0
 .../features/chat/kit/permissions/notch-list.tsx   |    2 +-
 .../chat/kit/permissions/permission-card.tsx       |   10 +-
 .../chat/kit/permissions/permission-list.tsx       |    2 +-
 .../chat/kit/permissions/presenters.test.tsx       |    2 +-
 .../features/chat/kit/permissions/presenters.ts    |    0
 .../features/chat/kit/permissions/selection.ts     |    0
 .../features/chat/kit/queue-slot.tsx               |    8 +-
 .../features/chat/kit/status.test.tsx              |    2 +-
 .../features/chat/kit/status/status.tsx            |   10 +-
 .../features/chat/kit/subagents/detail.tsx         |    0
 .../features/chat/kit/subagents/subagent-card.tsx  |    8 +-
 .../features/chat/kit/tools/normalize.test.ts      |    0
 .../features/chat/kit/tools/normalize.ts           |    0
 .../features/chat/kit/tools/tool-line.test.tsx     |    5 +-
 .../features/chat/kit/tools/tool-line.tsx          |    6 +-
 .../features/chat/kit/tools/tool-meta.ts           |    0
 .../features/chat/kit/tools/tool-widgets.tsx       |    0
 .../features/chat/kit/ui.tsx                       |    0
 .../features/chat/kit/view.test.tsx                |    0
 .../features/chat/kit/view.tsx                     |    6 +-
 .../features/chat/markdown/highlighter.ts          |    0
 .../features/chat/markdown/markdown.test.tsx       |    2 +-
 .../features/chat/markdown/markdown.tsx            |    4 +-
 .../features/chat/markdown/math.test.ts            |    0
 .../features/chat/markdown/math.ts                 |    0
 .../features/chat/markdown/prepass.ts              |    0
 .../features/chat/motion.test.ts                   |    2 +-
 .../features/chat/motion.ts                        |    2 +-
 .../chat/runtime/admission-uncertain.test.ts       |    5 +-
 .../features/chat/runtime/admission.test.ts        |    5 +-
 .../features/chat/runtime/admission.ts             |    2 +-
 .../features/chat/runtime/connection.test.ts       |    0
 .../features/chat/runtime/deferred.ts              |    0
 .../features/chat/runtime/dispatcher.test.ts       |    0
 .../features/chat/runtime/dispatcher.ts            |    0
 .../features/chat/runtime/envelope.test.ts         |    0
 .../features/chat/runtime/host-actions.test.ts     |    2 +-
 .../features/chat/runtime/host-actions.ts          |    2 +-
 .../features/chat/runtime/host.test.tsx            |    0
 .../features/chat/runtime/host.ts                  |    0
 .../features/chat/runtime/lifecycle.test.ts        |    0
 .../features/chat/runtime/load-abort.test.ts       |    2 +-
 .../features/chat/runtime/ordering.test.ts         |    0
 .../features/chat/runtime/positions.test.ts        |    0
 .../features/chat/runtime/pump.ts                  |    2 +-
 .../features/chat/runtime/queue.test.ts            |    5 +-
 .../features/chat/runtime/recovery.test.ts         |    5 +-
 .../features/chat/runtime/runtime.ts               |    4 +-
 .../features/chat/runtime/send.ts                  |    0
 .../features/chat/runtime/session.ts               |    2 +-
 .../features/chat/runtime/steer-ids.test.ts        |    2 +-
 .../features/chat/runtime/tool-diff.ts             |    0
 .../features/chat/runtime/user-echo.test.ts        |    2 +-
 .../features/chat/scroller/markers.test.tsx        |    4 +-
 .../features/chat/scroller/row-context.tsx         |    0
 .../features/chat/scroller/transcript.test.tsx     |    0
 .../features/chat/scroller/transcript.tsx          |    8 +-
 .../features/chat/scroller/window.ts               |    0
 .../features/chat/store/apply.test.ts              |    0
 .../features/chat/store/apply.ts                   |    0
 .../features/chat/store/json-patch.test.ts         |    0
 .../features/chat/store/json-patch.ts              |    0
 .../features/chat/store/selectors.ts               |    0
 .../features/chat/store/thread-store.ts            |    2 -
 .../features/chat/testing.tsx                      |   11 +-
 .../features/gallery/a11y.test.tsx                 |    4 +-
 .../features/gallery/atoms.tsx                     |   58 +-
 .../features/gallery/gallery.tsx                   |   18 +-
 .../features/gallery/index.ts                      |    0
 .../features/gallery/overlays.tsx                  |   28 +-
 .../features/gallery/search.ts                     |    2 +-
 .../features/library/connect-flow.test.ts          |    4 +-
 .../features/library/connect-flow.ts               |    8 +-
 .../features/library/connectors.tsx                |   24 +-
 .../features/library/globals.tsx                   |    4 +-
 .../features/library/index.tsx                     |   12 +-
 .../features/library/integration.test.tsx          |    2 +-
 .../features/library/mcp-runtime.test.tsx          |    4 +-
 .../features/library/mcp.tsx                       |   28 +-
 .../features/library/messaging.test.tsx            |    2 +-
 .../features/library/messaging.tsx                 |   26 +-
 .../src/renderer/features/library/parity.ts        |  222 +
 .../features/library/registry-bundle.test.ts       |    0
 .../features/library/search.ts                     |    4 +-
 .../features/library/skills-tools.tsx              |   26 +-
 .../features/library/skills.test.ts                |    0
 .../features/notch/director.test.ts                |    0
 .../features/notch/director.ts                     |    0
 .../features/notch/drafts.ts                       |    0
 .../features/notch/gallery.tsx                     |    8 +-
 .../features/notch/index.tsx                       |   26 +-
 .../features/notch/inputs.ts                       |   12 +-
 .../features/notch/inputs.visibility.test.tsx      |   14 +-
 .../features/notch/listening.tsx                   |    2 +-
 .../features/notch/notch.css                       |    0
 apps/desktop/src/renderer/features/notch/parity.ts |   61 +
 .../features/notch/permission-lineage.test.tsx     |    6 +-
 .../features/notch/presenter.test.ts               |    4 +-
 .../features/notch/presenter.ts                    |    2 +-
 .../features/notch/shape.ts                        |    0
 .../features/notch/shell.test.tsx                  |   26 +-
 .../features/notch/snooze.test.ts                  |    4 +-
 .../features/notch/snooze.ts                       |    0
 .../features/notch/sound-consumers.test.tsx        |   32 +-
 .../features/notch/structure.test.ts               |    6 +-
 .../features/notch/threads.test.ts                 |    6 +-
 .../features/onboarding/actions.ts                 |    6 +-
 .../features/onboarding/complete.test.ts           |    0
 .../features/onboarding/connect.test.ts            |    4 +-
 .../features/onboarding/connect.ts                 |    6 +-
 .../features/onboarding/first-bot.test.ts          |    4 +-
 .../features/onboarding/first-bot.ts               |    2 +-
 .../features/onboarding/gallery.tsx                |    6 +-
 .../features/onboarding/hatch.tsx                  |    6 +-
 .../features/onboarding/index.tsx                  |   26 +-
 .../features/onboarding/machine.test.ts            |    0
 .../features/onboarding/machine.ts                 |    2 +-
 .../features/onboarding/onboarding.css             |    0
 .../features/onboarding/pairing-banner.tsx         |   10 +-
 .../features/onboarding/parity.test.ts             |    6 +-
 .../src/renderer/features/onboarding/parity.ts     |  269 ++
 .../features/onboarding/steps/local-models.tsx     |    8 +-
 .../onboarding/steps/provider-key.test.tsx         |    4 +-
 .../features/onboarding/steps/provider-key.tsx     |   12 +-
 .../features/onboarding/store.test.ts              |    2 +-
 .../features/onboarding/store.ts                   |    2 +-
 .../features/parity.test.ts                        |   29 +-
 .../features/routines/attention.ts                 |    0
 .../features/routines/data.test.ts                 |    5 +-
 .../features/routines/data.ts                      |    4 +-
 .../features/routines/editor-chat.test.tsx         |    4 +-
 .../features/routines/form.test.tsx                |    6 +-
 .../features/routines/form.tsx                     |   30 +-
 .../features/routines/gallery.tsx                  |    2 +-
 .../features/routines/globals.test.tsx             |    4 +-
 .../features/routines/globals.tsx                  |   16 +-
 .../features/routines/index.tsx                    |    0
 .../features/routines/notify.test.ts               |    0
 .../features/routines/notify.ts                    |    2 +-
 .../features/routines/page.tsx                     |   32 +-
 .../src/renderer/features/routines/parity.ts       |  273 ++
 .../features/routines/row.test.tsx                 |    2 +-
 .../features/routines/row.tsx                      |   20 +-
 .../features/routines/run-requests.test.tsx        |    8 +-
 .../features/routines/run-requests.tsx             |    6 +-
 .../features/routines/schema.ts                    |    2 +-
 .../features/routines/sidebar.tsx                  |   18 +-
 .../features/sessions/browser/ask-host.tsx         |    4 +-
 .../features/sessions/browser/browser-tab.tsx      |    8 +-
 .../features/sessions/browser/local-file.test.tsx  |    0
 .../sessions/browser/local-materialization.ts      |    2 +-
 .../features/sessions/changes/changes-card.test.ts |    0
 .../features/sessions/changes/changes-card.tsx     |    2 +-
 .../features/sessions/changes/changes-tab.tsx      |   10 +-
 .../features/sessions/changes/changes.test.ts      |    0
 .../features/sessions/changes/diff-source.ts       |    2 +-
 .../sessions/changes/full-diff-dialog.test.tsx     |    4 +-
 .../features/sessions/changes/full-diff-dialog.tsx |    6 +-
 .../features/sessions/changes/review-store.ts      |    2 +-
 .../sessions/context/context-tray.test.tsx         |    4 +-
 .../features/sessions/context/context-tray.tsx     |   10 +-
 .../context/permission-terminal-action.tsx         |    2 +-
 .../features/sessions/context/tasks.test.ts        |    0
 .../features/sessions/context/tasks.tsx            |    4 +-
 .../sessions/context/workspace-missing.tsx         |    6 +-
 .../features/sessions/data/agent-identity.test.tsx |    0
 .../features/sessions/data/agent-start.test.ts     |    0
 .../features/sessions/data/agent-start.ts          |    2 +-
 .../features/sessions/data/attention.test.ts       |    0
 .../features/sessions/data/attention.ts            |    0
 .../sessions/data/checkout-identity.test.tsx       |    2 +-
 .../features/sessions/data/composer-model.ts       |    8 +-
 .../features/sessions/data/live.ts                 |    6 +-
 .../features/sessions/data/queries.ts              |    6 +-
 .../features/sessions/data/search.test.ts          |    2 +-
 .../features/sessions/data/search.ts               |    0
 .../features/sessions/data/session-actions.ts      |    4 +-
 .../features/sessions/data/unread-store.ts         |    0
 .../features/sessions/device/device-tab.test.tsx   |    4 +-
 .../features/sessions/device/device-tab.tsx        |   10 +-
 .../features/sessions/dock/dock-store.ts           |    0
 .../features/sessions/dock/dock.test.ts            |    0
 .../features/sessions/dock/layout.ts               |    0
 .../features/sessions/dock/panel-tabs-store.ts     |    2 +-
 .../features/sessions/dock/panel-tabs.test.ts      |    0
 .../features/sessions/dock/session-dock.test.tsx   |    2 +-
 .../features/sessions/dock/session-dock.tsx        |   16 +-
 .../sessions/dock/terminal-pending.test.tsx        |    2 +-
 .../features/sessions/files/files-tab.tsx          |   12 +-
 .../features/sessions/files/lazy-children.test.tsx |    0
 .../features/sessions/files/lazy-children.ts       |    0
 .../features/sessions/files/preview-bridge.ts      |    4 +-
 .../features/sessions/gallery/a11y.test.tsx        |    2 +-
 .../features/sessions/gallery/sections.tsx         |   12 +-
 .../features/sessions/globals.tsx                  |   16 +-
 .../features/sessions/index.ts                     |    0
 .../features/sessions/local-owners.test.tsx        |    4 +-
 .../features/sessions/notify.ts                    |    6 +-
 .../features/sessions/parity.test.ts               |    4 +-
 .../src/renderer/features/sessions/parity.ts       | 1622 +++++++
 .../features/sessions/session-workspace.tsx        |   12 +-
 .../features/sessions/sessions-pages.tsx           |    6 +-
 .../features/sessions/sessions-sidebar.test.tsx    |    4 +-
 .../features/sessions/sessions-sidebar.tsx         |   32 +-
 .../features/sessions/start/session-start-page.tsx |   14 +-
 .../sessions/start/start-recovery.test.tsx         |    2 +-
 .../sessions/start/start-resources.test.tsx        |    4 +-
 .../features/sessions/start/start-resources.tsx    |    6 +-
 .../features/sessions/start/start-session.test.ts  |    7 +-
 .../features/sessions/start/start-session.ts       |    6 +-
 .../features/sessions/starters.ts                  |    0
 .../features/sessions/structure.test.ts            |    6 +-
 .../features/sessions/terminal/output-pump.test.ts |    0
 .../features/sessions/terminal/output-pump.ts      |    0
 .../sessions/terminal/terminal-registry.ts         |    2 +-
 .../sessions/terminal/terminal-tab.test.tsx        |    0
 .../features/sessions/terminal/terminal-tab.tsx    |   11 +-
 .../features/settings/account-usage.tsx            |   14 +-
 .../features/settings/changelog.tsx                |   10 +-
 .../features/settings/companion.test.tsx           |    2 +-
 .../features/settings/companion.tsx                |   12 +-
 .../features/settings/credits.test.ts              |    0
 .../features/settings/credits.ts                   |    0
 .../features/settings/cross-apis.test.tsx          |    4 +-
 .../features/settings/environment.tsx              |   14 +-
 .../features/settings/index.tsx                    |   11 +-
 .../features/settings/invite.test.tsx              |    2 +-
 .../features/settings/invite.tsx                   |   20 +-
 .../features/settings/keyboard.test.tsx            |    2 +-
 .../features/settings/keyboard.tsx                 |    8 +-
 .../features/settings/local-models.test.tsx        |    2 +-
 .../features/settings/models.tsx                   |   24 +-
 .../features/settings/pages.test.tsx               |    2 +-
 .../features/settings/parity.test.ts               |    2 +-
 .../src/renderer/features/settings/parity.ts       |  286 ++
 .../features/settings/personal.tsx                 |   38 +-
 .../features/settings/search-index.test.ts         |    0
 .../features/settings/search-index.ts              |    6 +-
 .../features/settings/search.ts                    |    2 +-
 .../features/settings/shell.test.tsx               |    2 +-
 .../features/settings/structure.test.ts            |    4 +-
 .../features/settings/update-pill.test.tsx         |    2 +-
 .../features/settings/updates.test.ts              |    0
 .../features/settings/updates.tsx                  |   29 +-
 .../features/shell/app-root.tsx                    |   26 +-
 .../features/shell/app-toaster.tsx                 |    4 +-
 .../features/shell/breakpoints.ts                  |    0
 .../features/shell/browser-open.test.ts            |    0
 .../src/renderer/features/shell/browser-open.tsx   |   27 +
 .../features/shell/command-menu.tsx                |   14 +-
 .../features/shell/floating-intent.tsx             |    0
 .../features/shell/geometry.test.ts                |    0
 .../features/shell/geometry.ts                     |    0
 .../features/shell/hotkeys.test.tsx                |   12 +-
 .../features/shell/hotkeys.tsx                     |    4 +-
 .../features/shell/index.ts                        |    2 -
 .../features/shell/layout.test.ts                  |    0
 .../features/shell/layout.ts                       |    0
 .../features/shell/native-presenter.test.ts        |    0
 .../features/shell/native-presenter.ts             |    2 +-
 .../features/shell/notification-clicks.test.ts     |    0
 .../features/shell/notification-clicks.tsx         |    6 +-
 .../features/shell/occlusion.test.tsx              |    2 +-
 .../features/shell/occlusion.ts                    |    2 +-
 .../features/shell/preview-consumers.ts            |    0
 .../features/shell/rail.tsx                        |   12 +-
 .../features/shell/readiness.test.tsx              |    2 +-
 .../features/shell/readiness.tsx                   |    4 +-
 .../features/shell/screens.tsx                     |    6 +-
 .../features/shell/shell-a11y.test.tsx             |    8 +-
 .../features/shell/shell-layout.test.tsx           |   18 +-
 .../features/shell/shell-layout.tsx                |    8 +-
 .../features/shell/shell-store.ts                  |    2 +-
 .../features/shell/side-panel-slot.tsx             |    2 +-
 .../features/shell/side-panel.tsx                  |   12 +-
 .../features/shell/sidebar-slot.tsx                |    2 +-
 .../features/shell/sidebars.ts                     |   14 +-
 .../features/shell/top-bar-slots.test.tsx          |    0
 .../features/shell/top-bar-slots.tsx               |    0
 .../features/shell/top-bar.tsx                     |   16 +-
 .../features/shell/use-panel.ts                    |    2 +-
 .../features/shell/use-shell-match.ts              |    0
 .../features/shell/use-sidebar-toggle.ts           |    2 +-
 .../features/tour/completion.test.ts               |    0
 .../features/tour/completion.ts                    |    0
 .../features/tour/gallery.tsx                      |    4 +-
 .../features/tour/index.tsx                        |   12 +-
 .../features/tour/stops.ts                         |    2 +-
 .../features/tour/store.test.ts                    |    0
 .../features/tour/store.ts                         |    0
 .../src/{renderer-next => renderer}/guards.test.ts |   13 +-
 .../src/renderer/hooks/use-abacus-account.ts       |   19 -
 .../src/renderer/hooks/use-abacus-credential.ts    |   20 -
 .../renderer/hooks/use-agent-session-mutations.ts  |  302 --
 apps/desktop/src/renderer/hooks/use-bots.test.tsx  |   66 -
 apps/desktop/src/renderer/hooks/use-bots.ts        |  148 -
 .../hooks/use-connect-free-provider.test.tsx       |  117 -
 .../renderer/hooks/use-connect-free-provider.tsx   |   93 -
 .../src/renderer/hooks/use-connected-connectors.ts |   22 -
 .../src/renderer/hooks/use-connector-statuses.ts   |   66 -
 apps/desktop/src/renderer/hooks/use-keep-awake.ts  |   44 -
 .../desktop/src/renderer/hooks/use-local-models.ts |   98 -
 apps/desktop/src/renderer/hooks/use-mcp-runtime.ts |  224 -
 apps/desktop/src/renderer/hooks/use-mobile.ts      |   17 -
 .../src/renderer/hooks/use-model-providers.ts      |   39 -
 .../src/renderer/hooks/use-notifications.ts        |   59 -
 .../src/renderer/hooks/use-prompt-history.test.ts  |  166 -
 .../src/renderer/hooks/use-prompt-history.ts       |  101 -
 apps/desktop/src/renderer/hooks/use-referrals.ts   |   14 -
 apps/desktop/src/renderer/hooks/use-routines.ts    |  129 -
 apps/desktop/src/renderer/hooks/use-sandbox.ts     |   46 -
 .../src/renderer/hooks/use-session-workspace.ts    |   70 -
 .../src/renderer/hooks/use-terminal-shells.ts      |   46 -
 apps/desktop/src/renderer/hooks/use-theme.ts       |   83 -
 .../src/renderer/hooks/use-window-fullscreen.ts    |   25 -
 .../src/renderer/hooks/use-workspace-mutations.ts  |  391 --
 .../src/renderer/hooks/use-workspace-queries.ts    |  183 -
 .../renderer/hooks/use-workspace-refresh.test.tsx  |  249 --
 .../src/renderer/hooks/use-workspace-refresh.ts    |  393 --
 .../src/renderer/hooks/use-workspace-root.ts       |   31 -
 .../src/renderer/hooks/use-worktrees.test.tsx      |  165 -
 apps/desktop/src/renderer/hooks/use-worktrees.ts   |  180 -
 apps/desktop/src/renderer/i18n.test.ts             |   26 -
 apps/desktop/src/renderer/i18n.ts                  |  125 -
 apps/desktop/src/renderer/index.html               |   16 -
 apps/desktop/src/renderer/lib/abacus-credits.ts    |   24 -
 .../lib/abacus-links.ts                            |    2 +-
 .../src/renderer/lib/abacus-sign-in.test.ts        |   50 -
 apps/desktop/src/renderer/lib/abacus-sign-in.ts    |   37 -
 apps/desktop/src/renderer/lib/activity-beacon.ts   |   27 -
 .../{renderer-next => renderer}/lib/activity.ts    |    2 +-
 .../desktop/src/renderer/lib/agent-browser.test.ts |   77 -
 apps/desktop/src/renderer/lib/agent-browser.ts     |   66 -
 .../lib/attention/cues.ts                          |    0
 .../lib/attention/error-copy.ts                    |    0
 .../lib/attention/events.test.ts                   |    0
 .../lib/attention/events.ts                        |    0
 .../lib/attention/open-target.test.ts              |    0
 .../lib/attention/open-target.tsx                  |    2 +-
 .../lib/bootstrap.test.ts                          |   13 +-
 .../{renderer-next => renderer}/lib/bootstrap.ts   |    6 +-
 .../lib/bot-turns/bot-turns.test.ts                |    0
 .../lib/bot-turns/component-tools.ts               |    0
 .../lib/bot-turns/deliverables.ts                  |    0
 .../lib/bot-turns/gap-stamp.ts                     |    0
 .../lib/bot-turns/reactions.ts                     |    0
 .../lib/bot-turns/tool-parts.ts                    |    0
 .../lib/bot-turns/turns.ts                         |    0
 .../legacy-model-strings/check-in-prompt.txt       |    0
 .../legacy-model-strings/describe-check-in.json    |    0
 .../legacy-model-strings/name-only-mission.txt     |    0
 .../lib/bots/avatar.test.ts                        |    2 +-
 .../{renderer-next => renderer}/lib/bots/avatar.ts |    4 +-
 .../lib/bots/check-in.test.ts                      |    0
 .../lib/bots/check-in.ts                           |    0
 .../lib/bots/schedule.test.ts                      |    0
 .../lib/bots/schedule.ts                           |    0
 .../lib/bots/templates.test.ts                     |    0
 .../lib/bots/templates.ts                          |    0
 .../src/renderer/lib/browser-homepage.test.ts      |   27 -
 apps/desktop/src/renderer/lib/browser-homepage.ts  |   42 -
 apps/desktop/src/renderer/lib/changelog.test.ts    |   36 -
 .../lib/chat-appearance.css                        |    0
 apps/desktop/src/renderer/lib/cn.ts                |   12 +-
 .../src/renderer/lib/composer-draft.test.ts        |  120 -
 apps/desktop/src/renderer/lib/composer-draft.ts    |   65 -
 .../lib/connector-requests.ts                      |    4 +-
 .../lib/continuity.test.ts                         |    2 +-
 .../{renderer-next => renderer}/lib/continuity.ts  |    0
 .../lib/continuity/registry.ts                     |    4 +-
 .../src/renderer/lib/credential-refresh.test.ts    |  178 -
 .../desktop/src/renderer/lib/credential-refresh.ts |   63 -
 .../lib/dev/dev-hooks.ts                           |    6 +-
 .../lib/dev/settle.test.ts                         |    0
 .../{renderer-next => renderer}/lib/dev/settle.ts  |    0
 .../{renderer-next => renderer}/lib/devtools.tsx   |    4 +-
 .../lib/document-sound.ts                          |    2 +-
 .../src/renderer/lib/durable-storage.test.ts       |  142 -
 apps/desktop/src/renderer/lib/durable-storage.ts   |  118 -
 .../lib/file-highlight.ts                          |    0
 .../{renderer-next => renderer}/lib/format-time.ts |    0
 .../lib/format/chat-stamp.test.ts                  |    0
 .../lib/format/chat-stamp.ts                       |    0
 .../src/{renderer-next => renderer}/lib/hotkeys.ts |    0
 .../lib/i18n/i18n.test.ts                          |   22 +-
 .../{renderer-next => renderer}/lib/i18n/index.ts  |    2 +-
 .../lib/i18n/languages.ts                          |    0
 .../src/renderer/lib/i18n/phase5.keys.test.ts      |   17 +
 .../src/renderer/lib/i18n/sessions.keys.test.ts    |   35 +
 .../lib/inert-hidden.ts                            |    0
 .../lib/keyboard/action-bindings.tsx               |    6 +-
 .../lib/keyboard/actions.test.ts                   |    0
 .../lib/keyboard/actions.ts                        |    2 +-
 .../lib/keyboard/stop-action.test.tsx              |    8 +-
 .../lib/keyboard/use-app-hotkey.ts                 |    6 +-
 .../{renderer-next => renderer}/lib/log-ring.ts    |    2 +-
 apps/desktop/src/renderer/lib/mentions.test.ts     |   26 -
 apps/desktop/src/renderer/lib/mentions.ts          |  126 -
 .../src/{renderer-next => renderer}/lib/motion.ts  |    2 +-
 .../renderer/lib/native-surface-occlusion.test.ts  |   98 -
 .../src/renderer/lib/native-surface-occlusion.ts   |  148 -
 .../lib/navigation/app-link.tsx                    |    2 +-
 .../lib/navigation/areas.ts                        |    0
 .../lib/navigation/can-go-forward.ts               |    0
 .../lib/navigation/loaders.ts                      |    0
 .../lib/navigation/nav-type.ts                     |    2 +-
 .../lib/navigation/pane-key.ts                     |    2 +-
 .../lib/navigation/search.test.ts                  |    7 +-
 .../lib/navigation/search.ts                       |    0
 .../lib/navigation/shared-element.ts               |    2 +-
 .../lib/navigation/single-transition.test.ts       |    0
 .../lib/navigation/single-transition.ts            |    2 +-
 .../lib/navigation/transition-types.test.tsx       |    4 +-
 .../lib/navigation/transition-types.ts             |    2 +-
 .../lib/navigation/use-app-navigate.ts             |    2 +-
 .../lib/navigation/visible-thread.ts               |    0
 .../src/{renderer-next => renderer}/lib/notify.ts  |    0
 apps/desktop/src/renderer/lib/pane-title.test.ts   |   52 -
 apps/desktop/src/renderer/lib/pane-title.ts        |   34 -
 .../renderer/lib/permission-auto-resolve.test.ts   |  114 -
 .../src/renderer/lib/permission-auto-resolve.ts    |   60 -
 .../{renderer-next => renderer}/lib/platform.ts    |    0
 apps/desktop/src/renderer/lib/preview-tabs.ts      |  100 -
 apps/desktop/src/renderer/lib/query-keys.ts        |  171 -
 .../lib/readiness-queue.test.ts                    |    0
 .../lib/readiness-queue.ts                         |    0
 apps/desktop/src/renderer/lib/route-search.test.ts |   59 -
 apps/desktop/src/renderer/lib/route-search.ts      |   65 -
 .../lib/routines/templates.ts                      |    0
 .../lib/run-finished.test.ts                       |    2 +-
 .../lib/run-finished.ts                            |    4 +-
 .../src/renderer/lib/settings-query-keys.test.ts   |   29 -
 .../src/renderer/lib/settings-query-keys.ts        |   77 -
 .../lib/sidebar-conversation-route.test.ts         |   24 -
 .../src/renderer/lib/sidebar-conversation-route.ts |   41 -
 .../{renderer-next => renderer}/lib/sound.test.ts  |    0
 .../src/{renderer-next => renderer}/lib/sound.ts   |    0
 apps/desktop/src/renderer/lib/state-guard.test.ts  |   59 -
 .../lib/theme-effect.tsx                           |    2 +-
 .../lib/theme.bots.test.ts                         |    4 +-
 .../{renderer-next => renderer}/lib/theme.test.tsx |   15 +-
 .../src/{renderer-next => renderer}/lib/theme.ts   |    0
 .../src/{renderer-next => renderer}/lib/toast.ts   |    2 +-
 .../lib/tour/anchors.ts                            |    0
 .../desktop/src/renderer/lib/ui-continuity.test.ts |  189 -
 apps/desktop/src/renderer/lib/ui-continuity.ts     |  264 --
 .../lib/use-app-context.ts                         |    2 +-
 .../lib/use-debounced-value.ts                     |    0
 .../lib/use-media-query.ts                         |    0
 .../src/{renderer-next => renderer}/lib/use-now.ts |    0
 .../lib/voice/operation.test.ts                    |    0
 .../lib/voice/operation.ts                         |    0
 .../lib/voice/recorder.ts                          |    0
 .../lib/voice/use-dictation.ts                     |    2 +-
 .../lib/voice/whisper.ts                           |    2 +-
 apps/desktop/src/renderer/lib/window-chrome.ts     |   33 -
 .../lib/window-chrome/chrome-state.tsx             |    4 +-
 .../lib/window-chrome/overlay-slots.test.ts        |    0
 .../lib/window-chrome/overlay-slots.ts             |    0
 .../lib/window-chrome/use-titlebar-area.test.ts    |    4 +-
 .../lib/window-chrome/use-titlebar-area.ts         |    0
 apps/desktop/src/renderer/lib/workspace-route.ts   |   21 -
 apps/desktop/src/renderer/lib/workspace-utils.ts   |   12 -
 apps/desktop/src/renderer/locales/de-DE.json       | 1184 +----
 apps/desktop/src/renderer/locales/en-US.json       | 1184 +----
 apps/desktop/src/renderer/locales/es-419.json      | 1184 +----
 apps/desktop/src/renderer/locales/es-ES.json       | 1184 +----
 apps/desktop/src/renderer/locales/fr-FR.json       | 1184 +----
 apps/desktop/src/renderer/locales/hi-IN.json       | 1184 +----
 apps/desktop/src/renderer/locales/id-ID.json       | 1184 +----
 apps/desktop/src/renderer/locales/it-IT.json       | 1184 +----
 apps/desktop/src/renderer/locales/ja-JP.json       | 1184 +----
 apps/desktop/src/renderer/locales/ko-KR.json       | 1184 +----
 apps/desktop/src/renderer/locales/pt-BR.json       | 1184 +----
 apps/desktop/src/renderer/main.tsx                 |  233 +-
 .../{renderer-next => renderer}/notch-context.ts   |    8 +-
 .../{renderer-next => renderer}/notch-router.tsx   |    2 +-
 .../notch-routes/-notch-router.test.ts             |    0
 .../notch-routes/__root.tsx                        |    6 +-
 .../notch-routes/approval.$id.tsx                  |    6 +-
 .../notch-routes/call.tsx                          |    2 +-
 .../notch-routes/done.tsx                          |    2 +-
 .../notch-routes/failed.tsx                        |    2 +-
 .../notch-routes/idle.tsx                          |    2 +-
 .../notch-routes/reply.$id.tsx                     |    4 +-
 .../notch-routes/working.tsx                       |    2 +-
 .../src/{renderer-next => renderer}/notch.tsx      |   18 +-
 .../notchRouteTree.gen.ts                          |    0
 .../renderer/providers/preview-link-context.tsx    |   20 -
 .../src/renderer/providers/query-provider.tsx      |   32 -
 .../providers/workspace-state-provider.tsx         |   68 -
 .../renderer/providers/workspace-state-types.ts    |   16 -
 .../renderer/providers/workspace-state-utils.ts    |  122 -
 .../{renderer-next => renderer}/routeTree.gen.ts   |    0
 apps/desktop/src/renderer/router.test.tsx          |  382 +-
 apps/desktop/src/renderer/router.tsx               |  686 +--
 .../routes/-phase5.routes.test.tsx                 |    2 +-
 .../routes/-phase6.routes.test.tsx                 |    6 +-
 .../{renderer-next => renderer}/routes/__root.tsx  |   16 +-
 .../{renderer-next => renderer}/routes/_bare.tsx   |    2 +-
 .../routes/_bare/[__ui].tsx                        |   37 +-
 .../routes/_bare/onboarding.$step.tsx              |   18 +-
 .../routes/_bare/onboarding.index.tsx              |    4 +-
 .../routes/_bare/onboarding.tsx                    |    7 +-
 .../{renderer-next => renderer}/routes/_shell.tsx  |   26 +-
 .../routes/_shell/(artifacts)/artifacts.index.tsx  |    8 +-
 .../routes/_shell/(artifacts)/artifacts.tsx        |    0
 .../routes/_shell/(bots)/-browser.tsx              |   10 +-
 .../routes/_shell/(bots)/bots.$botId.check-in.tsx  |    2 +-
 .../routes/_shell/(bots)/bots.$botId.details.tsx   |    0
 .../routes/_shell/(bots)/bots.$botId.tsx           |   14 +-
 .../(bots)/bots.$botId_.chats.$sessionId.tsx       |   10 +-
 .../routes/_shell/(bots)/bots.$botId_.edit.tsx     |    2 +-
 .../routes/_shell/(bots)/bots.index.tsx            |    0
 .../routes/_shell/(bots)/bots.new.tsx              |    4 +-
 .../routes/_shell/(bots)/bots.tsx                  |    4 +-
 .../routes/_shell/(library)/library.connectors.tsx |    6 +-
 .../routes/_shell/(library)/library.index.tsx      |    0
 .../routes/_shell/(library)/library.mcp.tsx        |    4 +-
 .../routes/_shell/(library)/library.messaging.tsx  |    4 +-
 .../routes/_shell/(library)/library.skills.tsx     |    4 +-
 .../_shell/(library)/library.tools.$toolsetId.tsx  |    4 +-
 .../_shell/(library)/library.tools.index.tsx       |    4 +-
 .../routes/_shell/(library)/library.tsx            |    0
 .../_shell/(routines)/routines.$routineId.edit.tsx |    2 +-
 .../_shell/(routines)/routines.$routineId.tsx      |   17 +-
 .../_shell/(routines)/routines._list.index.tsx     |    0
 .../_shell/(routines)/routines._list.new.tsx       |    6 +-
 .../routes/_shell/(routines)/routines._list.tsx    |    4 +-
 .../routes/_shell/(routines)/routines.tsx          |    0
 .../_shell/(sessions)/sessions.$sessionId.diff.tsx |    8 +-
 .../_shell/(sessions)/sessions.$sessionId.tsx      |   19 +-
 .../(sessions)/sessions.$sessionId_.review.tsx     |    0
 .../routes/_shell/(sessions)/sessions.index.tsx    |    4 +-
 .../routes/_shell/(sessions)/sessions.new.tsx      |   12 +-
 .../routes/_shell/(sessions)/sessions.tsx          |    0
 .../routes/_shell/index.tsx                        |    0
 .../routes/_shell/settings.about.tsx               |    4 +-
 .../routes/_shell/settings.about_.changelog.tsx    |    2 +-
 .../routes/_shell/settings.account.tsx             |    9 +-
 .../routes/_shell/settings.appearance.tsx          |    4 +-
 .../routes/_shell/settings.browser.tsx             |    2 +-
 .../routes/_shell/settings.devices.tsx             |    2 +-
 .../routes/_shell/settings.environment.tsx         |    4 +-
 .../routes/_shell/settings.general.tsx             |    4 +-
 .../routes/_shell/settings.index.tsx               |    0
 .../routes/_shell/settings.keyboard.tsx            |    2 +-
 .../routes/_shell/settings.language.tsx            |    2 +-
 .../routes/_shell/settings.memory.tsx              |    4 +-
 .../routes/_shell/settings.models.tsx              |    8 +-
 .../routes/_shell/settings.notifications.tsx       |    4 +-
 .../routes/_shell/settings.tsx                     |    6 +-
 .../routes/_shell/settings.usage.tsx               |    4 +-
 .../src/renderer/stores/account-store.test.ts      |   83 -
 apps/desktop/src/renderer/stores/account-store.ts  |   73 -
 .../renderer/stores/active-conversation-store.ts   |   26 -
 .../src/renderer/stores/agent-session-store.ts     |   66 -
 apps/desktop/src/renderer/stores/app-global.ts     |   32 -
 .../stores/browser-resource-store.test.tsx         |  267 --
 .../src/renderer/stores/browser-resource-store.ts  |  402 --
 .../src/renderer/stores/code-folder-context.ts     |   75 -
 .../desktop/src/renderer/stores/code-store.test.ts |  228 -
 apps/desktop/src/renderer/stores/code-store.ts     |  419 --
 .../src/renderer/stores/credits-store.test.ts      |   32 -
 apps/desktop/src/renderer/stores/credits-store.ts  |   37 -
 apps/desktop/src/renderer/stores/language-store.ts |   28 -
 .../renderer/stores/local-model-dialog-store.ts    |   24 -
 apps/desktop/src/renderer/stores/pinning.test.ts   |   60 -
 .../src/renderer/stores/preview-store.test.ts      |  210 -
 apps/desktop/src/renderer/stores/preview-store.ts  |  211 -
 .../src/renderer/stores/right-panel-react.test.tsx |  175 -
 .../src/renderer/stores/right-panel-react.ts       |  133 -
 .../src/renderer/stores/right-panel-store.test.ts  |  356 --
 .../src/renderer/stores/right-panel-store.ts       |  387 --
 .../src/renderer/stores/session-skills-store.ts    |   75 -
 .../stores/sidebar-accordion-store.test.ts         |   35 -
 .../src/renderer/stores/sidebar-accordion-store.ts |   33 -
 .../stores/terminal-runtime-store.test.tsx         |  158 -
 .../src/renderer/stores/terminal-runtime-store.ts  |  271 --
 .../desktop/src/renderer/stores/tour-store.test.ts |   63 -
 apps/desktop/src/renderer/stores/tour-store.ts     |   30 -
 .../src/{renderer-next => renderer}/styles/app.css |    0
 .../{renderer-next => renderer}/styles/tokens.css  |    0
 .../src/renderer/terminals/terminal-keys.ts        |    4 -
 .../src/renderer/terminals/terminal-mouse.test.ts  |  258 --
 .../src/renderer/terminals/terminal-mouse.ts       |    4 -
 .../src/renderer/terminals/terminal-views.test.ts  |  242 -
 .../src/renderer/terminals/terminal-views.ts       |  Bin 16499 -> 0 bytes
 .../test-support/app-harness.tsx                   |   26 +-
 .../test-support/chat-relay.ts                     |   10 +-
 .../test-support/media.ts                          |    0
 .../test-support/notch-fit.tsx                     |   16 +-
 .../test-support/real-host.ts                      |    8 +-
 .../test-support/render-in-router.tsx              |    4 +-
 apps/desktop/src/renderer/test-support/setup.ts    |   46 +-
 apps/desktop/src/renderer/types/index.ts           |   20 -
 .../ui/alert-dialog.tsx                            |    2 +-
 .../{renderer-next => renderer}/ui/attachment.tsx  |    2 +-
 .../src/{renderer-next => renderer}/ui/avatar.tsx  |    0
 .../src/{renderer-next => renderer}/ui/badge.tsx   |    0
 .../src/{renderer-next => renderer}/ui/bubble.tsx  |    0
 .../src/{renderer-next => renderer}/ui/button.tsx  |    0
 .../{renderer-next => renderer}/ui/checkbox.tsx    |    0
 .../{renderer-next => renderer}/ui/collapsible.tsx |    0
 .../{renderer-next => renderer}/ui/combobox.tsx    |    4 +-
 .../src/{renderer-next => renderer}/ui/command.tsx |    4 +-
 .../ui/context-menu.tsx                            |    0
 .../src/{renderer-next => renderer}/ui/dialog.tsx  |    2 +-
 .../src/{renderer-next => renderer}/ui/drawer.tsx  |    0
 .../ui/dropdown-menu.tsx                           |    0
 .../src/{renderer-next => renderer}/ui/empty.tsx   |    0
 .../src/{renderer-next => renderer}/ui/field.tsx   |    4 +-
 .../{renderer-next => renderer}/ui/hover-card.tsx  |    0
 .../{renderer-next => renderer}/ui/input-group.tsx |    6 +-
 .../src/{renderer-next => renderer}/ui/input.tsx   |    0
 .../src/{renderer-next => renderer}/ui/item.tsx    |    2 +-
 .../src/{renderer-next => renderer}/ui/kbd.tsx     |    0
 .../src/{renderer-next => renderer}/ui/label.tsx   |    0
 .../src/{renderer-next => renderer}/ui/marker.tsx  |    0
 .../ui/message-scroller.tsx                        |    2 +-
 .../src/{renderer-next => renderer}/ui/message.tsx |    0
 .../ui/native-select.tsx                           |    0
 .../src/{renderer-next => renderer}/ui/popover.tsx |    0
 .../ui/questionnaire.tsx                           |    2 +-
 .../{renderer-next => renderer}/ui/resizable.tsx   |    0
 .../{renderer-next => renderer}/ui/scroll-area.tsx |    0
 .../src/{renderer-next => renderer}/ui/select.tsx  |    0
 .../{renderer-next => renderer}/ui/separator.tsx   |    0
 .../src/{renderer-next => renderer}/ui/sheet.tsx   |    2 +-
 .../{renderer-next => renderer}/ui/skeleton.tsx    |    0
 .../src/{renderer-next => renderer}/ui/spinner.tsx |    0
 .../src/{renderer-next => renderer}/ui/switch.tsx  |    0
 .../src/{renderer-next => renderer}/ui/tabs.tsx    |    0
 .../{renderer-next => renderer}/ui/textarea.tsx    |    0
 .../src/{renderer-next => renderer}/ui/toast.tsx   |    2 +-
 .../ui/toggle-group.tsx                            |    2 +-
 .../src/{renderer-next => renderer}/ui/toggle.tsx  |    0
 .../src/{renderer-next => renderer}/ui/tooltip.tsx |    0
 apps/desktop/src/renderer/utils/file-icon.ts       |   57 -
 apps/desktop/src/renderer/utils/file-type-utils.ts |  341 --
 apps/desktop/src/renderer/utils/log-collector.ts   |   88 -
 .../src/renderer/utils/model-selection.test.ts     |  320 --
 apps/desktop/src/renderer/utils/model-selection.ts |   94 -
 .../src/renderer/utils/open-local-file.test.ts     |   66 -
 apps/desktop/src/renderer/utils/open-local-file.ts |   27 -
 .../src/renderer/utils/preview-utils.test.ts       |  118 -
 apps/desktop/src/renderer/utils/preview-utils.ts   |  249 --
 .../src/renderer/utils/process-latex-sections.ts   |  129 -
 apps/desktop/src/renderer/utils/skill-utils.ts     |   38 -
 apps/desktop/src/renderer/utils/workspace-state.ts |  129 -
 apps/desktop/src/renderer/voice/recorder.ts        |  166 -
 apps/desktop/src/renderer/voice/use-dictation.ts   |  111 -
 apps/desktop/src/renderer/voice/whisper.ts         |  134 -
 apps/desktop/src/shared/bots.ts                    |    6 -
 apps/desktop/src/shared/bots/check-in.test.ts      |   16 -
 apps/desktop/src/shared/channels.ts                |  197 -
 apps/desktop/src/shared/contract/agui.ts           |   14 +-
 apps/desktop/src/shared/contract/db.ts             |    2 -
 apps/desktop/src/shared/contract/durable-state.ts  |   19 -
 apps/desktop/src/shared/contract/errors.ts         |    2 -
 apps/desktop/src/shared/contract/ids.ts            |    6 -
 apps/desktop/src/shared/contract/index.ts          |   28 +-
 apps/desktop/src/shared/contract/legacy-map.ts     |  636 ---
 .../src/shared/contract/lib-imports.types.test.ts  |    2 +-
 apps/desktop/src/shared/contract/mcp.ts            |    5 +-
 apps/desktop/src/shared/contract/rows.ts           |    2 +-
 apps/desktop/src/shared/contract/skills.ts         |    5 +-
 .../src/shared/contract/transport-guard.test.ts    |    6 +-
 apps/desktop/src/shared/contracts.ts               |  513 +--
 apps/desktop/src/shared/messaging.ts               |    9 -
 apps/desktop/src/shared/models.ts                  |    7 -
 apps/desktop/src/shared/pptx.ts                    |    1 -
 apps/desktop/src/shared/terminal-shells.ts         |    2 -
 .../src/shared/terminal/legacy-keys-compat.ts      |   90 -
 apps/desktop/src/shared/terminal/mouse-compat.ts   |    1 -
 apps/desktop/src/shared/transcript/thread-file.ts  |   16 -
 apps/desktop/src/shared/transcript/tool-result.ts  |   47 +
 apps/desktop/src/shared/transcript/v1-types.ts     |   48 +-
 apps/desktop/src/shared/window-chrome.test.ts      |   30 -
 apps/desktop/src/shared/window-chrome.ts           |   31 -
 apps/desktop/tsconfig.json                         |    1 -
 apps/desktop/tsconfig.renderer-next.json           |   17 -
 apps/desktop/tsconfig.renderer.json                |   15 +-
 apps/desktop/vite.config.ts                        |   21 +-
 apps/desktop/vite.shared.ts                        |    9 +-
 apps/desktop/vitest.config.ts                      |   35 +-
 apps/updater/src/classify.test.ts                  |    6 +-
 apps/updater/src/classify.ts                       |    2 -
 docs/rewrite/PARITY.md                             |  512 +--
 docs/rewrite/PLAN.md                               |    4 +-
 docs/rewrite/PROGRESS.md                           |    4 +
 docs/rewrite/going-back.md                         |   15 +
 docs/rewrite/reports/07-cutover.md                 |   98 +-
 docs/rewrite/reports/07-release-notes.md           |   12 +
 docs/rewrite/reports/07-size-current.json          |  142 +
 docs/rewrite/reports/07-tooling-policy.md          |    9 +
 docs/rewrite/reports/07-user-login-perf.json       | 4655 ++++++++++++++++++++
 knip.json                                          |   62 +-
 oxlint.config.ts                                   |   65 +-
 package.json                                       |    8 +-
 packages/agent/src/agui/__tests__/harness.ts       |   49 +-
 packages/agent/src/agui/agui-spawn.e2e.test.ts     |   38 +-
 packages/agent/src/agui/cli-wire.test.ts           |   15 +
 packages/agent/src/agui/cli-wire.ts                |    6 +
 packages/agent/src/agui/host.ts                    |   12 +-
 .../src/agui/ndjson-golden.integration.test.ts     |   65 -
 packages/agent/src/agui/queue.ts                   |   14 +-
 packages/agent/src/agui/record.ts                  |    4 +
 packages/agent/src/agui/sink.ts                    |   13 +-
 .../agent/src/agui/wire-record.integration.test.ts |   51 +-
 packages/agent/src/host.ts                         |   81 -
 packages/agent/src/index.ts                        |    2 -
 packages/agent/src/main.ts                         |   24 +-
 patches/react-tourlight@0.3.0.patch                |   90 -
 pnpm-lock.yaml                                     |  711 +--
 pnpm-workspace.yaml                                |    2 -
 scripts/build-provenance.mjs                       |    8 +-
 scripts/cutover/README.md                          |   16 +-
 scripts/cutover/bridge-ids.json                    |  305 ++
 scripts/cutover/cdp.mjs                            |  138 +-
 scripts/cutover/check-deletions.mjs                |   71 +
 scripts/cutover/check-deletions.test.mjs           |   22 +
 scripts/cutover/check-removed-deps.mjs             |   88 +
 scripts/cutover/check-removed-deps.test.mjs        |   29 +
 scripts/cutover/knip-canaries.test.mjs             |   83 +
 scripts/cutover/knip-entries.mjs                   |   47 +
 scripts/cutover/knip-entries.test.mjs              |   16 +
 scripts/cutover/parity-consumers.mjs               |    2 +-
 scripts/cutover/parity-consumers.test.mjs          |    4 +-
 scripts/cutover/perf-compare.mjs                   |  116 +-
 scripts/cutover/perf-home.mjs                      |   36 +
 scripts/cutover/perf-probes.mjs                    |   27 +-
 scripts/cutover/perf-probes.test.mjs               |   74 +-
 scripts/cutover/release-notes.mjs                  |   39 +
 scripts/cutover/release-notes.test.mjs             |   23 +
 scripts/cutover/renderer-move-inventory.json       | 2913 ++++++++++++
 turbo.json                                         |    3 -
 1402 files changed, 18432 insertions(+), 115941 deletions(-)
mise ERROR Operation not permitted (os error 1)
mise ERROR Version: 2026.9.15 macos-arm64 (2026-09-27)
mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information

exec
/bin/zsh -c "pwd; command -v git; /opt/homebrew/bin/rg --files -g AGENTS.md -g '07-cut-over.md' -g PLAN.md -g '07-cutover.md'; cat docs/rewrite/specs/07-cut-over.md docs/rewrite/reports/07-cutover.md" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
/Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
/usr/bin/git
zsh:1: no such file or directory: /opt/homebrew/bin/rg
# 07 — Cut-over (phase 7)

Status: spec **r3**, final (no code). r2 answered Codex round 1 (`reviews/07-cut-over.codex-r1.md`, 25 items). r3 answers round 2 (`…codex-r2.md`, 16 items, 3 blockers), with the coordinator's decisions. Responses are at the end. Branch `rewrite/renderer`, `HEAD 1365c472`, whose code is `8dc67139`. It implements the "Cut-over" phase of `docs/rewrite/PLAN.md` (§Phases and PR stack, phase 7: "Delete the old renderer, conversation layer, NDJSON host, `window.api`, zustand stores, unused patches; knip clean; size-limit set; PARITY.md all green; migration runs on real data from a backup. Gate: `pnpm check` green; release build smoke on macOS and Windows"). This is where the new renderer becomes the shipped one and the old tree is deleted. It builds on:

- `00-transport-db-migration.md` **r2** and its implementation notes, plus the 1 Oct C.3 amendment (the step-1 id grammar). Relevant parts: A (contract, both paths mounted, `emitIpcEvent`), B (tables, per-leaf provenance), C (runner, journal v2, steps 1–2, the reserved C.5 steps 3–4, the live legacy sync, downgrade safety).
- The migration fix logs:
  - `reviews/00-transport-C.impl-fixes-r1.md` (runner);
  - `reviews/00-transport-C1.impl-fixes-r1.md`, r1 (merged `41e0dd92`): source fingerprints, `threads/<id>.cleared` markers with tokens, the 64 MB `MAX_TRANSCRIPT_BYTES` cap, `tooLarge`/`unreadable`/`foreign`, step 4's orphan and cleared-history archiving, and `ThreadStore`'s `v1Archived` option;
  - the same log, r2 (merged `8dc67139`):
    - step 4 writes `threads/.archive-index.json` in the same commit as its removals, and a later run never takes a listed twin for an orphan;
    - `ThreadStore` serves those twins;
    - listing errors stop step 4;
    - clears are fail-closed (`savedAfterClear`);
    - held writes are durable under `threads/.pending/` (`HeldFiles`).
- `00-window-chrome.md` **r2**, with the two low items due before the wco switch, §7 (deletion list) and §12 (acceptance).
- `00-agent-agui.md` **r3**, with the impl r1 amendments and the main-relay notes, plus `reviews/00-main-relay.impl-fixes-r1.md` (r1 fixes `5d5dc433`, r2 fixes `c07479f7`). Among them:
  - `defaultWire`: agui for every spawn in the wco build;
  - the env override honoured only unpackaged;
  - error anchors and closure of open parts at every terminal;
  - `session.cleared`;
  - the stdout final-line drain.
- `01-renderer-foundation.md` **r4** with `reviews/01-renderer-foundation.impl-fixes-r1.md` (r1 fixes `8acc0ebb`, r2 fixes `e14f845d`, which added the Linux `screenshots-next` CI job). Also `02-chat-kit.md` **r4**, `03-bots.md` **r3**, `04-sessions.md` **r3**, `05-routines-artifacts-library-settings.md` **r3**, cited by section, and `06-onboarding-tour-notch.md` **r4** (final: one-shot haptics, no notch inference).
- Every review and fix log under `specs/reviews/`. §3 lists every item in them that is "deferred to cut-over" or held "until cut-over", with its source and its state at `c46e77d9`.

Paths are relative to `apps/desktop/` unless noted. Line numbers are at `c46e77d9`, except where a row says `8dc67139` (the migration and thread-store files).

**Sources read for this spec (30 Sep 2026; rebased 1 Oct 2026)**

| Source | Where |
|---|---|
| Generation and entry | `src/main/renderer-generation.ts:7-27`, `src/main/renderer-entry.ts:11-73`, `src/main/index.ts:115,396-425,453-465,580-633,780-800,850-915,1580-1595,1700-1760,1795-2090,2131` |
| Renderer host and readiness | `src/main/renderer-host.ts` (all 484 lines), `src/main/rpc/readiness.ts`, `src/renderer-next/features/shell/readiness.tsx` |
| Experience / updater | `src/shared/experience.ts:1-11`, `src/main/services/updates/experience/{integrity,experience-updater,health-check}.ts`, `integrity.test.ts`, `apps/updater/src/{manifest,experience,classify}.ts`, `apps/updater/README.md`, `scripts/build-experience.js`, `src/main/services/updates/update-service.ts` |
| Preload | `src/preload/index.ts` (300 lines: `window.api`, `abacusHost`, `durableState` `sendSync`), `rpc-port.ts`, `bridge.ts` (1090 lines), `preload-exposure.test.ts`, `parity.test.ts` |
| Legacy IPC | `src/shared/channels.ts` (`IpcChannels`, 197 lines), `src/main/handler.ts:155-490` (`createHostOperations`, `registerIpcHandlers`), `src/main/rpc/emit.ts:14-38`, the 232 `ipcMain.handle|on` call sites in `src/main` (tests excluded) |
| Migration | `src/main/migrations/{runner,journal,record,backup,startup,write-block}.ts`, `steps/{index,001,002,004,transcript-files}.ts`, `__fixtures__/legacy-home/`, `legacy-home.test.ts`; `src/main/services/session/{thread-store,transcript-service}.ts` (`MAX_TRANSCRIPT_BYTES` :60, the `.cleared` marker :150, `v1Archived` :168,280), `src/shared/transcript/thread-file.ts:45-80` (`ClearMarker`); `src/main/services/config/{renderer-state,legacy-prefs,prefs-store}.ts` |
| Wire | `packages/agent/src/main.ts:73-142`, `host.ts`, `agui/{sink,channel,queue,record}.ts`, `agui/__fixtures__/` (48 files), `src/main/services/session/cli-manager-service.ts:47-55,129,596-626,727-755,985-1180`, `src/main/services/agui/relay-service.ts:1-15,108-141,271`, `service-host.ts:455-470,1252-1361,1520-1522` |
| Build and CI | `vite.config.ts`, `vite.shared.ts`, `vitest.config.ts`, `tsconfig*.json`, `knip.json`, `oxlint.config.ts`, `pnpm-workspace.yaml`, `patches/`, `package.json` (root and desktop), `electron-builder.yml`, `build/entitlements.mac.plist`, `build/licenses/`, `scripts/{check-legacy-renderer-diff.mjs,legacy-renderer-allow.json,check-packaged-resources.js,generate-notices.js,sync-locales.js,check-jsx-i18n.js,screenshots-next.mjs,locale-keymap.json}`, `.github/workflows/{ci,codeql,dependency-review}.yml` (`ci.yml` at `c46e77d9`: `check` :65-96, the NDJSON step :200, `screenshots-next` :223-254, `package` :256-368, smoke :306-368) |
| Dev-only code | `src/main/dev/{mutation-harness,renderer-next.electron.test,screenshots-gate.test,legacy-diff.test}.ts`, `src/renderer-next/{main.tsx,lib/dev/dev-hooks.ts,lib/devtools.tsx,features/gallery/search.ts,data/fixture-db/}` |
| Parity | `docs/rewrite/PARITY.md` (587 lines, generated from `src/shared/contract/legacy-map.ts` by `preload/parity.test.ts`) and the parity tables of specs 03–06 |
| Releases | tags up to `v1.0.85` (an ancestor of this branch), `CHANGELOG.md`, `scripts/sync-changelog.js` |

## 0. Findings that change the brief (read first)

Rebased to `c46e77d9` in r2, and to `8dc67139` in r3 for the migration and thread-store rows. Rows marked *(r2)* or *(r3)* are new or changed in that round.

| # | Brief / earlier specs say | The repo says | Consequence here |
|---|---|---|---|
| F1 *(r2)* | "every spawn becomes agui in the wco generation" | **Implemented.** `defaultWire({ generation, isPackaged, env })` (`relay-service.ts:120-141`) is true for `generation === "wco"`. `ABACUSAI_BOT_AGENT_WIRE=agui` counts only in an unpackaged app, and a packaged legacy app logs that it ignores it. `ServiceHost` passes it (`service-host.ts:463-468`); see relay fix log, Claude 3 and 9. The selection plumbing remains: `wireFor` (`relay-service.ts:271`), `resolveWire` with `?? "ndjson"` (`cli-manager-service.ts:129,601`), and `service-host.ts:1252`. | C5 needs no wire change: the generation flip carries it. C10 deletes the plumbing. |
| F2 | PLAN phase 7: "Delete … NDJSON host" | Spec 00-agent-agui §6.4 (:999-1001) and the PLAN amendment (:366) keep the **compat stream** (legacy NDJSON on fd 3), because main's taps read it. Only the NDJSON-only **host path** and the `--wire` default go. | §5.4: `protocol.ts` `DesktopEvent`, `agui/sink.ts`, `agui/channel.ts`, `handleCompatFd`/`handleNdjsonLine` and `shared/agent-types.ts` stay. |
| F3 *(r2)* | The FOUNDATION_API bump gates published experiences | The manifest is bound to the **exact foundation version** (`integrity.ts:51-55`) *and* to `FOUNDATION_API` (`:57`). There is one TUF target for every foundation (`experience-updater.ts:23`). The bump chooses the swap barrier (`index.ts:425`). `buildManifest` stamps the **builder's** API and the supplied version onto any tree it is given (`apps/updater/src/manifest.ts:73-108`), so neither number says when or from what the tree was built (review #14). | §6: the bump selects the barrier. Build-time provenance inside the artifacts (C4) is what catches a stale tree. |
| F4 | Experiences keep working after the flip | renderer-next ports none of the old boot services (`renderer/main.tsx:8-21`). It never calls `window.activity` (`shared/contract/window.ts:37`) and has no `__captureUiContinuity`. `RendererHost` waits for readiness **before** it restores continuity (`renderer-host.ts:380-395`, then `:429-432`). | C3 ports both, and the barrier has two stages (D11, review #13). |
| F5 | `experience` release units are renderer and agent source | `apps/updater/src/classify.ts:11-15` lists `apps/desktop/index.html`, `apps/desktop/src/renderer/` and `packages/agent/src/`. It does not list `src/renderer-next/`, `index-next.html` or `notch.html`. | C5 adds them; C7 restores the single prefix. |
| F6 *(r2)* | Keep-awake follows agent runs | `power:set-agent-busy` is still renderer IPC (`keep-awake.ts:43`). `hasActiveAgentTurn()` reads the compat-fed turn state (`service-host.ts:1520-1522`). Re-evaluating it on AG-UI terminals races fd 3 against stdout (review #10). | Prerequisite **P4** (routed to implementation; §2). R7-T27 verifies it. |
| F7 | The health check proves an agent bundle | `health-check.ts:52-80` spawns the candidate with **no flags** and waits for the NDJSON `{"type":"ready"}`. Under agui, stdout line 1 is `CUSTOM wire.hello` and readiness is `CUSTOM session.ready`. | C2 adds an agui mode; C10 makes it the only one. |
| F8 *(r3)* | Step 4 and the rule removal ship "in the cut-over build" (spec 00 C.5) | **Rebased to `8dc67139`.** Step 4:<br>• archives v1 files proven by fingerprint, orphaned v1-derived twins, and history held by a clear marker;<br>• writes `threads/.archive-index.json` (`{ archived: { <id>: { fingerprint, updatedAt } } }`) as a planned write of the **same commit** (`004-archive-transcripts-v1.ts:227-228`), so a later partial run never takes a listed twin for an orphan;<br>• fails the whole step on any listing error except `ENOENT`.<br>`ThreadStore.archived()` serves a v1-derived twin whose v1 is gone when the index lists it with the twin's fingerprint (`thread-store.ts:571-584`). But the same function returns true for **every** twin when `v1Archived` is set (`:576`), which review r2 #2 rejects. Clears are fail-closed (`savedAfterClear`). Kept sources (`tooLarge` > 64 MB, `unreadable`, `foreign`, `failed`) have no reader in N once no twin exists (r2 #8). | D2 (revised in r3): per-thread index evidence decides in N **and** N+1; `v1Archived` never decides alone. The bounded fallback reader ships in N as prerequisite P6. |
| F9 | `window.api` removal is one deletion | `registerIpcHandlers` (`handler.ts:471-490`) both builds the operations object oRPC uses (`index.ts:1738-1740`) **and** registers the handlers. It also installs `serviceHost.setEventDispatcher(emitIpcEvent)`. | C8 splits it: `createHostOperations` and the dispatcher wiring stay, and the `ipcMain.handle` block goes. |
| F10 | The experience verifier accepts the new renderer | `integrity.ts:196-200` refuses a tree without `renderer/index.html`. | C6 renames `index-next.html` to `index.html` in the same commit that deletes the legacy one. |
| F11 | Tests that read the old tree | `legacy-prefs.test.ts:215-235` reads two old-renderer files as oracles. R3-T9's legacy half runs through old shims (03:1036). `ToolResultData` lives in `renderer/conversation/agent-types.ts:273-322`. The C1 fix log moved the migrated normalisation to `expandToolResultData` (§14 request, item 5). | C6 freezes the oracles and moves any remaining type into `shared/` first. |
| F12 *(r2)* | `pnpm check` gates the cut-over (PLAN) | CI runs `format:check`, `lint`, `typecheck:tools`, `typecheck`, `check:i18n`, `check:locales` and `check:audit` separately (`ci.yml:65-96`). `check:knip-next`, `check:ui-registry` and `check:legacy-diff` are only in the root `check`. A Linux `screenshots-next` job exists (`ci.yml:223-254`). | C4 adds knip and the registry check to CI; C6 removes the legacy diff. |
| F13 *(r2)* | Release smoke on macOS and Windows | CI packages unsigned builds and starts them on all three OSes (`ci.yml:256-368`). It waits for `[smoke] main process ready` (`:344`; `index.ts:219,2132`), which comes before any renderer is ready. Signed builds come from a private repo (`ci.yml:3-9`). | R7-T16 adds renderer and notch markers; R7-T17 is the signed run. |
| F14 | Nuked dependencies need knip | `@tsparticles/{engine,react,slim}` and `uuid` have zero importers. `framer-motion@13.4.6` stays in the lockfile under `motion@13.4.6`, so `pnpm-workspace.yaml:69` stays. The r1 grep pattern missed scoped names and side-effect imports (review #17). | §5.6 uses parsed module specifiers. |
| F15 *(r2)* | node-mac-notch packaging | The package does not exist (06 F1). Spec 06 r4 has no inference: when the one-shot JXA probe fails, an internal display gets **no** companion (06:651-655). Haptics are one-shot `osascript` per attention, deduplicated by key, and default off when R6-T31's median latency exceeds 150 ms (06 §10.7, :724-730). | §10 and §3 follow r4. |
| F16 *(r2)* | Gallery and fixture builds cannot ship | They are gated by `import.meta.env.DEV \|\| VITE_UI_GALLERY === "1"` (`main.tsx:52-53,175`; `features/gallery/search.ts:106`) and `VITE_NEXT_DB_FIXTURES=1` (`main.tsx:115-118`). The screenshot and acceptance runs build into the same `dist/renderer` as a release. | C4 adds a release-build guard. |
| F17 | Window-chrome §7 grep "returns nothing" | The bare `isFullScreen` matches Electron's `BaseWindow.isFullScreen()` in main, so that grep is never empty. | §5.3 corrects the pattern. |
| F18 | Multiple homes | `profile-home.ts` keeps one home per account (`profiles.json`, `profiles/<key>/`). Each is migrated when it is first active, and its `userData` is `<home>/electron` (`index.ts:210-216`). | R7-T12, and restore per profile (§12.4). |
| F19 *(r3)* | A write the migration holds is deferred | **Fixed at `8dc67139`.** `HeldFiles` journals every held write or removal of the thread store and `TranscriptService` to `threads/.pending/<hash>.json`, reads see it, and it is replayed when the block lifts. Only when the journal itself is held does a change stay in memory, and that is logged. | P2 is done. The call to `held.replayAll()` after `setMigrationWriteBlocks` is handed over (C1 fix log r2), so row 61 covers it. |
| F20 *(r2)* | A failed candidate is discarded | `experience-updater.ts:255` persists activation before the swap is asked for. `SwapNotReady` discards the view but not the pointer, so a relaunch boots the rejected bundle (review #9). | Prerequisite **P3**. |
| F21 *(r2)* | Byte-identical compat means identical tap input | Each stdout and fd-3 chunk is decoded on its own (`cli-manager-service.ts:731,754`), so a UTF-8 character split across chunks is corrupted. fd 3 has no final-line drain, and overflow is handled differently from stdout (review #11). | Prerequisite **P5**. §8.2 states what byte identity covers. |
| F22 *(r2)* | Restore from `…/userData/…` | `backupPathFor` checks `home` first (`backup.ts:83-87`), and `userData` is inside the home, so a step-3 backup is `<backup>/home/electron/renderer-state.json`. Secondary profiles have their own home and backups (review #5). | §12.4 derives restore paths from the recorded roots, per profile. |
| F23 *(r2)* | Freezing `stagingPercentage` halts a rollout | electron-updater admits every client whose persisted staging id falls below the percentage (`AppUpdater.isStagingMatch`), so clients that had not checked yet keep entering. A downloaded build installs on quit (`update-service.ts:233-236`). A shipped client (≥ `v1.0.85`) already drops a downloaded build the feed stops offering on two consecutive checks (`update-service.ts:153-175`, `notOfferedStrikes`), 10 minutes apart (`:46`). | §12.2: halting means percentage 0 or withdrawal. |
| F24 *(r3)* | `ts.preProcessFile` extracts module specifiers | The installed TypeScript is 7.0.2, whose package root exports only version information: `ts.preProcessFile is not a function` (review r2 #11). `oxc-parser` 0.150.0 is installed (`pnpm-lock.yaml`), and its `parseSync(...).module` exposes `staticImports`, `staticExports` (with `moduleRequest`) and `dynamicImports`. `rolldown/parseAst` exports `parseAst`. | §5.1 and §5.6 use `oxc-parser`, declared as a root devDependency at the installed version. `require()` is found by an AST visit. |
| F25 *(r3)* | Build provenance stamps a commit | `turbo.json` caches `build` outputs (`dist/**`) by task inputs, with no commit input (review r2 #10). | C4 puts the pinned provenance commit (`ABACUS_BUILD_COMMIT`) into both builds' cache keys. |
| F26 *(r3)* | CI waits for renderer and notch markers | Under `ABACUSAI_BOT_SMOKE_TEST=1`, main prints its marker and calls `app.exit(0)` at once (`index.ts:2131-2135`). A macOS runner has no notched display, so spec 06 r4 gives it no companion (06:651-655). | C4 delays the exit until the readiness outcomes settle, and accepts an asserted "companion disabled" outcome. |
| F27 *(r3)* | A halt drops downloaded builds within two checks | While `downloading`, periodic checks are skipped (`update-service.ts:434`). `update-downloaded` resets `notOfferedStrikes` (`:203`) and starts the 60 s auto-restart poll (`:50,:210,:240-247`), which can install before any re-check. A slow transfer can therefore install long after a halt (review r2 #16). | §12.2 documents the limitation for shipped clients. Clients that can still be changed get an install-time feed re-check (C2, in the dormant release). |
| F28 *(r3)* | N reads homes N+1 migrated with no restore | N's startup import calls `resetLegacy` for mapped keys that are absent (`legacy-prefs.ts:403`). After step 3 drops those keys, N would reset every `legacy`-provenance leaf to its default and persist it (review r2 #3). | Step 3 writes a retirement record, and N's importer skips retired keys (C1, C11). |

## 1. Scope and decisions

**In scope.** The ordered stack that makes renderer-next the shipped renderer and removes what only the old renderer needed: the generation flip, the FOUNDATION_API bump with the updater, the wire flip, deleting the old tree, `window.api`, legacy IPC and transition-only data paths, the dependency purge, the locale purge, notch/capsule packaging checks, the release, its notes, the staged rollout and the rollback plan. Also the release that follows (N+1), which retires the legacy files.

**Out of scope.** Porting main's taps from the compat stream to AG-UI. That is a later, separately specified slice (agent spec :1001), and the compat stream stays here. Also out: the `i18next` 26 / `react-i18next` 17 majors (01 F9, now a single-renderer PR after the cut-over), the features the specs defer to later slices (the `deferred` rows of §11), and a web mode.

**Decisions**

- **D1. One behaviour flip.** Exactly one PR (C5) changes what a packaged user runs: the generation default, and with it every spawn on agui (F1), plus `FOUNDATION_API`. Every earlier PR leaves the legacy build's user-visible behaviour as it is (`check:legacy-diff` and the goldens still hold); C2's refused-target memo and C4's build guards are housekeeping no user sees. Every later PR deletes code the flipped build no longer reaches, and must leave the R7 gate as it was.
- **D2. Two releases, with N carrying what N+1 relies on (r3).** Release **N** ships the flip and the deletions. It never mutates a file an older build reads: `transcripts/`, `renderer-state.json`, and the stores' existing fields. It also ships everything N+1 depends on, so N is a safe floor after any N+1 commit, partial ones included:
  - (a) **per-thread archive evidence**: HEAD's `threads/.archive-index.json`, written by step 4 in the same commit as its removals. In N and in N+1 alike, a v1-derived twin whose v1 is gone is served **only** with matching index evidence. `v1Archived` never decides on its own, and C15 deletes the option (review r2 #1, #2).
  - (b) a **restore index derived from retained attempt records** (review r2 #4, #5): every committed attempt keeps a validated manifest and a completion record inside its backup directory, covering removals and `replace-user` backups with operation type and original digest. `backups/migrations/restore-index.jsonl` is rebuilt from them whenever it is missing or inconsistent.
  - (c) the **read-only, provenance-aware startup import** of `renderer-state.json` (review r1 #8). It honours step 3's **retirement record**, so N reading an N+1 home never resets migrated preferences (review r2 #3).
  - (d) HEAD's clear-marker and token protocol, fail-closed with `savedAfterClear` (review r1 #4).
  - (e) the **bounded streaming fallback reader** for kept v1 sources, behind the same clear-marker rules. It is prerequisite P6, routed to the thread-store owner (review r2 #8, #9).

  Release **N+1**, once N is at 100 % with no trigger hit, registers steps 3–4 and ships `--restore-legacy-files`. This amends spec 00 C.5.
- **D3. `FOUNDATION_API = 2`** in `src/shared/experience.ts` and `apps/updater/src/manifest.ts` in one commit, guarded by a test that imports both. From API 2 the verifier also requires `renderer/notch.html` and **build provenance** in the tree: `renderer/build.json` and `agent/build.json`, written by the build, not by the packager (review r1 #14). The provenance commit is part of both builds' Turbo cache keys (review r2 #10).
- **D4. `--wire` stays as a flag for skew safety.** Main keeps passing `--wire agui --thread-id <id> --compat-fd 3`. After C10 the agent treats an absent `--wire` as `agui` and rejects `--wire ndjson` with a typed error.
- **D5. PARITY.md is frozen as the sign-off record.** At C5 it gains a "renderer consumer" column, validated against the **exact** expected row set with every `file#symbol` resolved (review #25). Its generator is deleted in C8.
- **D6. Locales stay at `src/renderer/locales/`.** After C7 they sit inside the new `src/renderer`, and `#locales/*` keeps resolving.
- **D7. Synthetic data on real layouts, with immutable fixtures (r2).** The upgrade tests use homes **produced by real shipped builds** from synthetic inputs (§13).
  - There is one immutable, versioned fixture per source layout: pre-rewrite and dormant, each with its own producer manifest and source-binary hash. A new release **adds** a fixture and never replaces one (review #21).
  - Migration fixtures and the performance fixture are separate (review #20).
  - Team members may run the RC on copies of their own homes, locally; nothing from those runs is collected.
- **D8. Linux is in the packaged smoke.** The notch and capsule are macOS and Windows only.
- **D9. Staged rollout with a real halt (r2).** Stages are set with `stagingPercentage` in `latest*.yml`. To halt, the percentage is set to **0**, or the release is withdrawn by republishing N−1's feed files. Freezing the percentage is not a halt (F23, review #15). From the RC cut, experiences are published for N only (§6.4).
- **D10. Two Vite inputs after C6 (r2).** `main: index.html` and `notch: notch.html` (review #12).
- **D11. Two-stage swap barrier (r2).** Stage 1 is readiness: `window.ready({ barrier: "subscriptions" })`. Stage 2 is restoration: main calls `__restoreUiContinuity`, which resolves once the restored state is committed, bounded by `RESTORE_TIMEOUT_MS`. The flip comes only after both. The candidate never makes readiness wait on restoration (review r1 #13). The snapshot carries the **complete typed draft state**: every `sessionStorage`-persisted store the specs define, because a new experience origin cannot read the old origin's storage (review r2 #13).

## 2. Entry criteria (before C1 opens)

1. **Phases 0–6 are merged with their gates green.** At `c46e77d9`:
   - the relay is done (`5d5dc433`, r2 `c07479f7`);
   - the foundation is done (`8acc0ebb`, r2 `e14f845d`);
   - the step-1, thread-store and step-4 fixes are merged (`41e0dd92`), with Codex r2 running;
   - phase 2 is implementing, and phases 3–6 are final specs;
   - "main requirements from specs 3–6" is implementing (PROGRESS.md).
2. **Prerequisites** are fixed and merged. The coordinator routed them to implementation agents on 1 Oct 2026. They are not cut-over PR work, but the cut-over gates re-verify them. State at `8dc67139`:

   | Id | Defect (review item) | Where | Owner | State | Verified by |
   |---|---|---|---|---|---|
   | P1 | A directory-listing error reads as empty, so step 4 can take every twin for an orphan (#2). Only absence may read as empty; an unlistable `transcripts/` or `threads/` stops orphan removal and completion. | `transcript-files.ts` | Migration | **Done** (`272868f3`: the listing fails the step except on `ENOENT`, and an orphan requires `lstat` `ENOENT`) | Injected `EACCES`/`EIO` C-T9 cases; R7-T14 |
   | P2 | Held writes live in a process-local overlay and are lost at quit (#7). History-changing operations on a held thread are either refused or journaled durably outside the held destinations. | `thread-store.ts`, `held-files.ts` | Thread store | **Done** (`ee9af7a4`: `threads/.pending/`) | Send, reset and quit while a commit is unresolved; R7-T14 |
   | P3 | Activation is persisted before the swap; a rejected candidate boots after relaunch (#9). Activation becomes transactional with readiness, or the previous pointer is restored on `SwapNotReady`. | `experience-updater.ts:255`; `renderer-host.ts:392-393` | Updater | Open | R7-T3, including a full restart after a failed swap |
   | P4 | Keep-awake's busy source races compat against stdout (#10). It follows authoritative turn-state transitions, or an AG-UI busy aggregate. | `keep-awake.ts:43`; `service-host.ts:1520-1522` | Main requirements | Open | R7-T27, both pipe orderings |
   | P5 | Compat and stdout chunks are decoded one at a time; fd 3 lacks the final-line drain and matching overflow handling (#11). Incremental UTF-8 decoding and a specified overflow and EOF policy on both pipes. | `cli-manager-service.ts:731,754` and `handleCompatFd` | Relay | Open | R7-T7's fragmented-Unicode, long-line and unterminated-tail cases through the manager |
   | P6 | Kept v1 sources (`tooLarge`, `unreadable`, `foreign`-twinned, `failed`) have no reader when no usable twin exists (review r2 #8), and a fallback must never resurrect a cleared source (#9). A **bounded streaming fallback** in `ThreadStore.readCurrentFile`, shipped in **N**. It applies the existing clear rules first: marker token, `v1Fingerprint`, `savedAfterClear`, with the fingerprint computed by streaming. It converts in memory and read-only, streaming above 64 MB up to 512 MB; beyond that a notice with Show in folder. | `thread-store.ts` (the `tooLarge`/`unreadable` branch returns the twin or null) | Thread store (routed by the coordinator for r3) | Open | R7-T10's over-64 MB thread on N; R7-T14's cleared-retained-source cases |

   Also still open, from the fix logs:
   - the runner's "stop after a deferred step (`break`)", which C1 takes (C1 fix log, "Handed over");
   - `threadStore.flush()` on `before-quit`, and `held.replayAll()` after `setMigrationWriteBlocks` (C1 fix log r1 and r2, "Handed over");
   - `native-ids` wiring at the agent emit and `ai.send` ingress (C1 fix log r2 #13);
   - any finding of the running low-effort Codex r3 on the migration slice.
3. **Earlier phases' deferred parity rows are green:**
   - P46 (phase 6), the P53 URL row (phase 4), P61 Revoke (phase 5) and ST22 (phase 6);
   - the 06 blocker `sessions.events { run-finished }`;
   - `PARITY.md` regenerated with the `notch.*`, `sessions.events` and `ai.runFinished` procedures.
4. **Dormant release (recommended).** `rewrite/renderer` has merged into `main` in dormant form (legacy default), and at least one release has shipped from it. That release:
   - runs steps 1–2 on real homes;
   - becomes the dormant source layout of §13.

   Shipped builds (≥ `v1.0.85`) already drop a pulled build (F23), so the rollout needs nothing more from them.
5. A release manager owns the rollout (§12) and its triggers.

## 3. Register of items deferred to the cut-over

Every "until cut-over", "at cut-over", "phase 7" and "before the wco switch" item in the specs, reviews and code, with its state at `c46e77d9` (migration and thread-store rows at `8dc67139`). The last column names the PR that handles it (§4). **Done** means it is fixed on HEAD and only re-verified here. **P1–P5** are the routed prerequisites of §2.

| # | Item | Source | Disposition |
|---|---|---|---|
| 1 | `--wire ndjson\|agui`, default `ndjson` until cut-over | 00-agent-agui:43; PLAN:336 | C5 (main passes agui for every spawn); C10 (agent default agui, D4) |
| 2 | The health-check probe keeps spawning `--wire ndjson` until cut-over | 00-agent-agui:912; `health-check.ts:52-80` | C2 (agui mode added); C10 (agui only) |
| 3 | The NDJSON-only host path and the flag go; the compat stream stays until the taps are ported | 00-agent-agui:999-1001; PLAN:366 | C10 (§8) |
| 4 | "Add at least delegate, bot and rotation `.ndjson` baselines before cut-over" | reviews/00-agent-agui.impl-claude-r1.md:115 | Done (`impl-fixes-r1.md:29`: 10 new scenarios; 24 in `agui/__fixtures__/`). Re-verified by R7-T6 |
| 5 | `wireFor` returns agui for every spawn in the wco generation | reviews/00-main-relay.impl-claude-r1.md #3; 03:1117 | **Done** (`defaultWire`, `relay-service.ts:120-141`; relay fix log Claude 3). C5 flips the generation; C10 deletes the selection plumbing (F1). |
| 6 | `ABACUSAI_BOT_AGENT_WIRE=agui` honoured in packaged legacy builds | main-relay Claude r1 #9 | **Done** (unpackaged only; relay fix log Claude 9). Deleted in C10. |
| 7 | `window.api` and every `ipcMain.handle` stay until the Phase 7 cut-over; `emitIpcEvent` feeds both paths | 00-transport:15, :562, :720, :1242; `rpc/emit.ts:14-18` | C8 |
| 8 | Kind **R** rows: "its legacy handler stays until the cut-over" (19 rows in code, 18 in spec 00; `recreateMainWindow` added by window chrome) | PARITY.md:9; 00-transport:83, :343; `legacy-map.ts:372-374` | C8 |
| 9 | `writeTranscript` dual-write of v2 "until cut-over" | 00-transport:252, :1128, :1131, :1224; PARITY.md:178; `transcript-service.ts`; `thread-store.ts:10-13` (now deferred and coalesced, C1 fix log L5) | C11 (no writer after C8) |
| 10 | The repair in `readCurrent` and "a v1-derived twin without v1 is cleared" go with step 4 | 00-transport:1127, :1249, :1388; C1 fix log r1 L2 and r2 #1 (`threads/.archive-index.json`, `thread-store.ts:571-584`) | Per-thread index evidence decides in N and N+1 (D2 a). C15 deletes `v1Archived` and the repair; the fallback reader stays (P6). |
| 11 | The live legacy prefs sync is "transition only … Removed with the old renderer" | 00-transport:1146, :1248; `index.ts:1734-1737`; `legacy-prefs.ts:420-449` | C11 removes the `onSet` listener. The read-only, provenance-aware startup import stays through N (D2 c, review #8). N+1 step 3. |
| 12 | Step 3 `final-legacy-prefs-import-and-drop` at cut-over | 00-transport:955, :1147, :1174 (no code) | C1 (written and tested, not registered); C15 (registered) |
| 13 | C.5 steps are registered only in the cut-over build | 00-transport:1170, C-T9 :1208; `steps/index.ts:1-8`; `004-…ts:1-5` | C15, D2 |
| 14 | Downgrade safety: nothing an older build reads is mutated "until the cut-over build" | 00-transport:1021, :1168, :1308 | Kept through release N (D2) |
| 15 | **High (cut-over):** orphaned v1-derived twins come back once the rule goes | reviews/00-transport-C1.impl-claude-r1.md:21-31 | **Done** (step 4 `orphanTwins`, `cf83b4cd`; C-T9) |
| 16 | A large transcript is read as corrupt, quarantined and pruned | C1 Claude #7 | **Done** (the 64 MB cap; `tooLarge` and `unreadable` kept and never quarantined). An accessible replacement for kept sources: the fallback reader (D2, C15). |
| 17 | The dual-write cost: "or drop it until the cut-over and rely on the repair" | C1 Claude #5 (:55-65) | Moot at C11 |
| 18 | EXDEV window on `renderer-state.json`: "Medium (High once step 3 lands)" | reviews/00-transport-C.impl-claude-r1.md:40-50 | Fixed (`impl-fixes-r1.md:25`); re-proved by R7-T14 kill points for step 3 |
| 19 | `ThreadStore`/`TranscriptService` ignore the migration write-block | Codex C r2 #1 | **Done** (`c78b0285`); held writes durable since `ee9af7a4` (P2 done) |
| 20 | Stop after a deferred step, or document that no later step depends on step 4 | C1 Claude #15; C1 fix log "Handed over" | Open. C1 (runner `break` after `pending`) |
| 21 | Cleared-history protection excludes AG-UI twins | C1 Codex #3 | **Done** as `threads/<id>.cleared` with tokens and `afterClear` (`thread-file.ts:45-80`). C1 adds step 4's marker-retirement rule (review #4). |
| 22 | Any v1 read error is taken as "cleared" | C1 Claude #14 | **Done** (`readTextChecked`: only `ENOENT`/`ENOTDIR` mean missing) |
| 23 | The manual rollback procedure "documented in `PARITY.md`" | 00-transport:1022, :1332 | §12.4: generated from each home's removal index and recorded roots (D2 b); C14 publishes it |
| 24 | `FOUNDATION_API` bump: "a release decision", needs `apps/updater` in the same release | 00-transport:676, :713, :1264 | C5 (§6) |
| 25 | Swap-retry finding "dormant until FOUNDATION_API>=2" | reviews/00-transport-A.impl-claude-r1.md:10; `impl-fixes-r1.md:40` | Exercised by R7-T3 |
| 26 | `setAgentBusy` moves into main | 00-transport:320, :343; `legacy-map.ts:398-400`; `keep-awake.ts:43` | **P4** (routed), verified by R7-T27 |
| 27 | "Window chrome ships in legacy mode until the new renderer lands" | PLAN:369; 01:1135 | C5 |
| 28 | Before `RENDERER_GENERATION = "wco"`: (A) the probe reschedules every 250 ms while hidden; (B) `window:recreate` is exposed in legacy mode | reviews/00-window-chrome.impl-claude-r1.md:14; PROGRESS.md:13. (A) is half done: `index.ts:869-876` waits on `leave-full-screen`/`restore`, but a hidden window still re-arms `setTimeout(…, 250)` at :897-904. (B) is open: `index.ts:1881`, preload `index.ts:110-111` | C2 |
| 29 | Window-chrome items deferred to the renderer switch: the integration test (7 `it.todo`s in `src/main/window-chrome.electron.test.ts:3-26`, "Deferred … until renderer cut-over"), the §7 deletions, popup no-drag, browser-view zoom and translation | reviews/00-window-chrome.impl-claude-r1.md:11 | C2 (tests implemented); C9 (deletions) |
| 30 | "The old renderer keeps its constants until cut-over" | 01:1182; `shared/window-chrome.ts`; `window-chrome-options.ts:11-12,85-107,192-206` | C9 |
| 31 | `src/renderer-next` moves with `data/**` at cut-over (F12) | 01:26 | C7 |
| 32 | Legacy deps "removed at cut-over (phase 7), when knip confirms no consumers" | 01:114; `oxlint.config.ts:5` comment | C12 |
| 33 | knip scoped to renderer-next "until cut-over"; dependencies excluded | 01:229, :243; `knip.json` | C7 (scope), C12 (dependencies) |
| 34 | `matchSupportedLanguage`'s old copy stays until cut-over | 01:996 | C6 |
| 35 | Old locale keys deleted only at cut-over, when `check:i18n` and the keymap show no consumer | 01:1004; 02:1100; 03:987; `scripts/locale-keymap.json:2` | C13 |
| 36 | Old boot services not ported (log collector, activity beacon, UI continuity) | 01:984, :1135 | C3 (F4) |
| 37 | `renderer-state.json` read-only until cut-over; no reverse sync | 01:1137, :1203 | Kept read-only through N (D2); step 3 in N+1 |
| 38 | `check:legacy-diff` and `legacy-renderer-allow.json` | PLAN:382; `scripts/check-legacy-renderer-diff.mjs` | C6 (deleted) |
| 39 | `components/browser/pptx-viewer.tsx` "untouched until cut-over" | 04:1256 | C6 |
| 40 | The raw `settings:set-titlebar-density` handler "stays for tests until cut-over" | 05 §31.5 (b); `index.ts:1882-1893` | C8 |
| 41 | Old-renderer re-export shims into `shared/`: bot templates and check-in constants (03 §24.9), terminal keys/mouse wrappers, starters, `normalizeAddress` (04 §26.9), routine templates, credits URLs, homepage, changelog, `injected-text` (05 §31.7) | 03:1115; 04:1256; 05 §31.7 | C6 (shims deleted, `shared/` modules kept) |
| 42 | The legacy half of R3-T9 | 03:1036 | C6 |
| 43 | `agent.respondPermission` and `agent.queue.*` "stay for the old renderer only"; the agent's `queue.update`/`remove` must produce the same compat lines as `update_queue_item`/`remove_from_queue` | 02:1088; PARITY.md:102-109 | C8 (bridge rows); the compat-line rule stays while taps read compat (C10 keeps it) |
| 44 | The legacy IPC keeps its plain `Error` messages | 03:1110; 05 §31.5 (e) | C8 |
| 45 | Cross-generation acceptance ("the legacy generation shows the same bots / sessions / routines", the dev generation switch) | 03:1058, :1097; 04:1180, :1231; 05 R5-T36 | C9 (the legacy halves of R3-T31, R4-T34, R5-T36 are removed) |
| 46 | Legacy-generation notifications `silent: !prefs.sound` and "Task still running" | 05 §31.5 (d); 06:146-147, :888, :891 | C9 |
| 47 | The main branch of the preload stays byte-identical (moved to `main-preload.ts`) | 06:580, :1085 | C8 |
| 48 | `firstBot.title` kept for the old renderer; `scripts/locale-retired.json` | 06:976, :982 | C13 |
| 49 | `ToolResultData` must be in `shared/` before deletion | 02:606 (`renderer/conversation/agent-types.ts:273-322`) | C6, first commit |
| 50 | `<webview>` tag and its hardening in main (old preview panel) | 04:32 (F8), S80 | C9 (after `rg "<webview"` over `src` is empty) |
| 51 | The `local-cli-ndjson` stream to the old renderer | `service-host.ts:1264,1284-1295` | C8 |
| 52 | Notch probe records and the haptics default (r1 said "inference constants", which spec 06 r4 removed) | 06:651-655, §10.7 | C14: R6-T31's recorded probe JSON is in `metrics.fixtures.json`, and the haptics default follows the 150 ms rule |
| 53 | `PARITY.md` rows must name their renderer-next consumer | 06:1089; 03:1090 | C5 (sign-off column, D5) |
| 54 | Stale comment: "main's db.* answers UNAVAILABLE" | `renderer-next/env.d.ts:30-33` | C7 |
| 55 | `i18next`/`react-i18next` majors "in a separate PR that tests both renderers" | 01:23 (F9) | After the cut-over (one renderer) |
| 56 | Directory-listing errors read as empty | review r1 #2 | **Done** (P1, `272868f3`) |
| 57 | Held writes lost at quit | review r1 #7 | **Done** (P2, `ee9af7a4`) |
| 58 | Non-transactional experience activation | review #9; `experience-updater.ts:255` | **P3** |
| 59 | Keep-awake busy source | review #10 | **P4** |
| 60 | Incremental decoding, overflow and EOF on the compat and stdout pipes | review #11 | **P5** |
| 61 | `threadStore.flush()` on `before-quit`; `held.replayAll()` after `setMigrationWriteBlocks` | C1 fix log r1 and r2, "Handed over" | Before C5 (owner: main requirements agent) |
| 62 | `ai.hydrate` with an unknown `before` cursor | C1 fix log "Handed over" | **Done** (relay decision e: `NOT_FOUND`) |
| 63 | Bounded streaming fallback reader with clear-marker checks, in N | review r2 #8, #9 | **P6** |
| 64 | Step 3 must leave N able to read its home (retirement record) | review r2 #3 | C1 (step 3 writes it), C11 (N's importer reads it) |
| 65 | The runner keeps a manifest and a completion record per attempt; the restore index is derived from them | review r2 #5 | C1 (runner requirement) |

## 4. The cut-over sequence (stacked PRs)

The stack is 14 PRs for release N plus 1 for release N+1. Each targets the previous one; they land in order on the branch the release is cut from (`main`, §2 item 4). Every PR runs the standing CI (`check`, `test` ×3, `package` ×3) plus its own gate. **Gate** means the PR does not merge until the gate is green and its evidence is linked in the PR. "Legacy unchanged" means `check:legacy-diff` passes, the 24 `.ndjson` goldens are byte-identical, and the old renderer suites pass unchanged.

```
C1 migration completion ┐
C2 main parity          ├─ prepare (legacy build unchanged)
C3 renderer boot svcs   │
C4 release hygiene     ─┘
C5 THE FLIP ──────────── the one behaviour change (D1)
C6 delete old tree + entry rename ─┐
C7 move renderer-next → renderer   │
C8 delete window.api + legacy IPC  │
C9 collapse generation + chrome    ├─ delete (R7 gate must stay as it was)
C10 wire cleanup                   │
C11 transition data paths (N-safe) │
C12 dependencies + tooling         │
C13 locales                       ─┘
C14 packaging + release notes ─── cut release N
C15 retire legacy files ────────── release N+1 (after soak)
```

### C1 — Migration completion for N (main; legacy unchanged)

HEAD (`8dc67139`) already has:
- the write block, with held writes journalled under `threads/.pending/`;
- read-error classes, and `tooLarge` at 64 MB;
- orphan and cleared archiving;
- fail-closed clear markers (`savedAfterClear`);
- `threads/.archive-index.json`, written in the same commit as the removals, which a later run consults before calling a twin an orphan.

What N still needs, so it stays a safe floor for any N+1 commit, is below. P6, the fallback reader, is a prerequisite and not part of this PR.

- **Index evidence is the only rule** (D2 a; review r2 #1, #2).
  - `ThreadStore.archived()` drops its `if (this.v1Archived) return true` short-circuit (`thread-store.ts:576`).
  - A v1-derived twin with no v1 file is served only when `.archive-index.json` lists the thread with the twin's fingerprint (by `updatedAt` for a pre-fingerprint twin). Otherwise it is cleared.
  - This holds in N and in N+1. `v1Archived` is deleted in C15.
  - An unreadable or unparseable index is not evidence (`readArchiveIndex` treats it as empty). Such a thread reads as cleared until a later run rewrites the index, and it is logged. Nothing is ever served without evidence.
  - Step 4 builds the index by **merging** with the index on disk, never by replacing it. The merge is a `replace-user` write, so a rollback restores the previous index.
  - The orphan sweep skips every listed thread, as on HEAD.
  - The test runs two successive commits, each containing both archived and newly converted threads, and hydrates every thread in N after each (R7-T14).
- **Per-attempt manifest and completion record** (runner requirement; review r2 #5).
  - Before its first move, a commit writes `<backup dir>/attempt.json`:

    ```ts
    interface AttemptManifest {
      version: 1;
      attempt: string;
      step: number;
      name: string;
      stamp: string;
      roots: { home: string; userData: string };
      ops: Array<{
        op: "remove" | "replace" | "create";
        root: "home" | "userData";
        source: string;          // relative to root
        backup?: string;         // relative to the backup dir; absent for create
        originalSha256?: string; // the file before the commit
        resultSha256?: string;   // the file the commit left
      }>;
    }
    ```

  - After the record is written, the commit writes `<backup dir>/completed.json`, as `{ attempt, recordedAt, partial: boolean }`. Both files are written atomically, with a sha256 of the manifest inside `completed.json`.
  - Recovery deletes both files together with the backup directory when it rolls an attempt back. They are never pruned while the attempt is inside the rollback window.
  - `backups/migrations/restore-index.jsonl` is **derived**: one line per op of every attempt that has a valid `completed.json` whose manifest hash matches. It is rebuilt at startup when it is missing, fails to parse, or disagrees with the attempt directories. An attempt without a completion record never enters it.
  - It covers removals **and** `replace-user` backups (review r2 #4), which step 3's `renderer-state.json` and `prefs.json` are.
  - Tests:
    - damage the derived index after staging cleanup, and after three partial commits, then rebuild;
    - a manifest whose hash disagrees is excluded and logged.
- **Clear markers under step 4.** HEAD's protocol is unchanged. Step 4 retires a marker only when no v1 file remains that the marker would still count (fingerprint, `savedAfterClear`), and no twin remains without `source.afterClear === marker.token`. A failed AG-UI deletion keeps the marker.
- **Runner `break`** after a step returns `pending`, with a log line (C1 Claude #15).
- **Step 3** `final-legacy-prefs-import-and-drop` is written and tested but **not registered**:
  1. the whole-file provenance-aware import;
  2. the drop of every `LEGACY_PREFS_KEYS` key from `renderer-state.json`;
  3. in the same commit, a `create` or `replace-user` of the **retirement record** `<userData>/renderer-state.retired.json`: `{ version: 1, attempt, at, keys: { <key>: <sha256 of the dropped raw value> } }` (review r2 #3).

  `renderer-state.json` and `prefs.json` are `replace-user` writes with backups. `invalid` keys are dropped too, and their values stay in the backup.
- **N's importer honours retirement** (lives in C11's `importLegacyPrefsAtStartup`, tested here):
  - A mapped key that is **absent** and **listed** in the retirement record is skipped: no `resetLegacy`, and the prefs stay as step 3 imported them.
  - An absent key that is **not** listed keeps today's behaviour: the user or the old UI deleted it.
  - A key that is **present** is imported by the provenance rule, whether restored or re-added by N−1.
  - The test runs N+1 → N with unchanged `legacy`-provenance leaves (theme, pins, models): N's `prefs.json` stays byte-identical.
- **Gate:**
  - C-T1…C-T9, and the crash suite with step 3 and 4 kill points in the test registry;
  - `legacy-home.test.ts` still expects `[1, 2]`, plus 5 once phase 5 registers it;
  - R7-T14;
  - R7-T15's "N after every partial commit" leg;
  - legacy unchanged.

### C2 — Main parity for the new generation (main; legacy unchanged)

- **Window-chrome item (A).** In `probeAfterShow`, a hidden window waits on `mainWindow.once("show", …)`. Only a `retry-later` from a visible window re-arms the timer. `index.ts:897-904` still re-arms for hidden windows (`setTimeout(probeAfterShow, 250)` at :901).
- **Window-chrome item (B).** `ipcMain.handle("window:recreate", …)` (`index.ts:1881`) is registered only when `RENDERER_GENERATION === "wco"`. The preload member goes in C8.
- **Health check, agui mode (F7).** `checkAgentBundle(candidateRoot, { wire })`:
  - With `wire: "agui"` it spawns `[entry, "--wire", "agui", "--thread-id", "health-check"]`, without `--compat-fd` (compat `none`).
  - It resolves on the first stdout line that parses as `{ type: "CUSTOM", name: "session.ready" }`, and fails on `RUN_ERROR` or on exit before that.
  - The caller passes `"agui"` whenever `defaultWire(…)` is true.
- **Refused-target memo.** `ExperienceUpdater` records a target hash whose verification failed on foundation, API, protocol or provenance grounds, and skips it until relaunch (§6.4).
- **Withdrawal-aware install** (review r2 #16). Before any install, whether auto-restart, "Relaunch to update" or install-on-quit, `UpdateService` runs a fresh feed check, and installs only if the feed still offers the downloaded version to this client (staging included).
  - Otherwise it drops the build (`dropDownloadedBuild`) and turns install-on-quit off.
  - Periodic checks keep running during a download as metadata-only checks. A halt seen mid-download cancels the transfer (`CancellationToken`) and drops the partial file.
  - It is legacy-safe, so it is taken ahead of the stack into the dormant release (§2 item 4) if one ships. Only clients that can still be changed benefit.
- **Window-chrome Electron integration test.** The 7 todos in `src/main/window-chrome.electron.test.ts` are implemented.
- **Coupling test.** `src/main/services/updates/experience/foundation-api.test.ts` asserts that the desktop and updater `FOUNDATION_API` and protocol are equal.
- **Not here:** keep-awake (P4) and activation (P3) are prerequisites; the wire default is done (F1).
- **Gate:**
  - R7-T28 and R7-T29 on three OSes;
  - R7-T8 in both modes;
  - legacy unchanged.

### C3 — Renderer-next boot services and the two-stage barrier

- **Activity beacon.** `lib/activity.ts`:
  - listens to `pointerdown`, `keydown` and `wheel` in the capture phase, and calls `transport.client.window.activity()` at most once per 5 s (the old `THROTTLE_MS`, `renderer/lib/activity-beacon.ts:6`);
  - is installed after `bootstrap()`, never in the notch entry.
- **UI continuity.** `lib/continuity.ts` defines `window.__captureUiContinuity()` and `window.__restoreUiContinuity(snapshot)`, the globals `renderer-host.ts:252-281` calls.
  - **DOM part:** the focused `data-continuity-id`, the caret or selection, and each `data-continuity-scroll` viewport's anchored message id and offset (20 scrollers, as `ui-continuity.ts:31`).
  - **Draft part** (review r2 #13). Every `sessionStorage`-persisted store registers with `lib/continuity/registry.ts` under a versioned key, with a valibot schema:
    - `chat.drafts`: 02 §8.7 `{ text, attachments, mode?, model? }` per thread;
    - `bots.drafts`: 03 §8.3 `{ id, name, look, templateId, values? }` for `"new"` and edited bots;
    - `sessions.startDraft`: 04's start-page state machine;
    - `sessions.panelTabs` and `sessions.review`: 04;
    - `routines.editorLog`: 05.

    A later spec that adds a `sessionStorage` store must register it; `guards.test.ts` fails on an unregistered `sessionStorage` key.
  - Capture serializes every registered store. Attachments travel **by reference** (staged ids and paths), never as bytes.
  - If the snapshot exceeds 4 MB, capture answers `{ tooLarge: true }`. The host treats that as `busy` and retries at the next quiet moment, so it never swaps and loses a draft.
  - Restore validates each key against its schema, hydrates the stores, then applies the DOM part, all before the stage-2 promise resolves. A key that fails validation is dropped and logged.
  - The route travels in the hash (`renderer-host.ts:362-368`).
- **Two-stage barrier** (D11, review #13). The host order stays as it is:
  1. load the candidate;
  2. **stage 1**: readiness (`window.ready({ barrier: "subscriptions" })`, `renderer-host.ts:392-393`);
  3. capture the continuity of the live view;
  4. **stage 2**: `__restoreUiContinuity(snapshot)` returns a promise, which the candidate resolves after React commits the restored state and the scroll positions are applied. `restoreContinuity` awaits it for up to `RESTORE_TIMEOUT_MS` (2 s);
  5. settle, then flip.

  The candidate reports readiness from its data alone and never waits on restoration. Restoration completes before exposure, because the candidate stays beneath the live view until the flip. `restoreContinuity` becomes `Promise<"restored" | "timeout" | "none">` and is logged. A timeout still flips, as a plain swap.
- **Log collector.** Phase 5's `lib/log-ring.ts` (05 §21.4) is installed at boot in both entries.
- **Gate:** R7-T3 asserts the real host and candidate sequence (stage 1, capture, stage 2, flip) against a candidate that delays each stage. R1-T20 is unchanged.

### C4 — Release hygiene (tooling; no runtime change)

- **`scripts/check-release-build.mjs` (F16).** It fails when `dist/renderer` or `dist/main` contains any of:
  - `__abacusDev` or the `dev-hooks` chunk;
  - `memory-source`, the fixture DB;
  - `VITE_UI_GALLERY` or `VITE_NEXT_DB_FIXTURES` set truthy (read from Vite's `define` output, which the build writes);
  - `TanStackDevtools`, `ReactQueryDevtools` or `TanStackRouterDevtools`;
  - `guardSingleViewTransition` active code;
  - `mutation-harness` source.

  The harness moves behind `import.meta.env.DEV`-style dead-code elimination in main. `vite-plugin-electron` main builds get `define: { "import.meta.env.ABACUS_DEV_HARNESS": JSON.stringify(!isRelease) }`, so the module is not in the packaged `dist/main` at all instead of being inert.

  `scripts/build-experience.js` and electron-builder's `beforePack` (`scripts/before-pack.cjs`) both run it.
- **Build provenance** (D3, review #14).
  - `vite build` writes `dist/renderer/build.json`, and the agent build writes `packages/agent/dist/build.json`. Each holds `{ commit, dirty, foundationApi, protocol, generation, builtAt }`, taken from the **source** constants at build time: `FOUNDATION_API` and `EXPERIENCE_PROTOCOL` from `src/shared/experience.ts`, and `generation` from `DEFAULT_RENDERER_GENERATION`.
  - `apps/updater` `buildManifest` reads both files and refuses when either is missing, when they disagree on `commit`, `foundationApi` or `protocol`, or when their `foundationApi` differs from the builder's own. The manifest records the renderer's `commit`.
  - `integrity.ts` checks the same agreement at install.
  - An old tree packaged by a new builder therefore fails at build time, and again at install.
  - **The commit is pinned and part of the cache key** (review r2 #10). `commit` comes from `ABACUS_BUILD_COMMIT`, which the release pipeline sets to the pinned commit. It is required when `CI` or `ABACUS_RELEASE=1` is set; otherwise it falls back to `git rev-parse HEAD`, plus `dirty`.
    - `turbo.json` lists `ABACUS_BUILD_COMMIT` in the `env` of `@abacus-ai/desktop#build` and `@abacus-ai/agent#build`, so a change of commit is a cache miss for both.
    - An agent-only hotfix at a new pinned commit therefore rebuilds the renderer too, and the stamps agree.
    - Two builds at one commit hit the cache together.
    - Test: an agent-only change with a new `ABACUS_BUILD_COMMIT` gives agreeing stamps, and a renderer cache hit with a stale stamp is impossible.
- **CI** gains `check:knip-next` and `check:ui-registry` in the `check` job (F12).
- **`size-limit`.** `size-limit` and `@size-limit/file` go into root devDependencies, with `.size-limit.json` entries measured against `dist/renderer/assets`:
  - the initial JS and CSS of `index-next.html`;
  - the initial JS and CSS of `notch.html`;
  - the largest lazy route chunk;
  - `temml`'s lazy chunk.

  This PR records a baseline with no limits enforced. C12 sets them (§14.4).
- **Smoke markers and exit** (review r2 #14).
  - Under `ABACUSAI_BOT_SMOKE_TEST=1`, main no longer calls `app.exit(0)` right after `[smoke] main process ready` (`index.ts:2131-2135`). It waits, for at most 90 s, for these outcomes:
    - the **renderer**: `rendererReadiness` for the main window gives `[smoke] renderer ready`, `[smoke] renderer failed: <reason>` or `[smoke] renderer timeout`. In legacy, `renderer-ready` stands in.
    - the **companion**, on darwin and win32 in the wco build: `[smoke] notch ready`, or `[smoke] notch disabled: <reason>`. The reason is one of spec 06 r4's outcomes: probe failed, no internal display, no cut-out, off by pref. `[smoke] notch failed` covers anything else. Linux prints `[smoke] notch n/a`.
  - Then it exits: 0 when the renderer is ready and the companion is ready or disabled with a reason, 1 otherwise, including on the 90 s bound.
  - The CI step checks the exit status and greps the markers. A macOS runner, which has no notched display, is expected to print `notch disabled: no internal display` or `probe failed`.
- **Gate:** CI green; `check-release-build` fails on a `VITE_UI_GALLERY=1` build and passes on `pnpm run build` (R7-T31).

### C5 — The flip (the one behaviour change)

- `renderer-generation.ts:7`: `DEFAULT_RENDERER_GENERATION = "wco"`. `resolveRendererGeneration` gains the reverse dev override: `ABACUSBOT_RENDERER_GENERATION=legacy` works only when unpackaged, and only until C6 deletes the tree it would load. After C6 the generation is always `wco`, and C9 removes the dead branches.
- `FOUNDATION_API = 2` in `src/shared/experience.ts:11` and `apps/updater/src/manifest.ts:10` (D3). The swap barrier becomes `subscriptions` (`index.ts:425`), and stage 2 follows it (D11). From API 2 the verifier requires `renderer/notch.html` and consistent build provenance.
- Every spawn is agui, because `defaultWire` follows the generation (F1). The health check runs in agui mode.
- `classify.ts` `EXPERIENCE_PREFIXES` gains `apps/desktop/src/renderer-next/`, `apps/desktop/index-next.html` and `apps/desktop/notch.html` (F5). `classify.test.ts` covers each.
- CI step "The desktop entry still speaks NDJSON" (`ci.yml:197-216`) becomes "The agent speaks AG-UI with a compat stream":
  - it runs `dist/main.js --wire agui --thread-id ci --compat-fd 3 3>compat.ndjson` with the `plain-text` input the spawn e2e uses;
  - it asserts stdout line 1 is `CUSTOM wire.hello` and `compat.ndjson` holds `compat.hello` then `{"type":"ready"…}`.
  - The NDJSON variant stays alongside until C10.
- `PARITY.md` sign-off (D5):
  - `legacy-map.ts` rows gain `consumer: "<renderer file>#<symbol>" | "retired: <reason>"`;
  - `parity.test.ts` fails on an empty consumer;
  - the generated file gains the column and a "Signed off at <sha>" line.
- **Gate (the full release-candidate gate, §15):**
  - R7-T1 … R7-T8, **R7-T9a**, R7-T10 … R7-T13, R7-T16, R7-T18 (pre-deletion form), R7-T23 (report only), R7-T24, R7-T25, R7-T30 (review #19: R7-T9b belongs to C10);
  - the parity sign-off checklist (§11) is complete, with evidence links;
  - the performance budgets (§14) are met on the reference machines.

  The last legacy-generation build and this flip build are both packaged from CI artifacts for comparison.

### C6 — Delete the old renderer tree, rename the entry

- First commit: move what the new code still needs out of `src/renderer`:
  - `ToolResultData` and its siblings from `renderer/conversation/agent-types.ts:273-322` go to `src/shared/transcript/tool-result.ts` (F11);
  - the oracles in `legacy-prefs.test.ts:215-235` become literal expectations (`LEGACY_ONBOARDING_STEPS = ["auth","welcome","connectors","models","explainer"]` and the homepage regex), each commented with the commit they were read from.
- Delete `src/renderer/**` **except** `src/renderer/locales/**` (D6). That is 436 files, about 84.8k lines of TS/TSX outside locales, including `conversation/` (about 6.9k non-test lines), `stores/` (zustand) and every re-export shim of §3 row 41.
- Delete `apps/desktop/index.html` (legacy) and `git mv index-next.html index.html` in the **same** commit (F10).
- `vite.config.ts`: **two** inputs, `main: index.html` and `notch: notch.html` (D10, review #12). `renderer-entry.ts`: `NEXT_ENTRY` and `LEGACY_ENTRY` collapse into `ENTRY = "index.html"`; `rendererEntry` and `experienceEntryUrl` lose the generation parameter; `notchEntry` (06:634) is unchanged.
- Delete `tsconfig.renderer.json` and its reference, the `renderer` vitest project, the old-renderer oxlint override (`oxlint.config.ts:31-67`), `check:legacy-diff` (script, allow list, `src/main/dev/legacy-diff.test.ts`, root `check` entry) and the old `matchSupportedLanguage` copy.
- `package.json` scripts: `dev:next` → `dev`, `dev:next:fixtures` → `dev:fixtures`. The old `dev` goes.
- **Gate:**
  - `pnpm run build` and `typecheck` pass, and every remaining suite passes;
  - the R7-T16 packaged smoke passes on three OSes;
  - R7-T4, because `classify` must still say `experience` for `index.html` (§6.3);
  - `integrity.test.ts` passes;
  - the packaged app and the experience built after C6 both contain `renderer/index.html` and `renderer/notch.html` (R7-T18);
  - the screenshot gate shows 0 changed pixels against C5's run (same routes, same fixtures).

### C7 — Move `src/renderer-next` to `src/renderer` (F12; pure move)

- `git mv src/renderer-next/* src/renderer/`. `locales/` is already there.
- Codemod `#next/` → `#renderer/` in every import. `package.json` `imports` drops `#next/*` and repoints `#renderer/*`. `vite.shared.ts`: `NEXT_SRC`/`NEXT_MODULES` → `RENDERER_SRC`/`RENDERER_MODULES`, and the plain `react()` instance goes, since there is one tree.
- Both router plugin instances: the main tree (`vite.config.ts:57-64`) and the notch tree (06 R6-T1, "the second router plugin"). `notch.html`'s `<script src>` moves from `/src/renderer-next/notch.tsx` to `/src/renderer/notch.tsx`. `tsconfig.renderer-next.json` → `tsconfig.renderer.json`. The vitest `renderer-next` project → `renderer`. `components.json` aliases.
- `knip.json` (review #24):
  - **`project`** becomes `["src/**/*.{ts,tsx}", "scripts/**/*.{js,mjs,cjs}", "*.config.ts", "vite.shared.ts"]`;
  - **`ignore`** is only `src/renderer/routeTree.gen.ts`, the notch route tree and `src/renderer/ui/**`;
  - **entries** are `src/renderer/{main,notch}.tsx`, `src/renderer/routes/**`, the notch routes, `src/main/index.ts`, `src/preload/index.ts`, every test file, and **each executable script by name** (review r2 #15).
    - The script list is enumerated from what actually runs a script: `package.json` `scripts`, `electron-builder.yml` `beforePack`, `.github/workflows/*.yml` `node scripts/…` lines, and the turbo tasks.
    - `scripts/check-knip-entries.mjs` fails when one of those references a script missing from the list, or the list names a script nothing runs.
    - Helper modules under `scripts/` stay in `project` scope, not entries, so an unused helper is reported.
  - R7-T22's canaries prove each area is covered. Dependencies follow in C12.
- The oxlint renderer-next override moves to `src/renderer/**`. `RENDERER_NEXT_BANNED_PACKAGES` → `RENDERER_BANNED_PACKAGES`, and the ban stays so none of them comes back.
- Scripts:
  - `screenshots-next.mjs` → `screenshots.mjs`, and `shadcn-next*.mjs` → `shadcn*.mjs`;
  - `check-jsx-i18n.js` `SCAN_DIRS = ["src/renderer"]`, ignoring `src/renderer/ui` and `features/gallery`;
  - `sync-locales.js` scan dirs;
  - `guards.test.ts` paths.
- `classify.ts` prefixes return to `apps/desktop/src/renderer/`, `apps/desktop/index.html` and `apps/desktop/notch.html`. Stale comments go, e.g. `env.d.ts:30-33`.
- **Parity consumers are rewritten** (review r2 #12). Every `consumer: "src/renderer-next/…#symbol"` in `legacy-map.ts` and in the `features/*/parity.ts` files becomes `src/renderer/…#symbol`. The consumers are re-resolved (R7-T25), and `PARITY.md` is regenerated. C8 then freezes it.
- **Gate:**
  - no behaviour change: the screenshot gate shows 0 changed pixels against C6, and every suite passes;
  - `rg -n "renderer-next|#next/" apps packages .github knip.json oxlint.config.ts` returns nothing (`docs/` keeps its history).

### C8 — Delete `window.api` and the legacy IPC

- **Preload** keeps `installRpcPortHandshake` and `abacusHost.getPathForFile`, plus the notch dispatcher (06:550-581).
  - It deletes `bridge.ts`, the `api` object, the `durableState` `sendSync` (`index.ts:30-41`), `index.d.ts` `api` types, `browser-runtime-bridge`, `terminal-runtime-bridge`, `worktree-bridge` and their tests.
  - `preload-exposure.test.ts` asserts `exposed.keys() == {"abacusHost"}`.
- **`handler.ts`.** `registerIpcHandlers` becomes `wireHostEvents(serviceHost)`: the dispatcher, the bus and the credential saver (`:475-490`), returning `createHostOperations(…)`. Every `ipcMain.handle(IpcChannels.*)` goes (`:493-…`).
- **`index.ts` raw handlers go:**
  - `renderer-activity` and the `renderer-ready` barrier: `SwapBarrier` narrows to `subscriptions`, and `READY_TIMEOUT_MS` and `rendererReady()` are deleted from `renderer-host.ts`;
  - `open-external`, `show-item-in-folder`, `get-app-version`, `window:show-about`, `restart-app`, `get-home-dir`, `has-google-chrome`;
  - `window:chrome`, `window:recreate`, `settings:set-titlebar-density`, `append-logs`, `save-logs`;
  - `account:*`, `funnel:step`, the dialogs, `read-clipboard-image`, `fetch-url-attachment`, `skills-*`;
  - the rest of `:1802-2090`.

  Each is already a contract procedure; `PARITY.md` names it.
- **Other main files.** `keep-awake.ts` IPC (the service stays, fed by P4), `update-handler.ts` (the whole file), `renderer-state.ts` `registerRendererState` IPC (`:196-215`) and `browser-runtime-handler.ts`.
- **`emit.ts`.** `emitIpcEvent` becomes the bus dispatch only (renamed `emitHostEvent`); `sendToRenderer(IpcChannels.Event, …)` goes. `publishToWindowViews` stays. The legacy `window:chrome-changed` (`index.ts:1589-1590`) and `window:full-screen-changed` (`:645`) sends go.
- **Removed next:**
  - `IpcChannels` (`shared/channels.ts`), deleted when `rg IpcChannels src` is empty; the browser-runtime channel names move to local constants if main still needs them;
  - `service-host.ts:1264,1284-1295`, the `local-cli-ndjson` emission;
  - the legacy-only `agent.respondPermission`/`agent.queue.*` host operations with no contract caller (02:1088);
  - the legacy plain-`Error` message branches (03:1110; 05 §31.5 e).
- **Parity generator.** `legacy-map.ts`, `preload/parity.test.ts` and `shared/contract/legacy-map*.ts` are deleted. `PARITY.md` stays as the frozen sign-off record (D5), with a header line pointing to this spec.
- **Gate:**
  - R7-T19, R7-T20 and R7-T21 (IPC and preload rows);
  - every `rpc/**` suite; R1-T15 and R1-T22; the packaged smoke;
  - a swap test (R7-T3) proving the two-stage barrier with `first-commit` gone.

### C9 — Collapse the generation and the legacy chrome

- Delete `renderer-generation.ts` and its test. `WindowChromeMode` and every `RENDERER_GENERATION === …` branch in `index.ts` (`:455-460,588-598,604-633,789,856-915,1589,1886-1891`) and `window-chrome-options.ts` (`:85-107,192-206`) collapse to the wco path.
- `shared/window-chrome.ts` and its test are deleted, along with `shared/window-chrome-state.ts` if `window.chrome` no longer imports it. `startup-theme.ts` loses its generation parameter.
- The legacy-generation notification branch (`silent: !prefs.sound`) and "Task still running" go (§3 row 46).
- The `<webview>` tag and its hardening go (§3 row 50), once `rg "<webview|webviewTag" src` finds only main's own guard.
- Tests: R1-T17 is rewritten (entry and experience URL only, already single-entry since C6); R1-T19 is reduced to "`prefs.json` is authoritative; `renderer-state.json` is read by the migration only". The legacy halves of R3-T31, R4-T34 and R5-T36 are removed.
- **Gate:**
  - R7-T21 (chrome rows, F17's pattern);
  - window-chrome acceptance (00-window-chrome §12) re-run in the packaged build on three OSes;
  - the screenshot gate unchanged.

### C10 — Wire cleanup (agent and main)

- **Agent.**
  - `host.ts` (`NdjsonHost`) and its export at `index.ts:45-46` are deleted.
  - `main.ts`: `--wire` absent means `agui`, and `--wire ndjson` exits 64 with `{"type":"error","code":"wire_unsupported"}` on stderr (D4). `--thread-id` stays required.
  - `agui/record.ts` moves to `AguiHost` behind the same `ABACUSAI_BOT_WIRE_RECORD`: it records AG-UI out, compat out and stdin.
  - `agui/queue.ts`: the non-reserving legacy branch of `reserveDuringAbort` (`:77-83,475-490`) goes.
  - Tests: `ndjson-golden.integration.test.ts`, `ndjsonDriver` (`agui/__tests__/harness.ts:402-405`) and the `--wire ndjson` spawn case go. The header comment of `main.ts:4-7` is updated.
- **Main.**
  - `cli-manager-service.ts`: `resolveWire`, the `?? "ndjson"` default (`:129,:601`), the 3-pipe branch (`:623`) and `handleStdout` (`:985-1010`) go.
  - `relay-service.ts`: `wireFor`, `#claimed`, `aguiForEverySpawn` and the "speaks the legacy protocol" `UNAVAILABLE` paths (`:652-693`) go.
  - `service-host.ts`: `:1253` and the ndjson auto-allow branch (`:1329-1336`) go.
  - The health check is agui only.
- **Kept (F2):**
  - `protocol.ts`, `agui/sink.ts`, `agui/channel.ts`, `HostCore`, `internal-events.ts` and `event-meta.ts`;
  - main's `handleCompatFd`, the inline branch of `handleAguiStdout`, `handleNdjsonLine`, `answerHostService` and the `emitNdjson` tap fan-out;
  - `shared/agent-types.ts` and `protocol-mirror.test.ts`;
  - **all 24 `.ndjson` baselines**, as frozen oracles (§8.2).
- CI: the NDJSON smoke step goes, and the AG-UI step stays.
- **Gate:** R7-T5, R7-T6, R7-T7, R7-T8 and **R7-T9b** on three OSes; `rg -n 'NdjsonHost|resolveWire|wireFor|aguiForEverySpawn|ABACUSAI_BOT_AGENT_WIRE' apps packages` returns nothing (the agent's own refusal of `--wire ndjson`, D4, is the one place the word stays).

### C11 — Transition data paths that are safe to remove in N

- `installLegacyPrefsSync` (`index.ts:1737`, `legacy-prefs.ts:427-449`) loses its live half: the `onSet` listener, the IPC and `RendererStateStore`'s mutation paths. Its **startup whole-file import stays** through N (review #8): read-only, provenance-aware, run once per launch after the runner.
  - It catches drift after a dormant → pre-rewrite → N path: step 2 is already applied, but a pre-rewrite build changed `renderer-state.json` after it.
  - `legacy` provenance never overrides a `user` leaf, so choices made in N win.
  - The import is renamed `importLegacyPrefsAtStartup` and keeps only `readRendererStateFile`. Step 3 in N+1 is its last run.
- Delete the dual-write: `TranscriptService.write` (no caller after C8), `ThreadStore.writeFromV1`, and the `dual-write` own-write cache kind.
- **Retirement-aware import** (review r2 #3). `importLegacyPrefsAtStartup` reads `<userData>/renderer-state.retired.json` when it exists. A mapped key that is absent and listed there is skipped: it never reaches `resetLegacy` (`legacy-prefs.ts:403`). Unlisted absent keys and present keys behave as on HEAD. Tests are in C1.
- **Kept until N+1 (D2):**
  - the repair in `readCurrentFile`, still needed while step 1 may be pending or blocked;
  - the per-thread rule: a v1-derived twin with no v1 file is served only with `.archive-index.json` evidence (C1);
  - `TranscriptService.remove`'s v1 removal (the dual-remove), so a thread cleared in N stays cleared if the old build is reinstalled and N is then reinstalled;
  - P6's fallback reader, which is permanent (C15).
- **Forward compatibility with N+1** comes from the archive index, the retirement record and the fallback reader, never from a step-4-applied switch. A home N+1 migrated only partly still reads correctly in N.
- **Gate:**
  - C-T* green;
  - R7-T13 (downgrade) passes against a home N has run on, including the dormant → pre-rewrite → N leg (R7-T11b);
  - R2-T11/T13 (migrated history) green.

### C12 — Dependencies and tooling

- Remove the dependencies in §5.6 whose grep returns nothing. Also:
  - the `react-tourlight` patch (`patches/react-tourlight@0.3.0.patch` and `pnpm-workspace.yaml:75`);
  - `allowBuilds."@tsparticles/engine"` (`:36`).
- `knip.json` covers the whole desktop app with `dependencies` and `unlisted` included. The script `check:knip-next` → `check:knip`, with root `check` and CI updated.
- `.size-limit.json` limits set from the C5 measurements (§14.4); CI runs `size-limit` in the `package` job after `build`.
- `ci.yml:25-29` `NODE_OPTIONS` comment: "monaco, shiki, katex" are gone. Measure the build's peak heap and keep 4096 only if still needed.
- `build/licenses/lobe-icons-LICENSE`/`sources.json` stay only if `ConnectorMark` (03 §14) still carries the Exa/Firecrawl/Tavily paths; the same for `devicon-LICENSE`. Decided by `rg` over `src/renderer/components/connector-mark`.
- CSP: `'unsafe-eval'` (`renderer-csp.ts:5`, `index.html`, `notch.html`) is re-evaluated. If the packaged app passes R7-T16/T30 with `script-src 'self' 'wasm-unsafe-eval'` (transformers.js WASM), it is narrowed; otherwise it is kept and the reason is recorded.
- **Gate:** R7-T22 and R7-T23; `pnpm install --frozen-lockfile` in a clean checkout; `check:audit`.

### C13 — Locales

1. **Apply the keymap first** (review #18): `sync-locales --apply-keymap` copies every mapped old translation into its new key in all 11 locales, and the result is committed.
2. **Compute the final consumer set** over `src/renderer` (outside `locales/`):
   - `t("…")` literals, with CLDR plural stems (`sync-locales.js` `PLURAL_SUFFIXES`);
   - every string literal equal to a full leaf (keys held in data, e.g. `titleKey: "…"`);
   - `i18nKey` props;
   - for template keys (``t(`a.b.${x}`)``, which `checkKeyUsage` allows by static prefix), either the enumerated values declared in `scripts/i18n-dynamic-keys.json` (`{ prefix, values }`, taken from the typed union the template interpolates) or, when undeclared, every leaf under the static prefix.
3. **Delete** every `en-US` leaf outside that set, whether keymap source, retired (`scripts/locale-retired.json`) or unused, and the same leaves in the 10 other locales.
4. Then delete `--apply-keymap`, `locale-keymap.json` and `locale-retired.json`, and R1-T16's keymap half.

- **Gate:** R7-T26 (no leaf outside the consumer set; every template key's prefix declared or covered; 11 locales with equal key sets).

### C14 — Packaging and release notes (release N is cut here)

- `electron-builder.yml`: remove the duplicate `NSMicrophoneUsageDescription` line (`:145-146`). §10 lists everything else that was checked and needs no change.
- R6-T31's recorded probe JSON is committed to `metrics.fixtures.json`, and the haptics default follows 06 §10.7's 150 ms rule. There are no inference constants (06 r4).
- `CHANGELOG.md` `## Unreleased` gets the user-facing notes (§12.1). The version bump is a foundation release.
- `docs/rewrite/PLAN.md` phase 7 is amended as in §16, and `PROGRESS.md` is updated.
- Support article: "Going back to the previous version", with the text of §12.3 (from N) and §12.4 (from N+1: the `--restore-legacy-files` command only, with no manual file-moving procedure).
- **Gate:** R7-T16 and R7-T18 on the final tree; R7-T17 on the signed RC in the private pipeline; R7-T24 re-run on the signed RC; the release manager's go.

### C15 — Retire the legacy files (release N+1)

- **Entry:**
  - N at 100 % for ≥ 14 days;
  - no rollback trigger (§12.2) hit;
  - no open P0 or P1 against migrated data.
- Register steps 3 and 4 in `MIGRATION_STEPS` (`[1, 2, 3, 4, 5]`; step 5 `routine-attempt-ids` is registered by phase 5, 05 §31.5 f).
- In the same commit:
  - **delete the `v1Archived` option** (review r2 #2). Per-thread index evidence stays the rule, exactly as in N.
  - remove the repair (converting a v1 file into a **written** twin), the dual-remove and the startup prefs import.
- A thread with no v1 file and no evidence reads as cleared in N+1 too. That covers a failed step-4 plan, an unresolved recovery, and a twin step 4 could not inspect. R7-T14 tests all three.
- **`--restore-legacy-files`** (§12.4) is implemented in main. It reads each profile's derived restore index, rebuilds the index first if needed, selects per destination by restoration generation, restores with digest checks and collision handling, updates the metadata, and writes a report.
- **The fallback reader stays** (P6, already in N). It is removed only in a later release, after field logs show no home with retained sources. Step 4 records `kept`, `tooLarge`, `unreadable` and `failed` in `migrations.json` stats.
- **Gate:**
  - R7-T14 on the real registry;
  - R7-T15;
  - R7-T10 and R7-T11 re-run with N+1 as the target.

## 5. Deletion inventory

Each row has a proof: a grep or a test that must come back empty or green after the named PR. R7-T21 runs every grep in this section as one test (§15).

### 5.1 The old renderer tree (C6)

| What | Size (unchanged from r1's `24b02486` to `c46e77d9`) | Notes |
|---|---|---|
| `src/renderer/**` except `locales/` | 436 files. About 84.8k lines of TS/TSX outside `locales/`. | Includes `conversation/` (about 6.9k non-test lines, the PLAN's "conversation layer"), `stores/` (the zustand stores), `providers/`, `terminals/`, `voice/`, `hooks/`, `lib/` (`activity-beacon.ts`, `ui-continuity.ts`, `durable-storage.ts`, `window-chrome.ts`, `i18n.ts`), the legacy dialog wrapper, the hand-rolled tabs, menus and listboxes, the `?view=` redirects and `staticData.titleKey/backTo` (all PLAN "Nuked"). |
| `apps/desktop/index.html` (legacy entry) | 16 lines | Replaced by the renamed `index-next.html` in the same commit (F10). |
| `tsconfig.renderer.json`, vitest project `renderer` (`vitest.config.ts:64-75`), oxlint override `oxlint.config.ts:31-67` | — | The new tree takes over these names in C7. |
| `scripts/check-legacy-renderer-diff.mjs`, `scripts/legacy-renderer-allow.json`, `src/main/dev/legacy-diff.test.ts`, `check:legacy-diff` in both `package.json`s | — | Their only purpose was guarding the old tree. |
| Re-export shims and wrappers (§3 row 41), `components/browser/pptx-viewer.tsx` (row 39) | — | The `shared/` modules they point at stay. |

**Kept:** `src/renderer/locales/*.json` (11 files, D6), and every `src/shared/**` module the specs moved out of the old tree.

**Proof** (r2, review #16; checked against inventories, not path patterns):

- **Inventory.** C5 commits `scripts/cutover/legacy-renderer-inventory.json`: every path under `src/renderer/` except `locales/`, with its git blob sha, at the C5 commit. The legacy entry `index.html` is included.
- **R7-T21, part 1.** No inventory path exists with its legacy blob. A path may exist again only if its file came from renderer-next (C7), which `git log --follow --diff-filter=R` shows. For example, `src/renderer/main.tsx` exists in both trees.
- **R7-T21, part 2.**
  - Every module specifier under `apps/desktop/src` is parsed with **`oxc-parser`** (F24): `parseSync(file, source).module`'s `staticImports`, `staticExports[].entries[].moduleRequest` and `dynamicImports`, plus a `Visitor` pass for `require(…)` calls. CSS `@import`/`@plugin`/`@source` strings come from a CSS tokenizer. Each specifier is resolved through the package `imports` and the Vite aliases.
  - No specifier may resolve to an inventory path whose current blob is the legacy one, or to a path that no longer exists.
- **Negative control.** A fixture importing `#renderer/components/bot-avatar` (a migrated molecule) passes, and a fixture importing a deleted legacy module fails.

### 5.2 `window.api`, the preload and the legacy bridge (C8)

| What | Where | Replaced by |
|---|---|---|
| `window.api` (249 members: 62 Q, 137 M, 6 S, 25 T, 19 R; `PARITY.md:11-268`) | `preload/index.ts:49-279`, `preload/bridge.ts` (1090 lines), `preload/index.d.ts` (197 lines) | The oRPC contract through the MessagePort (`preload/rpc-port.ts`). Every member has a destination in `PARITY.md`, and the 19 R rows have a reason. None is empty (verified by script). |
| `durableState` and the synchronous `renderer-state:snapshot` read | `preload/index.ts:30-41,252-264` | `db.prefs` (spec 00 B) |
| `reportUiActivity` (`renderer-activity`), `signalRendererReady` (`renderer-ready`) | `preload/index.ts:266-276` | `window.activity`, `window.ready` (C3, spec 00 A.4.6) |
| `recreateMainWindow`, `isFullScreen`, `onFullScreenChange`, `getWindowChrome`, `onWindowChromeChange` | `preload/index.ts:87-111` | `window.state`, `window.events`, `window.chrome`; recreate is main-only |
| Bridge sub-modules and tests | `preload/{browser-runtime,terminal-runtime,worktree}-bridge.test.ts`, `preload/parity.test.ts` | — |

**Kept:**
- `installRpcPortHandshake` (`preload/rpc-port.ts`);
- `window.abacusHost.getPathForFile` (`PARITY.md:268`, "the only non-port preload export");
- the notch dispatcher of 06:550-581.

**Proof:**
- `rg -n "window\.api|exposeInMainWorld\(\"api\"" apps/desktop/src` returns nothing;
- `preload-exposure.test.ts` sees exactly `{ abacusHost }` for both `--abacus-window` kinds.

### 5.3 Legacy IPC channels no longer used (C8, C9)

**`IpcChannels`** (`shared/channels.ts`, 195 members) is deleted whole. Its users are:
- `handler.ts:493-…` (every `ipcMain.handle(IpcChannels.*)`);
- `rpc/emit.ts:16`;
- `services/browser/browser-runtime-handler.ts:47-…` (the `handle()` helper) and `electron-browser-runtime.ts:751` (a legacy `IpcChannels.Event` send to the browser runtime's own window, beside `publishIpcEvent`);
- `preload/bridge.ts`;
- tests.

The browser runtime keeps only its bus path. The preload no longer registers the invoke-style device-stream channels (`StartDeviceStream`, `StreamDeviceTouch`, `StreamDeviceKey`; `channels.ts:140-148`); their contract procedures stay.

**Raw string channels registered in main** (`ipcMain.handle|on`, tests excluded) that go:

| File | Channels |
|---|---|
| `index.ts:401` | `renderer-activity` |
| `index.ts:1795-2090` | `open-external`, `open-file-path`, `show-item-in-folder`, `get-app-version`, `window:show-about`, `window:is-full-screen`, `restart-app`, `get-home-dir`, `has-google-chrome`, `theme:set`, `show-notification`, `window:chrome`, `window:recreate`, `settings:set-titlebar-density`, `append-logs`, `save-logs`, `account:get`, `account:skip`, `account:sign-out`, `account:forget`, `funnel:step`, `open-folder-dialog`, `open-files-dialog`, `save-pasted-temp-files`, `read-clipboard-image`, `fetch-url-attachment`, `files:read-image-as-data-url`, `files:read-file-as-text`, `files:read-pptx`, `skills-list-installed`, `skills-search-marketplace`, `skills-install`, `skills-remove`, `skills-import-local`, `skills-open-file` |
| `keep-awake.ts:35-46` | `power:get-keep-awake`, `power:set-keep-awake`, `power:set-agent-busy` |
| `services/config/renderer-state.ts:201-213` | `renderer-state:snapshot`, `renderer-state:set`, `renderer-state:clear` |
| `services/updates/update-handler.ts:6-14` | `update:check`, `update:install`, `update:get-status` |
| `services/browser/browser-runtime-handler.ts` | the browser-runtime invoke channels |

**Main → renderer pushes that go** (the bus path next to each stays):
- `sendToRenderer(IpcChannels.Event)` (`rpc/emit.ts:16`);
- `update-status` (`update-service.ts:450`);
- `notification-clicked` (`index.ts:1398`);
- `window:full-screen-changed` (`index.ts:644-647`);
- `window:chrome-changed` (`index.ts:1589-1590`);
- `agent:device-stream-chunk`: the `wc.send` in `device-stream-service.ts:233`, `ios-stream-service.ts:186` and `android-scrcpy-service.ts:339`. The services take the `publish("device-chunk", …)` sink instead of a `WebContents`, and `rpc/device-chunks.ts`'s proxy goes.
- `local-cli-ndjson`, the `IpcEvent` the old renderer read (`service-host.ts:1264,1284-1295`).

**Kept:**
- `rpc:connect` (`rpc/transports/message-port.ts:169`);
- the notch window's `--abacus-window` argument (06);
- the browser runtime's own preload channels, if 04 kept any for the WebContentsView content (those are not app IPC);
- internal `ipc-message` listeners that are not renderer API (none left after C8).

**Proof (R7-T20, static):** `ipcMain.handle` and `ipcMain.on` appear only in `rpc/transports/message-port.ts` and in files listed in `ALLOWED_IPC_FILES` inside the test. The list starts empty apart from that transport.

**Window-chrome §7 grep, corrected (F17):**

```
rg -n "TITLEBAR_|workspace-topbar-height|titlebar-start-inset|WebkitAppRegion|windowChromeMetrics|onFullScreenChange|window:is-full-screen|window:full-screen-changed|useWindowFullScreen|MACOS_TRAFFIC_LIGHT_POSITION" apps/desktop/src
```

It must return nothing, and `src/shared/window-chrome.ts` must be gone (00-window-chrome §12). The bare `isFullScreen` is dropped from the pattern because `BaseWindow.isFullScreen()` is Electron API.

### 5.4 Compat-only code that stays (and why)

| Kept | Where | Why |
|---|---|---|
| The compat stream: agent `HostSink` compat half, `toNdjsonWire`, `agui/channel.ts` (`preflightCompat`, `openFdWriter`, `inlineWriter`, `noCompat`, `INLINE_COMPAT_PREFIX`, `classifyStdoutLine`) | `packages/agent/src/agui/{sink,channel}.ts` | Main's taps read legacy `DesktopEvent` lines on fd 3 (PLAN amendment :366; agent spec :1001). |
| `DesktopEvent`, `AgentEvent`, `DesktopCommand` | `packages/agent/src/protocol.ts:119,417,523` | The compat writer and every tap type against them, and stdin still accepts the legacy commands (agent spec §2.2). |
| `shared/agent-types.ts` + `protocol-mirror.test.ts` | `src/shared/` | Main's mirror of the above. |
| `handleCompatFd`, the inline branch of `handleAguiStdout`, `handleNdjsonLine`, `answerHostService` | `cli-manager-service.ts:739-755,1017-1180,1338` | The compat reader and host services (these stay on compat, PLAN amendment :368). |
| The `emitNdjson` tap fan-out, minus the old-renderer emission | `service-host.ts:1260-1361` | `recordAgentSession`, turn state and watchdog, artifacts, messaging relay, routine settle, turn waiter, browser auto-allow, state patch, skills. |
| The 24 `.ndjson` baselines | `packages/agent/src/agui/__fixtures__/*.ndjson` | Frozen oracles for compat byte-identity (§8.2). |
| The agent's `queue.update`/`remove` producing the legacy `update_queue_item`/`remove_from_queue` compat lines | 02:1088 | The turn-state tap reads them. |
| `legacy-prefs.ts` (`mapLegacyKey`, `composeLegacyPrefs`, the zustand-format parser) | `src/main/services/config/legacy-prefs.ts` | Step 2 runs for any user upgrading from a pre-rewrite build, and step 3 in N+1. Migration steps are permanent. |
| `readRendererStateFile` | `renderer-state.ts:26` | Read by steps 2 and 3 and by the progress window's theme (`startup.ts` `progressWindowDark`). |
| `shared/transcript/v1-to-ui-messages.ts`, `thread-file.ts` | `src/shared/transcript/` | Steps 1 and 4 and the migrated-history renderers (02 §8, R2-T11/T13). |
| `v1`-derived thread files' debug-sync and feedback path | 03:1118 | Migrated threads keep today's path. |

### 5.5 The legacy prefs sync and `renderer-state.json`

| Release | `renderer-state.json` | `prefs.json` |
|---|---|---|
| Transition (today) | Written by the old renderer, read-only for new code (01:1137). | Live legacy sync plus provenance (`installLegacyPrefsSync`, `index.ts:1737`). |
| N (C11) | Nobody in N writes it. The IPC is gone (C8), and the file is what the last legacy build left, which is what a downgraded build reads (§12.3). Step 2 reads it for a user upgrading from a pre-rewrite build. The **read-only startup import** reads it on every launch (review #8). | Authoritative. The startup import merges `legacy` leaves only, and never overrides `user`. |
| N+1 (C15) | Step 3 runs the final whole-file import, drops the mapped keys and writes `renderer-state.retired.json`. Both files are backed up. The startup import is deleted in N+1, but N's copy honours the retirement record if the user goes back to N (review r2 #3). | Authoritative. |

The `renderer-state:*` IPC, `durableState` and the `onSet` listener (`renderer-state.ts:90-176`) go in C8 and C11. `RendererStateStore` shrinks to the file reader that step 2, step 3, the startup import and `progressWindowDark` use.

### 5.6 Dependencies (C12)

Importer counts at r1 (`24b02486`). The old tree and `package.json` are unchanged at `c46e77d9`, and renderer-next's imports are unchanged. They count files whose `import`, `import()`, `require()` or CSS `@import` names the package, under `src/renderer` ("old"), `src/renderer-next` ("next"), and `src/{main,shared,preload}` plus `scripts/` and the Vite configs ("other").

| Package (desktop `package.json`) | Old | Next | Other | Disposition |
|---|---|---|---|---|
| `zustand` | 13 | 0 | 0 | Remove (PLAN Nuked). `legacy-prefs.ts` parses zustand's *format* and does not import the package. |
| `framer-motion` (direct `^12.29.0`) | 4 | 0 | 0 | Remove. `motion@13.4.6` brings `framer-motion@13.4.6` transitively, so `pnpm-workspace.yaml:69` stays (F14). |
| `react-tourlight` | 4 | 0 | 0 | Remove, plus `patches/react-tourlight@0.3.0.patch` and `pnpm-workspace.yaml:75`. |
| `@tsparticles/engine`, `@tsparticles/react`, `@tsparticles/slim` | 0 | 0 | 0 | Remove (dead today), plus `allowBuilds."@tsparticles/engine"` (`pnpm-workspace.yaml:36`). |
| `uuid` | 0 | 0 | 0 | Remove (dead today; 03 uses `crypto.randomUUID()`). |
| `@dicebear/core`, `@dicebear/styles` | 1 | 0 | 0 | Remove (P71, `BotAvatar`). |
| `@monaco-editor/react`, `monaco-editor` | 1 each | 0 | 0 | Remove (S78, `@tanstack/highlight`). |
| `katex` | 2 (plus the two CSS `@import`s in `assets/{base,main}.css`) | 0 | 0 | Remove (`temml`, 02 §7.3). |
| `@lobehub/icons-static-svg` | 1 | 0 | 0 | Remove (`ConnectorMark`, 03 §14). The licence file follows C12's rule. |
| `sonner` | 18 | 0 | 0 | Remove (registry `toast`, 01 F6). |
| `clsx`, `tailwind-merge` | 1 each | 0 | 0 | Remove (the registry's `cn`, 01:98). |
| `@tanstack/highlight`, `@tanstack/markdown` | 1 each | 0 | 0 | Keep. Phase 2 imports them (02 §7). C12 re-counts and removes any with zero importers. |
| `@tanstack/react-form` | 1 | 0 | 0 | Keep (phase 3 forms, 03:183-192); re-count. |
| `ghostty-web`, `@pierre/trees`, `diff` | 2 / 1 / 1 | 0 | 0 | Keep (phase 4: terminal, file tree, diffs); re-count. `ghostty-web`'s patch stays. |
| `@huggingface/transformers` | 1 | 0 | 0 | Keep (06 `lib/voice/`, R6-T27); re-count. |
| `@fontsource-variable/jetbrains-mono` | 1 | 0 | 0 | Keep if the code font is used by 02/04, else remove; re-count. |
| `@abacus-ai/connectors` | 1 | 0 | 8 | Keep (main). The renderer import depends on R5-T33 (browser-safe registry). |
| `@testing-library/dom` | 0 | 0 | 0 | Keep (a peer of `@testing-library/react`); add to knip `ignoreDependencies` with that reason. |
| `@aceternity` registry | — | — | — | Nothing left: no importer and no `components.json` registry entry. |

**Proof (R7-T22, r2, review #17).** r1's regular expression missed scoped names (`@tsparticles/engine`) and side-effect imports (`import "sonner"`). It is replaced by `scripts/cutover/check-removed-deps.mjs`:

1. It walks `apps/**` and `packages/**` (not `node_modules`, not `docs`).
2. It extracts every module specifier with **`oxc-parser`** (F24; `import … from`, `import "x"`, `import()` with a string literal, `export … from`, `require()` through a `Visitor`, and `import type`) and every CSS `@import`/`@plugin`/`@source` string. `oxc-parser` becomes a root devDependency pinned at the installed 0.150.0. If it is ever removed, `rolldown/parseAst` (the ESTree parser the build already ships) is the stated fallback. `ts.preProcessFile` is not used: TypeScript 7.0.2 does not export it.
3. It reduces each specifier to its package name: `@scope/name` for scoped, the first segment otherwise; relative and `#` specifiers are skipped.
4. It fails on any removed name (the table above, scoped names spelled out).
5. It also fails when a removed name is a key of `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies` in any workspace `package.json`, or appears in `pnpm-workspace.yaml` `patchedDependencies`/`allowBuilds`. The one listed exception is `minimumReleaseAgeExclude`'s `framer-motion@13.4.6` (F14).

Its test feeds every import form with each scoped and unscoped name, and must detect all of them. `knip` (dependencies, unlisted) must also be clean.

The oxlint ban list keeps every removed name so they cannot come back (C7 renames it).

### 5.7 Transcript v1 path, step 4 and the rule removal

These are split across releases (D2); §9 has the full plan.

| Piece | Release N | Release N+1 |
|---|---|---|
| `TranscriptService.write` + `ThreadStore.writeFromV1` (dual-write) | Deleted (C11). There is no v1 writer after C8. | — |
| `readCurrentFile` repair | Kept | Deleted (C15) |
| The "no v1 means cleared" rule | Per thread: served only with `.archive-index.json` evidence (C1) | The same; `v1Archived` deleted (C15) |
| `TranscriptService.remove` removing v1 (dual-remove) | Kept | Deleted (C15) |
| Clear markers (`threads/<id>.cleared`, tokens, `savedAfterClear`) | Kept (HEAD) | Kept; step 4 retires a marker only when proven (C1) |
| Bounded streaming fallback reader (clear rules first) | Shipped (P6) | Kept (C15) |
| `threads/.archive-index.json` | Read by N (HEAD, C1) | Written by step 4, merged per commit (C15) |
| Attempt manifests, completion records, `restore-index.jsonl` | Runner (C1) | Written for steps 3 and 4 (C15) |
| `renderer-state.retired.json` | Read by N's importer (C11) | Written by step 3 (C15) |
| Startup prefs import (read-only) | Kept (C11) | Deleted with step 3 registered (C15) |
| Step 3 | Code and tests only (C1) | Registered (C15) |
| Step 4 | Code and tests only (HEAD + C1) | Registered (C15) |

### 5.8 Development-only code that must not ship

| Code | Guard today | At cut-over |
|---|---|---|
| Mutation harness (`src/main/dev/mutation-harness.ts`) | Inert unless `!isPackaged && ABACUSBOT_DEV_HARNESS=1` (`:161-178`), but bundled into `dist/main` | Compiled out of release builds (C4). `check-release-build` asserts it is absent. |
| Dev hooks (`window.__abacusDev`, `lib/dev/dev-hooks.ts`) | Dynamic import only when `VITE_UI_GALLERY === "1"` (`main.tsx:170-177`) | Absent from release `dist/renderer` (C4). |
| Fixture DB (`data/fixture-db/`) | `VITE_NEXT_DB_FIXTURES=1` (`main.tsx:114-117`) | Absent from release `dist/renderer`. |
| `/__ui` gallery route | `notFound()` unless `DEV \|\| VITE_UI_GALLERY` (`features/gallery/search.ts:106`). The route chunk ships. | Stays gated. C4 also asserts that the gallery's fixture and scenario modules are not in the release chunk graph; only the gated route stub remains. |
| Devtools (`lib/devtools.tsx`) | `import.meta.env.DEV && MODE !== "test"` (`routes/__root.tsx:11-15`) | Asserted absent by string (01:1119). |
| Single-transition guard, dev error details, the `overlay-unavailable` badge | `DEV \|\| VITE_UI_GALLERY` | Stay dev-only. |
| Env overrides `ABACUSBOT_RENDERER_GENERATION`, `ABACUSBOT_DEV_CONTENT_SIZE`, `ABACUSBOT_NOTCH_METRICS`, `ABACUS_TEST_HANDSHAKE_DELAY_MS`, `--rerun-migration` | Honoured only when unpackaged | `ABACUSBOT_RENDERER_GENERATION` is deleted (C9); the rest stay unpackaged-only (R7-T31 checks each). |

### 5.9 Scripts and configuration touched

`vite.config.ts`, `vite.shared.ts`, `vitest.config.ts`, `tsconfig.json` references, `tsconfig.renderer*.json`, `knip.json`, `oxlint.config.ts`, `components.json`, root and desktop `package.json` scripts (`dev:next*`, `check:legacy-diff`, `check:knip-next`, `screenshots:next`), `scripts/{screenshots-next,shadcn-next,shadcn-next-init,sync-locales,check-jsx-i18n,build-experience,before-pack}.*`, `apps/updater/src/classify.ts` and its test, `.github/workflows/ci.yml` (the check job, the NDJSON step, the smoke markers, size-limit), `pnpm-workspace.yaml`, `patches/`, `electron-builder.yml` (§10).

## 6. FOUNDATION_API bump and updater coordination

### 6.1 What an experience bundle is

- **Delivery.** The app has two release units (`apps/updater/README.md`; `classify.ts`):
  - the **foundation**: the signed installer, updated by electron-updater from `downloads.abacus.ai/abacusai-bot/latest`;
  - the **experience**: a TUF-signed zip, `experience/latest.zip` (`experience-updater.ts:23-29`), holding `renderer/` (= `dist/renderer`, today both HTML entries) and `agent/` (= `packages/agent/dist` without maps, declarations or stamps; `scripts/build-experience.js:44-59`), plus `manifest.json`.
- **Manifest.** `{ agentVersion, experienceVersion, files{sha256,size}, foundation, foundationApi, protocol, rendererVersion }` (`apps/updater/src/manifest.ts:73-108`).
  - `foundation` is the exact `package.json` version the bundle was built for.
  - `experienceVersion` hashes the file table together with `foundation`, `foundationApi` and `protocol`.
- **Verification** (`integrity.ts`). After TUF verification, the verifier recomputes every digest and refuses a bundle when any of these holds:
  - `foundation !== app.getVersion()` (`:51-55`);
  - `foundationApi !== FOUNDATION_API` (`:57-59`);
  - `protocol !== EXPERIENCE_PROTOCOL` (`:61-63`);
  - `agent/main.js` or `renderer/index.html` is missing (`:196-200`).

  The candidate's agent must then pass the health check (`health-check.ts`) before it is installed.
- **Swap.** `RendererSwapScheduler` (`renderer-host.ts:133-209`) swaps the live renderer to the new bundle at the first quiet moment:
  - "quiet" means no agent turn, no live terminal and no input for 15 s (`index.ts:410-426`);
  - the candidate must pass the barrier;
  - a candidate that never becomes ready is retried at most 3 times per bundle URL.

### 6.2 What the bump to 2 changes

1. **Admission.** A foundation at API 2 refuses every manifest with `foundationApi: 1`, and the reverse holds too. The exact-version check already enforces this between releases (F3).
   - The manifest's number alone cannot catch a stale tree, because `buildManifest` stamps whatever tree it is given (review #14).
   - The guard is **build provenance** (C4): `renderer/build.json` and `agent/build.json` are written by the builds from the source constants. The builder refuses inconsistent inputs, and the verifier checks again at install.
   - A pre-C5 tree carries `foundationApi: 1` and `generation: "legacy"` in its own `build.json`, so the new builder refuses it.
2. **Barrier.** `index.ts:425` selects `subscriptions`. A swap flips only after the candidate's `window.ready({ barrier: "subscriptions" })` reports `ready`: transport, shell tables and visible thread live (spec 00 A.4.6, R1-T20). `failed` or a 10 s timeout raises `SwapNotReady`, and the retry budget applies. After C8 the `first-commit` path (`renderer-ready`, `READY_TIMEOUT_MS`) is deleted.
3. **Entry points.** From API 2 the verifier also requires `renderer/notch.html` (D3). A bundle without the notch entry would leave the notch window unable to reload on a swap (06:578, R6-T30).
4. **Contract.** `system.info.foundationApi` reports 2 (`rpc/procedures/system.ts:48`). The renderer does not branch on it, since there is one renderer.

### 6.3 Coordination steps

| Step | Where | Check |
|---|---|---|
| Both constants to 2 in one commit | `src/shared/experience.ts:11`, `apps/updater/src/manifest.ts:10` | `foundation-api.test.ts` (C2) plus `integrity.test.ts`, which builds with `@abacus-ai/updater/experience` and verifies with the desktop verifier, so a mismatch fails "accepts a built experience" |
| Classifier prefixes | `apps/updater/src/classify.ts:11-15` | `classify.test.ts`: `index.html`, `notch.html` and the renderer tree are `experience`; `src/shared/`, `src/preload/` and `package.json` are `foundation` |
| Required entries | `integrity.ts:196-200` | R7-T2: a tree without `renderer/notch.html` is refused at API 2 |
| Build provenance | `vite build` and the agent build write `build.json`; `buildManifest` and `integrity.ts` check it (C4) | R7-T2: an old tree packaged by the new builder is refused by the builder, and the same tree hand-signed is refused by the verifier; mismatched renderer and agent commits are refused |
| The build refuses a gallery or fixture renderer | `scripts/build-experience.js` runs `check-release-build` (C4) | R7-T31 |
| Release pipeline (private repo) | Builds the foundation and its first experience from the same pinned commit ≥ C14. It publishes `experience/latest.zip` for N only once N's installers are live at any rollout percentage. | Checklist item in §17 |
| The health check matches the spawn | `health-check.ts` agui mode (C2, C10) | R7-T8 |

### 6.4 Publishing during the staged rollout

There is one experience target for every foundation (`experience/latest.zip`). A client on N−1 therefore downloads an experience built for N, refuses it (foundation mismatch), and keeps its installed one. The reverse also holds: an experience published for N−1 would stall N's clients. So:

- From the RC cut, experiences are built and published for N only. Nothing more is published for N−1.
- Clients on N−1 keep their active experience and reach N through the staged foundation update.
- A renderer or agent fix for N during the rollout ships as an experience. It is the fastest lever (§12.2), because it swaps without a relaunch once the user is idle.
- A client still on N−1 retries the N target at every check and refuses it again, because `#target` is set only on success (`experience-updater.ts:186-190`). Each retry costs a TUF metadata refresh, plus extracting and hashing the cached archive (`:191-221`); there is no re-download, since `findCachedTarget` hits. R7-T3 measures that cost once. C2 also makes the updater remember a refused target hash for the rest of the process, so a foundation that ships it (the dormant release, if any, and every release after N) stops paying it.

## 7. The generation flip and the deferred wco items

### 7.1 What flips at C5 for a packaged user

All of these are already implemented behind `RENDERER_GENERATION === "wco"`, and the release notes cover them (§12.1).

- **Entry.** `rendererEntry` loads `index-next.html` (`renderer-entry.ts:26-48`), which is `index.html` after C6. Experience swaps target the same entry (`experienceEntryUrl`, `:51-57`).
- **Chrome.** Window Controls Overlay on macOS, Windows and allow-listed Linux DEs, with the Linux native-frame fallback and startup probe (`index.ts:588-598,856-915`). The stored theme is applied before the window exists (`startup-theme.ts`). Density is honoured, and a density change recreates the window on macOS (`index.ts:1886-1891`).
- **Chrome state events.** `window:chrome-changed` (legacy) is no longer the path; `window.events` is.
- **Notch and capsule.** The controller exists only in wco (06:648). macOS gets the notch window and Windows the capsule, with their global shortcut and settings rows.
- **OS notifications.** Always `silent: true`, because sound is owned by `lib/sound.ts` (05 §31.5 d; 06 NT2). "Task still running" is suppressed while a notch window is ready (06 NT3).
- **Wire.** Every agent is spawned `--wire agui` (§8).
- **Keep-awake.** Follows turn state in main (P4).

### 7.2 The two low items due before `RENDERER_GENERATION = "wco"`

| Item | State at `c46e77d9` | Fix (C2) | Test |
|---|---|---|---|
| (A) The probe reschedules every 250 ms while the window is hidden or minimized | Full screen and minimized already wait on `leave-full-screen`/`restore` (`index.ts:869-876`). A hidden window, e.g. `startHiddenAfterUpdate`, still loops on `setTimeout(probeAfterShow, 250)` (`:897-904`). | `!isVisible()` → `mainWindow.once("show", probeAfterShow)`. The timer is only for a `retry-later` from a visible, restored, windowed state. | R7-T28: fake timers plus a fake window. No timer is armed while hidden, and the probe runs once on `show`. |
| (B) `window:recreate` is exposed in legacy mode | `ipcMain.handle("window:recreate")` is unconditional (`index.ts:1881`); preload member `recreateMainWindow` (`preload/index.ts:110-111`) | Registered only in wco (C2). Deleted with the preload member in C8, where recreate stays main-only (`recreate-main-window.ts`). | R7-T28 (C2); R7-T20 (C8) |

The review also deferred the Electron integration test, the §7 deletions, popup no-drag and the browser-view zoom and translation fixes to "the renderer switch" (`00-window-chrome.impl-claude-r1.md:11`). The integration test is implemented in C2 (R7-T29). The deletions are C9, with the corrected grep of §5.3. Popup no-drag and the browser-view fixes were phase 1 and phase 4 deliverables, and are re-verified in R7-T29 and R4-T30.

## 8. The wire flip

### 8.1 What changes

- **C5.** For every spawn, `wireFor` returns `agui`. `cli-manager-service.ts:600-624` passes `--wire agui --thread-id <sessionId> --compat-fd 3` with four stdio pipes.
  - Nothing can still be running `--wire ndjson`, since the flip arrives with a foundation update, which relaunches the app.
  - The relay's "speaks the legacy protocol" `UNAVAILABLE` paths become unreachable, and C10 deletes them.
- **C10.**
  - The agent: an absent `--wire` means agui, and `ndjson` is refused (D4).
  - Main: wire selection is deleted, and the spawn always passes the flags.
  - The health check spawns exactly like main, minus `--compat-fd`.
- **Unaffected.** The sandbox probe (`--sandbox-probe`, handled before `--wire` at `main.ts:73-78`) and the host-service round-trips on compat.

### 8.2 The byte-identity guarantee for the taps

Main's taps read compat, never AG-UI. The flip is therefore safe for them exactly when compat under `--wire agui` is byte-identical to what `--wire ndjson` wrote on stdout.

1. **Oracles.** 24 scenarios, each `<scenario>.ndjson` plus `<scenario>.agui.jsonl` in `packages/agent/src/agui/__fixtures__/` (48 files).
   - 14 were recorded on `d9cf445e`, the last commit before any agent `src` change, with the pre-change `NdjsonHost`: dequeue-idle, malformed-command, permission-accept, permission-reject-message, permission-two-calls, plain-text, queue-remove-clear, reset-conversation, steer-and-queue, stop-mid-stream, stop-then-message, todo-plan, tool-bash, turn-failed.
   - 10 were added in impl r1: null-line, stop-after-text, reset-mid-run, openllm-rotation, openllm-exhausted, stall-recovery, stall-twice, bot-housekeeping, bot-no-model, delegate-colliding-ids.
   - `RECORD_NDJSON_BASELINE=1` only writes a missing file and never overwrites one (agent spec :1094).
2. **In-process proof.** `agui-golden.integration.test.ts` drives `AguiHost` through every scenario and asserts that its compat bytes equal the `.ndjson` baseline (`:64`), and that the AG-UI stream parses and equals `.agui.jsonl`. It also asserts that rejected, duplicate and invalid AG-UI commands add no compat bytes (agent spec §7.2 item 5).
3. **Spawned proof.** The spec asks for three scenarios on three OSes (agent spec :1097). Today only `plain-text` is spawned (`agui-spawn.e2e.test.ts:122,161,196`). R7-T6 runs `plain-text`, `permission-accept` and `tool-bash` on macOS, Linux and Windows CI, in fd mode and in inline mode.
   - Before C10 it compares against a live `--wire ndjson` process.
   - After C10 it compares against the `.ndjson` baseline, with the masks the spec names (pi session id, `ts`, `Date.now()`-derived subtask ids, the fd-mode `compat.hello` preamble).
4. **What byte identity covers** (review #11). The goldens compare what the agent **writes**. The taps read what main **decodes**. On `c46e77d9` each chunk is decoded on its own, and fd 3 lacks the final-line drain, so a UTF-8 character split across chunks or an unterminated last compat line could still differ at the tap. Prerequisite P5 fixes the decoding. R7-T7 then drives the taps **through `AgentManagerService`** with fragmented multibyte text, an over-long line and an unterminated tail on both pipes, so the guarantee holds at the tap's input, not only at the producer.
5. **The one documented divergence.** Under agui, Stop and reset hold admission (`reserveDuringAbort`, agent spec :455): a message that races an idle Stop or reset is queued and runs after it. Under ndjson it was sent into the session being aborted. No golden covers that race, and the turn-state tap sees the queued turn start after the Stop's `turn_complete`, which is the intended outcome. The release notes do not mention it.
6. **After C10 the baselines are frozen.** Nothing can record a new independent oracle once `NdjsonHost` is gone. A new compat scenario is recorded from `AguiHost` with `RECORD_COMPAT_BASELINE=1`, marked `derived: true` in `__fixtures__/index.json`, and reviewed by diff against the nearest independent scenario. R7-T6 refuses to count a derived baseline as an oracle in its report.

### 8.3 The taps and their tests under agui

| Tap | Reads | Test that must run with every spawn agui (R7-T7) |
|---|---|---|
| Session record (`recordAgentSession`), turn state, post-Stop suppression | compat | `session-turn-state` suites plus a spawned stop-mid-stream |
| Artifacts (`recordFromNdjson`) | compat | artifacts service tests plus a spawned `tool-bash` writing a file |
| Messaging relay reply extraction (`handleAgentEvent`, `<reply>`) | compat | messaging gateway tests plus the `bot-housekeeping` scenario spawned |
| Routine settle (`settleRoutineRun`), turn waiter (`feedTurnWaiter`) | compat | routine run tests with a spawned agent; R5-T41 attempt ids |
| Browser auto-allow | compat → `sendCommandToRuntime` (agui path, `service-host.ts:1316-1328`) | auto-allow test bound to the emitting runtime |
| State patch, skills/MCP | compat | existing suites |
| Host services (`host_service_request` → `answerHostService`) | compat | render_document and render_deck round-trips spawned |
| Inactivity watchdog → `aguiRelay.failActiveRun("inactivity_timeout")` → stop | compat and relay | `stall-twice` spawned; the relay's terminal is written once |
| `local-cli-ndjson` to the old renderer | — | Deleted (C8) |

### 8.4 Version skew

- An agent bundle comes from the foundation's `extraResources` or from an experience for the **same** foundation version, so main and agent change together release by release.
- D4 keeps them compatible across experience updates inside one foundation: main always passes `--wire agui`, and the agent accepts it indefinitely.
- An agent that no longer speaks agui cannot become active, because the health check (agui mode) refuses it (R7-T8).

## 9. Migration at the cut-over

### 9.1 Steps by release

| Id | Name | Registered | Mutates what an older build reads? |
|---|---|---|---|
| 1 | `transcripts-v2` | Transition (today) | No: it writes `threads/` |
| 2 | `prefs-from-renderer-state` | Transition (today) | No: it writes `prefs.json` |
| 5 | `routine-attempt-ids` | Phase 5 (05 §31.5 f, R5-T41) | Additive fields in `cronjobs.json`. The old build must tolerate them (R7-T13 proves it). |
| 3 | `final-legacy-prefs-import-and-drop` | **N+1** (C15) | **Yes**: it drops keys from `renderer-state.json` |
| 4 | `archive-transcripts-v1` | **N+1** (C15) | **Yes**: it moves `transcripts/*.json` into the backup |

Ids are never reused or renumbered (`steps/index.ts:2-3`). The runner orders by id, so a user jumping from a pre-rewrite build straight to N+1 runs 1, 2, 3, 4, 5 in one launch.
- Step 4's "convert first" sees step 1's fresh twins, so everything is archived in the same run.
- Step 4 is `pending` only when it had to convert a v1 file first because no qualifying twin exists, for example a v1 file that N−1 wrote after a downgrade, newer than its twin. Files step 1 skipped are quarantined, not converted. With C1's `break` rule, the runner then commits and stops, and the next launch finishes (at most two launches; `MAX_STALLED_PARTIALS = 2`, `runner.ts:173`).

### 9.2 First launch of N

- The runner runs inside `whenReady`, before the services read their files (`index.ts:1712`). The progress window opens only if the run is still going after 400 ms (`progress-window.ts:22,61-70`), and its theme follows the old UI's stored `theme` (`startup.ts:47-58` `progressWindowDark`).
- For a user who shipped through the dormant release (§2 item 4), steps 1, 2 and 5 are already applied and N runs none of them.
- For a user coming from a pre-rewrite build, N runs 1, 2 and 5. Step 1's cost is the only large one: it scales with transcript bytes. R7-T32 bounds it.
- An unresolved attempt does not block launch (`startup.ts:84-92`, `write-block.ts`). `ThreadStore` and `TranscriptService` honour the write block on HEAD. Durability of a held change is P2.
- After the runner, the read-only startup prefs import runs (C11, review #8).

### 9.3 The cleared-history rule, per thread (r3)

A v1-derived twin whose v1 file is missing is either archived history or cleared history. Step 4 archives thread by thread and can commit **partially**. A global switch (r1's "step 4 applied", or HEAD's `v1Archived`) is therefore wrong in between, and also after a failed plan or an unresolved recovery (reviews r1 #1, r2 #2).

The rule is decided **per thread**, from HEAD's `threads/.archive-index.json`, in **N and N+1 alike**. It applies to v1-derived twins. An `agui` twin is served as it is, unless a clear marker hides it.

| On disk for thread *id* | N and N+1 |
|---|---|
| v1 present, not cleared (marker rules) | the twin by fingerprint, or the repair (N only) or fallback conversion (P6) |
| v1 present, held by a clear marker (token, `v1Fingerprint`, `savedAfterClear`) | cleared; P6 applies the same test before any fallback conversion |
| v1 missing; the index lists *id* with the twin's fingerprint (with `updatedAt` for a pre-fingerprint twin) | the twin, as is |
| v1 missing; not listed, or listed with another fingerprint, or the index unreadable | cleared (logged) |
| v1 missing; a marker whose token the twin lacks | cleared |

- The index is a planned write of the same commit as the removals (`004-archive-transcripts-v1.ts:227-228`), and C1 makes it a merge. A rollback of a commit restores the previous index together with the moved-back files.
- A later run never takes a listed twin for an orphan (HEAD, C1 fix log r2 #1).
- The marker protocol is HEAD's, and fail-closed. Step 4 retires a marker only under C1's proof. A failed AG-UI deletion keeps both the marker and the cleared state.

R7-T14:
- after **every** partial commit and kill point, N serves each archived thread and hides each cleared one;
- two successive commits, each with archived and newly converted threads, leave every archived twin in place;
- N+1 gives the same results with a failed step-4 plan, an unresolved recovery, and a temporarily unreadable orphan twin (none served without evidence);
- a thread cleared before step 4 stays cleared, whether it had an orphan twin or a marker with a leftover AG-UI twin;
- an `agui` twin whose `migratedFrom.updatedAt` is older than its v1 file keeps that v1 file (step 4 "Keep");
- clearing a retained oversized source whose deletion fails, then restarting, shows nothing, in N and N+1 (P6, review r2 #9).

### 9.4 Backups, attempt records, the restore index and retention

- Step 3 backs up `renderer-state.json` and `prefs.json` (`replace-user`, hash-checked). Because `userData` is `<home>/electron`, `backupPathFor` files them under `home/electron/…` (F22). It also writes `renderer-state.retired.json` (C1).
- Each step-4 commit moves its v1 files, and the twins and markers it retires, into **its own** backup directory. It replaces `threads/.archive-index.json` by merge, and backs the old one up. Quarantine copies go to `backups/quarantine/transcripts/` (90 days).
- **Every committed attempt keeps `attempt.json` and `completed.json` in its backup directory** (C1). They list each op (`remove`, `replace`, `create`) with root, source, backup path and digests. They are the durable evidence, and they survive the deletion of the journal, the log and staging (review r2 #5).
- `backups/migrations/restore-index.jsonl` is **derived** from those records, and rebuilt whenever it is missing or inconsistent. It is the only input restore needs (§12.4).
- Pruning keeps every attempt directory with a completion record for 30 days after its step is **applied**. Other backups follow the existing rule: the newest 3 per step, 30 days (`backup.ts:252-323`).

## 10. Notch and capsule packaging

Spec 06 r4 adds no packages and no native module: `node-mac-notch` does not exist (06 F1). The notch is built from:

- **Metrics:** a one-shot JXA probe. When it fails, or no screen matches, an internal display gets **no** companion; there is no inference (06:651-655).
- **Haptics:** a **one-shot** `osascript` per attention, deduplicated by key through `notch.haptic`. They ship off by default when R6-T31's median latency exceeds 150 ms (06 §10.7, :724-730).
- **Windows:** Electron `BaseWindow`s, `type: "panel"` on macOS and `type: "toolbar"` on Windows, with an active and a standby view across renderer swaps (06 §10.6).

r1's "long-lived stdin haptics process" and "aspect-ratio fallback" are withdrawn (review #22).

| Concern | Finding | Action |
|---|---|---|
| Vite output | `notch.html` is a third input at the root of `dist/renderer` (06:736). `electron-builder.yml` `files: dist/**` carries it (`:8-13`). The experience carries it because `renderer/` is `dist/renderer`. | R7-T18 asserts that the asar and the experience tree both contain `renderer/index.html` and `renderer/notch.html` (§6.2 item 3). |
| CSP | `notch.html` copies the `<meta>` verbatim (06:735). `rendererCspHeaders` covers every `app://` main frame (`renderer-csp.ts:18-35`), the notch included. | R7-T18 compares the three `<meta>` strings with `RENDERER_CSP` (C12 may narrow `'unsafe-eval'` everywhere at once). |
| macOS entitlements | `build/entitlements.mac.plist` already has: JIT, unsigned executable memory, library-validation off, audio input, network client, user-selected files, virtualization. A `panel` window needs no entitlement. `osascript` runs as its own Apple-signed process, outside the app's entitlements. The JXA scripts use the ObjC bridge on `NSScreen` and `NSHapticFeedbackManager` in that process and send no Apple Events to other apps. | No entitlement change. R7-T17 verifies on the **signed, notarized** RC that the probe returns metrics and that no TCC or Automation prompt appears. If one does, `NSAppleEventsUsageDescription` is added and the finding recorded. A probe that fails on the signed build disables the companion on that display (06 r4); it never guesses. |
| `Info.plist` | `NSMicrophoneUsageDescription` covers notch dictation too (06 NT6). It is listed twice in `extendInfo` (`electron-builder.yml:145-146`). | Remove the duplicate (C14). |
| Windows manifest | electron-builder's defaults (no `requestedExecutionLevel` override in `win:`); the capsule is `alwaysOnTop` at `"pop-up-menu"` level and click-through, which needs no `uiAccess` | No custom manifest. R6-T33 on hardware, extended in R7-T17 to 100 %, 125 %, 150 % and 200 % display scaling and a taskbar on each edge: the capsule sits by the clock and never shows in Alt+Tab. |
| Linux | No notch or capsule (06:82, :649) | R7-T16 asserts that no notch window is created on Linux. |
| Global shortcut | `CommandOrControl+Shift+Space`, registered only while enabled (06:644) | R7-T16 asserts it is unregistered at quit (no leaked registration across relaunch). |
| Quit and update restart | The notch/capsule is destroyed on quit and on main close on win32, and a running haptic `osascript` is killed (R6-T25; 06 §10.6) | R7-T16 plus an update-restart case in R7-T33 (the capsule must not hold the NSIS installer's file lock). |

## 11. Parity sign-off checklist

**Rule.**
- Every row of every parity table has a status in its `features/<area>/parity.ts` (`PARITY.md` for the bridge):
  - **green**, with evidence (a test id, or a manual check recorded on the packaged RC);
  - **retired**, with its reason; user-visible retirements go into the release notes (§12.1);
  - **deferred**, naming an owner and the PLAN later-slice it belongs to; user-visible deferrals go into the release notes as "not in this version".
- No row is `todo`.
- **The row set is exact** (review #25).
  - `scripts/cutover/parity-ids.json` lists every id each spec's table defines: P1–P73, S1–S111, RT1–RT26, AR1–AR15, LB1–LB21, ST1–ST27, OB1–OB17, FB1–FB7, TR1–TR9 and NT1–NT7.
  - For `PARITY.md`, the set is every `window.api` member enumerated from `preload/bridge.ts` and `preload/index.ts` (249), every `IpcEvent` type (46) and the 5 other push channels. It is computed before C8 deletes the bridge.
  - A missing id, an extra id or a duplicate fails R7-T25.
- **Consumers resolve** (review r2 #12). Every `consumer: "file#symbol"` must name an existing file that exports or declares that symbol, checked by parsing that file with `oxc-parser` (its export and declaration records).
  - Through C6, the file must be under **`src/renderer-next/`**, or `src/main/` for main-only rows. A consumer under the legacy `src/renderer/` fails.
  - C7 rewrites every consumer to `src/renderer/`, and from then on only that tree (plus `src/main/`) resolves.
  - A `retired: <reason>` needs a reason of at least one sentence.
- Each row whose kind is "Parity" is demonstrated once in the **packaged** RC, not in dev, with the check id linked in the C5 PR.
- R7-T25 enforces the static part.

| Area (spec) | Ids | Retired (must be in notes if visible) | Deferred rows that must be green by now | Evidence the gate needs |
|---|---|---|---|---|
| Transport / bridge (00) | `PARITY.md` rows: 249 `window.api` members (62 Q, 137 M, 6 S, 25 T, 19 R), 46 `IpcEvent` types, 5 other push channels | The 19 R rows (`PARITY.md:41,44,45,112-115,122,124,132,133,178,195,218,219,229,245-247`) | The `notch.*`, `sessions.events` and `ai.runFinished` procedures present in the regenerated file | A-T6 generator green with the consumer column (D5); R7-T20 |
| Window chrome (00-wc) | §12 acceptance, 16 items | Legacy constants | — | R7-T29 on 3 OSes; the density and full-screen screenshots |
| Agent wire (00-agui) | 24 golden scenarios | — | — | R7-T6, R7-T7 |
| Foundation (01) | R1-T1…R1-T24 and R1-T11b; decisions A–D (PLAN:377-381) | Code-based router, `?view=` redirects, `staticData.titleKey/backTo` | — | The screenshot gate (1280/1100/1000/900/800 × light/dark, collapsed, floating, compact, full screen; axe serious/critical = 0); R1-T11b, T20, T22 in the packaged build |
| Chat kit (02) | Canvas coverage (`canvas-map.ts`, R2-T29); R2-T1…R2-T35 | Client-side `whenBusy: "queue"` (superseded, PLAN:370) | — | R2-T31 numbers on the reference Mac; R2-T32 real session with an approval round-trip |
| Bots (03) | P1–P73 | P8, P9, P26; the P2 workspace switch; the P13 count | P46 (phase 6), the P53 URL row (phase 4), P61 Revoke (phase 5) | R3-T30; R3-T31 on macOS (its legacy half is removed in C9) |
| Sessions (04) | S1–S111 | S5, S101; the S2 workspace switch; the S35 Compact toggle; the S41 terminal toggle; S48 retraction; S63 dismissal; S72 empty panel | S102 Take over / I'm done stays deferred (04 §27.3, owner: browser slice) | R4-T31; R4-T29 and R4-T30 in the packaged RC on macOS and Windows; R4-T34 |
| Routines (05) | RT1–RT26 | RT19; RT26 (`/settings/jobs`, `/routines/chat:<id>`) | — | R5-T38; R5-T36 on macOS and Windows; R5-T41 |
| Artifacts (05) | AR1–AR15 | AR6 Refresh | AR15 Remove (05 §32.3) | R5-T31 (2,000 artifacts) |
| Library (05) | LB1–LB21 | LB21 (`?view=` redirects) | — | R5-T36 |
| Settings (05) | ST1–ST27 | ST3; the ST18 composer strip and home banner | ST22 Replay tour (phase 6) | R5-T27 (updates, all states); R5-T36 |
| Onboarding (06) | OB1–OB17 | OB13 workspace switch, OB16 tour reset | — | R6-T36 fresh install recorded on macOS and Windows; R6-T5 (resume from legacy step ids) |
| First bot, tour (06) | FB1–FB7, TR1–TR9 | — | — | R6-T36 |
| Notifications, notch, sound (06) | NT1–NT7 | — | The features deferred at 06 §24.3 (calls, take-over, retry, extra-display capsule, Linux notch…) stay deferred | R6-T30 (CI), R6-T31, R6-T32, R6-T33 (hardware), R6-T40 |
| Migration (00 C, this spec) | C-T1…C-T9, R7-T10…R7-T15 | — | — | The upgrade and downgrade runs of §13 |

## 12. Release notes, rollout and rollback

### 12.1 Release notes (`CHANGELOG.md` `## Unreleased`, C14)

User-facing text, written in the file's voice (prose, no ticket numbers):

> **A new AbacusAI Bot.** The whole app is rebuilt. A rail on the left takes you to Bots, Sessions, Routines, Artifacts and the new Library, where connectors, messaging apps, MCP servers, skills and tools now live. Settings has its own pages, including Appearance, Notifications and Keyboard, and a search.
>
> The title bar is drawn by your system: traffic lights on a Mac, caption buttons and Snap layouts on Windows, and your desktop's own controls on Linux. You can choose a compact title bar. Light, dark and system themes apply before the window appears.
>
> On a Mac with a notch, a small companion lives around it. It shows when a bot is working, asks you to approve things, and lets you reply without opening the window. On Windows it is a capsule by the clock. You can turn either off in Settings › General.
>
> Sounds are the app's own: sent, received, needs you, done and failed, with per-bot levels and quiet hours. System notifications no longer play a sound of their own.
>
> Bots have new avatars. Your bots keep the look they had, drawn in the new style. Math in replies renders as the model writes it. The tour can be replayed from Settings.
>
> **What changed or went away.**
> - The built-in code editor is replaced by "Open in editor".
> - Sessions are grouped by folder instead of by date.
> - Update notices moved from the composer and the home page to a pill in the title bar.
> - Old `/settings/jobs` links open Routines.
>
> **The first launch** after updating may show "Updating your data" for a moment while your conversations are converted. Nothing is deleted: the previous version's files are left where they are.
>
> **Going back.** If you install the previous version again, it opens your bots, sessions, routines and settings as you left them before this update. Conversations and preference changes made in this version do not appear there.

The final list of changed and removed items is generated from the `retired` and `deferred` rows with `visible: true` in the parity files (R7-T25 prints it). The text above is the frame.

**Internal notes for the release PR:**
- the §7.1 flips;
- the FOUNDATION_API bump and the experience publishing rule (§6.4);
- the wire flip (§8);
- steps 1, 2 and 5 registered, 3 and 4 not (D2);
- the compat stream kept;
- the rollback levers below.

### 12.2 Rollout and triggers

- **RC.** The signed RC goes to the team for ≥ 3 days, on their own machines and, if they choose, on copies of their own homes (D7). R7-T17 and the §11 manual checks are done on it.
- **Stages** (`stagingPercentage` in `latest*.yml`, D9): 5 % for 48 h, then 25 % for 72 h, then 50 % for 72 h, then 100 %. Each step needs the release manager's go against the triggers.
- **Triggers:**
  - any report of lost data (history, bots, routines, settings);
  - a migration `lastFailure` or unresolved attempt in any synced log (the log sync the app already has, where the user enabled it);
  - a rise in renderer BootFailure or error-screen reports above the last release;
  - agent spawn failures with `compat_lost` (exit 75) or `wire_unsupported`;
  - a notch/capsule click-through failure.
- **Halting (r2, review #15).** Freezing the percentage does not halt, because a client that has not checked yet is still admitted when its persisted staging id falls below the threshold (F23). The rollout is halted by one of:
  1. **percentage 0** in every `latest*.yml`: no client is admitted;
  2. **withdrawal**: republishing N−1's feed files, so no client is offered N.

  Clients that already **downloaded** N answer `update-not-available` on their next checks. Shipped clients (≥ `v1.0.85`) drop the downloaded build on the second consecutive such answer, and install-on-quit comes off with it (`update-service.ts:153-175,227-236`). Checks run every 10 minutes (`:46`).
  - A client that quits within that window, or on macOS where Squirrel already staged the update ("best-effort", `:230-231`), may still install N.
  - Those users are the downgrade population of §12.3.

  - **In-progress downloads** (review r2 #16, F27). A shipped client (N−1 without the C2 change) that is mid-download when the halt lands skips its periodic checks until the transfer ends. It then resets its strikes and can auto-restart at the next idle 60 s poll, installing N with no re-check. The halt cannot stop it.
    - This is a documented limitation. The release manager treats every client that started a download before the halt as part of the downgrade population.
    - Clients that can still be changed (the dormant release on, C2) re-check the feed before any install, and cancel a transfer when a mid-download check sees the halt.

  R7-T33 covers:
  - a newly checking client at 0 %;
  - a withdrawn feed;
  - a downloaded client that drops the build after two checks;
  - a halt **during** a download, both for a shipped-behaviour client (it installs: the limitation, asserted) and for a changed client (cancelled, nothing installed).
- **Levers, fastest first:**
  1. **Halt** (above). electron-updater does not downgrade (`allowDowngrade` is not set), so users on N stay on N.
  2. **Experience hotfix** for N: TUF, no relaunch, swapped at idle behind the two-stage barrier (§6.2, D11).
  3. **Foundation N.1**, rolled out again from the current stage.
  4. **User-level downgrade** (§12.3), through support.
  5. **Hold N+1** until the trigger is closed.

### 12.3 What a user on N can do if it fails (downgrade to N−1)

1. Quit the app. Reinstall the previous version from `https://downloads.abacus.ai/abacusai-bot/releases/<N−1>/`:
   - macOS: replace the app;
   - Windows: run the previous `-setup.exe`, which installs over N;
   - Linux: the previous AppImage or `.deb`.
2. The previous build reads the same home. After N it finds:

| Data | What N−1 sees | Why |
|---|---|---|
| Bots, sessions and workspaces, routines and runs, memories, connectors, messaging, settings (`bots.json`, `local-code.json`, `cronjobs.json`, `routines/`, `memories/`, `config.json`, electron-store files) | As N left them | Shared stores. N's schema additions are additive and must be tolerated by N−1's readers; R7-T13 proves it. New bot looks fall back to the old renderer's `blob` shape (03:876-890). |
| Conversation history before the update (`transcripts/<id>.json`) | Intact | N never writes or removes a v1 file, except the dual-remove when the user clears or deletes a conversation, which the old build would also do (D2). |
| Conversations or turns started in N | Not shown in the old UI | They live in `threads/<id>.json` (v2), which N−1 does not read. The model context is intact, because pi's `agent/sessions/desktop/<id>.jsonl` is unchanged and shared. |
| Theme, language, pins, sidebar and other preferences | As they were before the update | `renderer-state.json` is untouched in N. Changes made in N live in `prefs.json`. |

3. **Updating to N again later** is safe:
   - the record already lists steps 1, 2 and 5, so none of them re-run;
   - `prefs.json` is authoritative. The read-only startup import (C11) merges any `renderer-state.json` change N−1 made into leaves still marked `legacy`, and never over a `user` choice;
   - v1 files that N−1 wrote after the downgrade are newer than their v1-derived twins, and `readCurrentFile`'s repair (kept in N) converts them on open.

   A thread N already owned (`agui` twin) keeps its AG-UI history: turns added to it under N−1 are not shown by N, but the model context has them. That is a known limitation (§18 R7).

   N−1's store writers may drop fields N added. N treats every such field as optional with a default (R7-T13, re-upgrade leg).

### 12.4 Rollback after N+1 (r3; reviews r1 #5/#6, r2 #4/#6/#7)

N+1 runs steps 3 and 4, which change what N−1 reads.

**Back to N needs no restore.** N reads `threads/` by per-thread index evidence (§9.3), reads kept sources through P6, and honours step 3's retirement record (C1, C11). This holds whether step 4 finished or stopped partway.

**Back to a legacy build (N−1) needs the legacy files restored,** and there is **one** supported way: the `--restore-legacy-files` command (review r2 #7). The support article (C14) gives the command and nothing else. It does not publish a manual file-moving procedure, because moving files by hand bypasses the digest checks, collision handling, step filtering and metadata updates below.

The command can also be run on its own: it runs in main before the runner and before any window, so it works even when the UI cannot start. A home where main cannot start at all is a support escalation. The backups stay intact for 30 days (§9.4).

1. Quit the app.
2. Run the installed N+1 (or newer) once with `--restore-legacy-files`. It prints a report and exits. For each profile home listed in `profiles.json` (the base home included):
   1. **Load the evidence.** Rebuild `restore-index.jsonl` from the attempt records if it is missing or inconsistent (§9.4). Load `backups/migrations/restorations.jsonl`, the restoration generations.
   2. **Select, per destination** (review r2 #6). Take every op of steps 3 and 4 whose attempt is **newer than the latest restoration generation** that already consumed that destination. For each destination, choose the op from the **latest** completed attempt:
      - a `remove` op restores the v1 file (or twin or marker) it moved;
      - a `replace` op on `renderer-state.json` restores its original (review r2 #4).

      `prefs.json` is **never** restored. It is N's authoritative file, and step 3's backup of it is kept but not applied.
   3. **Restore with digest checks.** The destination is `<recorded root>/<source>`: `root` is `home` or `userData`, resolved for **that** profile (`userData` = `<home>/electron`, F18, F22). The backup's sha256 must equal the op's `originalSha256`, or the op is skipped and reported.
      - Destination absent: the backup is moved back.
      - Destination equal to the backup: nothing to do.
      - Destination equal to the op's `resultSha256`, the file step 3 left: it is replaced, because it is unchanged since the migration.
      - Anything else: the restored file is written beside it as `<name>.restored-<stamp><ext>`, and the report lists it for support.
   4. **Update the metadata.**
      - Drop the restored threads from `threads/.archive-index.json`.
      - Delete `renderer-state.retired.json` if `renderer-state.json` was restored.
      - Append a generation `{ generation, at, consumed: [attempt ids], destinations: [...] }` to `restorations.jsonl`.
      - Mark steps 3 and 4 `restoredAt` in `migrations.json`. A later launch of N+1 or newer treats them as not applied and runs them again, as a new attempt with new backups.
3. Install N−1.

**Two cycles.** Restore, then legacy edits, then N+1 again, then restore again: the second restore picks the second cycle's backups for every destination the second migration touched, because the first generation already consumed the first cycle's. It never places a stale first-cycle file at the canonical path.

R7-T15 runs the command **verbatim** against a two-profile home that N+1 migrated through two partial commits and a final one, with one interrupted recovery. It also runs:
- a conflicting destination case;
- a damaged derived index;
- the complete two-cycle sequence.

N−1 then shows every conversation and the preferences in both profiles, and the conflicting file is preserved beside the restored one.

## 13. Upgrade tests: real layouts, synthetic data (r2)

### 13.1 Why the committed fixture is not enough

`__fixtures__/legacy-home/` is hand-made "as a shipped build leaves it" (`legacy-home.test.ts:1-9`). The cut-over needs the layout **shipped builds actually write**: file names, electron-store shapes, zustand `persist` envelopes in `renderer-state.json`, `window-state.json` and `profiles.json`. It must be produced without anyone's data.

### 13.2 Fixtures: immutable, versioned, one per purpose (reviews #20, #21)

| Fixture | Source build | State | Used by |
|---|---|---|---|
| `legacy-home-pre-rewrite-v<ver>` | The last pre-rewrite release (`v1.0.85` or later), from `downloads.abacus.ai/abacusai-bot/releases/<ver>/` or CI's unsigned `package:dir` of that tag | Onboarding stopped at `models`; the migration content of §13.3 | R7-T10, R7-T12, R7-T13, R7-T32 |
| `legacy-home-dormant-v<ver>` | The dormant release (§2 item 4), if one shipped | The same script, run on the dormant build, so `threads/`, `prefs.json` and `migrations.json` are real | R7-T11 |
| `legacy-home-dormant-then-pre-rewrite-v<ver>` | The dormant fixture, then the pre-rewrite build launched on it, changing theme and pins | Drift in `renderer-state.json` after step 2 | R7-T11b (review #8) |
| `perf-home-v<ver>` | The pre-rewrite release | **Onboarding completed** through the source build, so both builds open straight into the shell | R7-T24 (M1–M5) |

- Each fixture is committed under `apps/desktop/src/main/migrations/__fixtures__/<name>.tar.zst` with a `producer.json`: source version, the sha256 of the source binary, generator commit, OS, and a sha256 per file.
- Fixtures are **immutable**. A new release adds a new versioned fixture and never replaces an old one, so both source layouts stay available for as long as upgrades from them are supported.
- `electron/` Chromium state is excluded, apart from the two JSON files the app owns.
- The 30 MB transcript is regenerated from a seed at test time.

### 13.3 The generator (`scripts/cutover/make-legacy-home.mjs`)

1. **Launch** the source build with `ABACUSAI_BOT_BASE`/`ABACUSAI_BOT_HOME` at a fresh temp directory and `--remote-debugging-port`. The network goes through a proxy env pointing at a closed port.
2. **Migration content,** created through the source build's own `window.api` over CDP `Runtime.evaluate`:
   - 12 bots from templates with custom looks (3 pinned);
   - 3 workspaces (temp git repos, 2 worktrees);
   - 40 sessions (5 pinned, 3 with a missing workspace);
   - 2,000 transcripts through `agent.writeTranscript` (text, tool calls, a diff, one of 30 MB, and 3 over 64 MB for the fallback reader);
   - 6 routines with 120 runs;
   - 20 memories;
   - an auto-reply grant;
   - `durableState.set` for every key in `LEGACY_PREFS_KEYS`, with onboarding step `models`;
   - a 1280×800 `window-state.json`.

   After the app quits, the generator adds an unparseable file and one with a `version` the steps do not know. They are the only files the app does not write itself, because `writeTranscript` always writes version 1 (`transcript-service.ts`).
3. **Completed onboarding (perf fixture only).** The source build's gate is `!onboarded || !hasAbacusCredential` (06:51).
   - The generator calls `window.api.skipAccountOnboarding()` and saves a synthetic Abacus key through the source build's own key-save path, with the account endpoints answered by a local stub server that the source build is pointed at through its proxy settings.
   - `producer.json` records which calls and stubs were used.
   - If the source build cannot reach its shell this way, the perf fixture is not produced, and C5's gate names the blocker. The perf run never uses the onboarding fixture.
4. **Second profile.** A second profile directory is built from the `profiles.json` format (`profile-home.ts:12-19`), because a real profile switch needs a real sign-in.

### 13.4 What the runs assert (R7-T10…R7-T15)

- **Upgrade to N (pre-rewrite fixture).**
  - The packaged RC starts on a copy and prints every smoke marker.
  - `migrations.json` records steps 1, 2 and 5 with the expected stats: every good transcript converted; the unparseable one `corrupt` and the unknown-version one `notV1`; the three over 64 MB `tooLarge` and kept; nothing quarantined.
  - Over CDP, the UI shows:
    - onboarding resuming at `models` (the legacy step id, 06 R6-T5);
    - once onboarding is completed in-test: 12 bots (3 pinned, in order), 40 sessions grouped by workspace, 6 routines;
    - 5 sampled histories matching `v1-to-ui-messages`;
    - an over-64 MB thread shown **in N** through P6's streaming fallback (review r2 #8).
  - Every legacy file's sha256 is unchanged.
- **Dormant layouts.** No step re-runs, and prefs are right. With the drift fixture, the drift reaches `prefs.json` through the startup import, and `user` leaves win.
- **Downgrade.**
  - After N has run and created 2 bots and 3 conversations, N−1 starts on the same home and prints its smoke marker. Its `window.api` lists every bot and session.
  - Pre-update history is intact.
  - No store parse error appears in its log.
- **Re-upgrade.** No step re-runs; the conversations N created are intact; N tolerates fields N−1 dropped.
- **N+1.**
  - Steps 3 and 4 run over two partial commits and a final one, with a kill point in each.
  - After each commit, N reads the home correctly (§9.3).
  - The §12.4 command, run verbatim, brings back N−1's view in both profiles, including after two restore cycles.

## 14. Performance budgets

### 14.1 Method (`scripts/cutover/perf-compare.mjs`, C5)

- **Builds.** Both builds are packaged with the same flags:
  - **old** = the last shipped legacy build;
  - **new** = the RC.

  Each run uses a fresh copy of **`perf-home-v<ver>`** (onboarding completed, §13.2), already migrated for the new build, so migration is not timed here (R7-T32 times it on the migration fixture). The window is 1280×800 through the fixture's `window-state.json`, because the dev content-size override is ignored when packaged.
- **Runs.** 7 per build, alternating old and new, on a warm OS cache and a cold process. Report median and p90; the first pair is discarded.
- **Machines.**
  - Reference: macOS arm64 (the M-series class R2-T31 uses) and Windows 11 x64.
  - Linux x64 under Xvfb is reported, not gated.
- **Probes,** identical for both builds. A script injected with CDP `Page.addScriptToEvaluateOnNewDocument` records `performance.timeOrigin + performance.now()` when the probe condition is first met. Node records the spawn time.

| Metric | Definition | Budget (gate at C5, re-checked on the signed RC at C14) |
|---|---|---|
| M1 Cold start to interactive | Spawn → the first fixture bot's name is in the sidebar and the composer can take focus | New median ≤ old median × 1.10 |
| M2 First paint | Spawn → `first-contentful-paint` of the main window's document; no frame whose background differs from the resolved theme (the 01:829 screencast check) | New median ≤ old median × 1.10; zero wrong-theme frames |
| M3 Idle memory | 60 s after M1, the summed RSS of the app's process tree without agent children (`ps` by process group on macOS and Linux, `Win32_Process` parentage on Windows), broken down per process | Main window's tree ≤ old × 1.10. The notch/capsule renderer is reported separately, ≤ 150 MB RSS (to be confirmed by R6-T27's measurement). |
| M4 Renderer JS heap | CDP `HeapProfiler.collectGarbage`, then `Runtime.getHeapUsage` on the main window, at the M3 point | ≤ old × 1.10 |
| M5 Open a long thread | Click the fixture's 1,000-message session → its last message is visible | ≤ old × 1.10 and < 600 ms (R2-T31 (a)) |
| M6 Initial bundle | JS + CSS loaded before first paint by `index.html` (size-limit, gzip) | ≤ old's initial JS + CSS. The C12 size-limit is then set to the RC value + 5 %. |

### 14.2 Phase budgets that must still hold on the RC

- R2-T31 (a)–(e): transcript first paint, replay readiness, 3,000 tools, streaming p95, expansions.
- R5-T31: 2,000 artifacts, first paint < 400 ms, ≥ 50 fps.
- 04's terminal and device caps: a 2 MB tail, a 40 ms resize debounce, and the device decode-queue drop.

The new budgets do not replace them.

### 14.3 Migration on first launch (R7-T32)

- **Workload.** Steps 1, 2 and 5 on the pre-rewrite fixture: 2,000 transcripts, 200 MB total, one of them 30 MB, plus three over 64 MB that step 1 only `stat`s and keeps.
- **Budget.** ≤ 60 s wall time on the macOS reference, with the progress window visible after 400 ms.
- **Checks.** The main window appears after the runner finishes. The step writes happen off the progress window's frames, through the runner's yield every 20 moves and `YIELD_EVERY` in `transcript-files.ts`, so the window never shows "not responding".
- **Report.** The time for 50 MB, 200 MB and 1 GB homes, to decide whether the runner needs to become incremental before N ships. It is a risk, not a gate (§18 R4).

### 14.4 Bundle budgets (C12)

- `.size-limit.json` holds, gzip, the values measured on the RC + 5 %:
  - `index.html` initial JS and CSS;
  - `notch.html` initial JS and CSS;
  - the largest lazy route chunk;
  - `temml`'s chunk, which must stay lazy (02:747).
- CI fails a PR that exceeds them. Raising a limit needs a reason in the PR.

## 15. Tests

"Electron" means the Node-spawns-Electron harness (`renderer-next.electron.test.ts` style, isolated profile and CDP). "Packaged" means it runs against `release/*-unpacked` or the installed signed build, never dev. Every Electron and packaged test fails instead of skipping under `CI` or `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`, as R1-T11b already does.

| Id | File | Kind | Proves |
|---|---|---|---|
| R7-T1 | `src/main/renderer-generation.test.ts` (C5) → `renderer-entry.test.ts` (C6, C9) | main | At C5: the default is `wco`, a packaged build ignores the env var, and `legacy` is honoured only unpackaged. From C6: one entry, `index.html`, for the dev, experience and file bases, with `NOTCH_ENTRY` beside it. At C9: the generation module is gone. |
| R7-T2 | `services/updates/experience/foundation-api.test.ts`, `integrity.test.ts`, `apps/updater/src/manifest.test.ts` | main + unit | The desktop and updater `FOUNDATION_API` and protocol are equal. A tree built at API 1 is refused by a 2 shell, and vice versa. A tree without `renderer/notch.html` is refused at 2. **Provenance** (review #14): an old tree (its `build.json` at API 1, `generation: "legacy"`) given to the new builder is refused by `buildManifest`; the same tree signed by hand is refused by the verifier; renderer and agent `build.json` with different commits are refused. **Cache** (review r2 #10): an agent-only change with a new `ABACUS_BUILD_COMMIT` rebuilds both and stamps agree; the same commit hits both caches. |
| R7-T3 | `src/main/dev/experience-swap.electron.test.ts` | Electron | Two renderer builds served as installed experiences at API 2:<br>- stage 1 waits for `window.ready`;<br>- stage 2 awaits the candidate's restore promise, and the observed order is ready → capture → restore → flip, with a candidate that delays each stage (D11, review #13);<br>- a restore timeout still flips;<br>- `window.activity` defers the swap by 15 s;<br>- continuity restores focus, caret, composer text and scroll;<br>- a candidate reporting `failed` is discarded, and **after a full restart the previous experience boots** (P3, review #9);<br>- 3 failures stop swaps until relaunch;<br>- on an N−1 shell the N target is refused once and then memoised. **Drafts** (review r2 #13): a chat draft with two staged attachments, a non-default mode and model, a half-filled bot creation form, and 04's start draft all survive the swap into a new origin. An unregistered `sessionStorage` key fails `guards.test.ts`. A snapshot over 4 MB defers the swap. |
| R7-T4 | `apps/updater/src/classify.test.ts` | unit | C5: `src/renderer-next/**`, `index-next.html` and `notch.html` are `experience`. C7: `src/renderer/**`, `index.html` and `notch.html` are `experience`, and `src/shared/**`, `src/preload/**`, `package.json` and `pnpm-lock.yaml` are `foundation`. |
| R7-T5 | `cli-manager-wire.test.ts`, `relay-service.test.ts` | main | Every spawn's argv has `--wire agui --thread-id <sessionId> --compat-fd 3` and 4 stdio pipes. No code path yields `ndjson` (C5 through `defaultWire`; C10 by construction). The env flag is ignored when packaged (on HEAD, relay fix log Claude 9). |
| R7-T6 | `packages/agent/src/agui/agui-golden.integration.test.ts`, `agui-spawn.e2e.test.ts` | agent, 3 OSes | All 24 scenarios: compat bytes equal the `.ndjson` baselines. Spawned `plain-text`, `permission-accept` and `tool-bash` in fd and inline modes match (§8.2 masks). The report lists derived baselines separately. |
| R7-T7 | `src/main/services/agui/taps.e2e.test.ts` | main (spawned agent, fake provider) | Every tap in §8.3 fires with every spawn agui: artifacts recorded, a `<reply>` relayed, a routine settled, the turn waiter resolved, browser auto-allow answered on the emitting runtime, a host service answered, the inactivity watchdog writes one relay terminal. **Through `AgentManagerService`** (P5, review #11): multibyte text split across chunk boundaries on stdout and on fd 3, an over-long line on each, and an unterminated final line on each at exit, with tap inputs equal to the unfragmented run. |
| R7-T8 | `health-check.test.ts` | main | Agui mode:<br>- resolves on `CUSTOM session.ready`;<br>- refuses a candidate that exits, prints `RUN_ERROR`, or only prints NDJSON `ready`;<br>- the argv equals main's spawn minus `--compat-fd`.<br>NDJSON mode still passes before C10. |
| R7-T9a | `packages/agent/src/main.test.ts` + the CI AG-UI step | agent | **C5 gate.** `--wire agui --thread-id` works with fd 3, inline and none compat; an absent `--wire` is still `ndjson`; the sandbox probe is unaffected; the CI AG-UI step passes beside the NDJSON step (review #19). |
| R7-T9b | same | agent | **C10 gate.** An absent `--wire` means agui; `--wire ndjson` exits 64 with `wire_unsupported`; `--thread-id` is required; the CI NDJSON step is gone. |
| R7-T10 | `src/main/migrations/upgrade.packaged.test.ts` | packaged, 3 OSes | §13.4 "Upgrade to N" from the pre-rewrite source layout. |
| R7-T11 | same | packaged | The dormant fixture: no step re-runs; prefs are right. |
| R7-T11b | same | packaged | The dormant-then-pre-rewrite fixture: the drift reaches `prefs.json` through the read-only startup import, `user` leaves win, and `renderer-state.json` is byte-unchanged (review #8). |
| R7-T12 | same | packaged | Two profiles: each migrates on its first activation, and the inactive one is untouched until then. |
| R7-T13 | `downgrade.packaged.test.ts` | packaged, macOS + Windows + Linux | §13.4 "Downgrade" and "Re-upgrade": N−1 opens a home N ran on; N tolerates records N−1 rewrote (fields dropped). |
| R7-T14 | `steps/003-final-legacy-prefs.test.ts`, `004-archive-transcripts-v1.test.ts`, `runner.crash.test.ts`, `runner.records.test.ts`, `thread-store.cutover.test.ts`, `legacy-prefs.retired.test.ts` | main | Step 3: import, drop, backups under `home/electron/…` (F22), `renderer-state.retired.json` in the same commit, invalid keys counted; N+1 → N leaves `prefs.json` byte-identical (review r2 #3). Step 4: `.archive-index.json` merged in each commit; two successive commits with archived and newly converted threads keep every archived twin (review r2 #1); markers retired only under C1's proof. Attempt records: `attempt.json`/`completed.json` kept after staging cleanup; the derived index is rebuilt after damage and after three partial commits; a mismatched manifest is excluded (review r2 #5). **After every partial commit and every kill point, N serves archived threads and hides cleared ones.** N+1 with a failed plan, an unresolved recovery and a temporarily unreadable orphan serves nothing without evidence (review r2 #2). P6: an oversized, a temporarily unreadable and a `failed` source are shown, and a cleared retained oversized source with a failed deletion stays hidden across a restart (review r2 #8, #9). P1's injected `EACCES`/`EIO` and P2's held send, reset and quit, both done on HEAD, are re-run. |
| R7-T15 | `rollback.packaged.test.ts` | packaged | The published `--restore-legacy-files` command, run verbatim, on a two-profile home that N+1 migrated through two partial commits and a final one, with one interrupted recovery: destinations from the recorded roots (F22); `renderer-state.json` restored from step 3's `replace` backup while `prefs.json` is untouched (review r2 #4); a conflicting destination kept, with `.restored-<stamp>`; a damaged derived index rebuilt; the complete two-cycle sequence restores the latest cycle's files (review r2 #6). N−1 then shows every conversation and the preferences in both profiles. N started without any restore shows every archived conversation. |
| R7-T16 | `ci.yml` "The packaged app actually starts" (extended) | packaged, 3 OSes | The smoke exit waits for the outcomes (C4, review r2 #14), bounded at 90 s: `[smoke] main process ready`; `[smoke] renderer ready` against real tables on an empty home; on darwin and win32 `[smoke] notch ready` **or** `[smoke] notch disabled: <reason>` (the macOS runner expects `disabled`); on Linux `[smoke] notch n/a`. Exit status 0 only on those outcomes. No fatal pattern. Global shortcut unregistered at quit. |
| R7-T17 | Private pipeline checklist (signed RC) | manual + scripted, hardware | macOS: `spctl -a -vv` accepts the notarized app; launch; notch on a notched MacBook (R6-T31), external display (R6-T32); haptics; no TCC or Automation prompt from the JXA probe; mic prompt text once. Windows 11: signed installer installs over N−1; capsule at 100/125/150/200 % scaling with the taskbar on each edge (R6-T33); uninstall. Linux: AppImage and `.deb` start. |
| R7-T18 | `scripts/check-packaged-resources.js` (extended) + `packaged-asar.test.ts` | packaged | The asar holds `dist/renderer/{index,notch}.html` and `build.json`, and no `index-next.html` after C6 (review #12). The three CSP `<meta>` strings equal `RENDERER_CSP`. No `__abacusDev`, fixture DB, devtools, `monaco`, `katex` or `sonner` asset. The experience tree built from the same dist passes `verifyExperience`. |
| R7-T19 | `src/preload/preload-exposure.test.ts` | preload | For the main and notch windows: exposed globals = `{ abacusHost }`; the port handshake is installed before any page script; no `sendSync`. |
| R7-T20 | `src/main/ipc-surface.test.ts` | main (static) | `ipcMain.handle`/`ipcMain.on` appear only in the allow-listed files (the transport). No `webContents.send` outside `rpc/`. `IpcChannels` does not exist. |
| R7-T21 | `src/main/dev/cutover-greps.test.ts` | repo | The §5.1 inventory and resolved-specifier checks through `oxc-parser` (F24), with the negative control. The other §5 checks: `window.api`, IPC names, the window-chrome pattern of F17, `renderer-next`/`#next`, `RENDERER_GENERATION`, `NdjsonHost`/`wireFor`/`resolveWire`, `v1Archived`. |
| R7-T22 | `pnpm check:knip`, `scripts/check-knip-entries.mjs`, `scripts/cutover/check-removed-deps.test.mjs` | repo | knip is clean: files, exports, types, duplicates, dependencies, unlisted. A temporary unused file **outside every entry pattern** in each of `src/main`, `src/shared`, `src/preload`, `src/renderer` and `scripts/` (`scripts/lib/__knip-canary.mjs`, a non-entry helper path) is reported (review r2 #15). The entry list equals the set of scripts something runs. The removed-dependency check, through `oxc-parser`, detects every import form for every scoped and unscoped name, and every manifest key. |
| R7-T23 | `size-limit` | build | §14.4. |
| R7-T24 | `scripts/cutover/perf-compare.mjs` | packaged, reference machines | §14.1 M1–M6 against the last shipped build; numbers in the C5 and C14 PRs. |
| R7-T25 | `features/parity.test.ts` (aggregate) + `preload/parity.test.ts` before C8 | renderer, preload | The ids equal `parity-ids.json` exactly. Every consumer `file#symbol` resolves through `oxc-parser`: under `src/renderer-next/` (or `src/main/`) through C6, and under `src/renderer/` from C7 (review r2 #12). A legacy-tree consumer fails. No `todo`. Every `deferred` row names an owner and a PLAN anchor. Every `visible` retired or deferred row is in the release-note list. The `PARITY.md` rows equal the enumerated sets. |
| R7-T26 | `check:i18n`, `check:locales`, `src/shared/contract/languages.test.ts`, `scripts/i18n-dynamic-keys.test.mjs` | repo | After C13: every `en-US` leaf is in the final consumer set; every template key's prefix is declared or covered; no leaf that was a keymap source or retired remains; all 11 locales have the same key set (review #18). |
| R7-T27 | `src/main/keep-awake.test.ts` | main | P4's source: the blocker follows authoritative turn-state transitions, held while any turn is busy and released on the last finish, runtime exit or crash. Both orders of AG-UI terminal vs compat `turn_complete` give the same result, with no renderer call (review #10). |
| R7-T28 | `src/main/window-chrome-probe.lifecycle.test.ts` | main | (A) No timer is armed while hidden; the probe runs once on `show`. (B) `window:recreate` is not registered in legacy (C2) and not at all (C8). |
| R7-T29 | `src/main/window-chrome.electron.test.ts` (the 7 todos) | Electron, 3 OSes | 00-window-chrome §10's integration cases, run on the packaged RC once in C14. |
| R7-T30 | The phase Electron suites | Electron against the packaged RC | R1-T11b, R1-T22, R2-T16, R2-T32, R3-T31, R4-T29, R4-T30, R4-T34, R5-T36, R6-T30, R6-T36: green on the RC, not only in dev. |
| R7-T31 | `scripts/check-release-build.test.mjs` | build | A `VITE_UI_GALLERY=1` or `VITE_NEXT_DB_FIXTURES=1` dist is refused by `package` and `experience`. A release dist passes. The harness is absent from `dist/main`. Each unpackaged-only env override is ignored in a packaged launch. |
| R7-T32 | `src/main/migrations/first-launch.perf.test.ts` | packaged, macOS reference | §14.3. |
| R7-T33 | `src/main/services/updates/update-e2e.packaged.test.ts` | packaged, Windows + Linux CI; macOS in the private pipeline (Squirrel needs a signature) | N−1 updates to N through a local generic feed with `stagingPercentage`, and the relaunch runs the migration. **Halt** (review #15): at 0 % a newly checking client is offered nothing; with the feed withdrawn to N−1 likewise; a client that had downloaded N drops it after two consecutive checks and does not install on quit. The capsule does not hold the installer's lock. **During a download** (review r2 #16): a shipped-behaviour client installs after the halt (the limitation, asserted and reported); a client with C2's re-check cancels the transfer and installs nothing; a downloaded C2 client re-checks before install and drops the build. |

## 16. Amendments this spec requires elsewhere

1. **PLAN.md phase 7:**
   - "NDJSON host" → "the NDJSON-only host path; the compat stream stays (taps)";
   - "migration runs on real data from a backup" → "migration runs on real layouts with synthetic data (§13), plus optional local dogfood runs";
   - "release build smoke on macOS and Windows" → "macOS, Windows and Linux, plus the signed RC in the private pipeline";
   - add "two releases (N, N+1)".

   PLAN "Libraries" row `node-mac-notch` → "does not exist; JXA probe" (also 06:1113).
2. **Spec 00 C.5.** Steps 3 and 4 are registered in N+1, not in "the cut-over build" (D2).
   - Step 4 merges `threads/.archive-index.json` in the same commit as its removals (on HEAD; C1 makes it a merge). Per-thread index evidence decides "archived or cleared" in every release, and `v1Archived` goes (§9.3).
   - Step 3 writes `renderer-state.retired.json` in its commit.
   - The runner keeps `attempt.json` and `completed.json` per committed attempt, and derives `restore-index.jsonl` from them. Pruning honours them within the rollback window (C1, §9.4).
   - C.1's "manual procedure documented in `PARITY.md`" → this spec §12.4 (`--restore-legacy-files`, the only supported procedure).
   - C.9: the 64 MB cap, as the C1 fix log asks.
3. **Spec 00-agent-agui §6.4.** "The `--wire` flag goes" → the flag stays, accepting `agui` and refusing `ndjson` (D4). The spawned-process check compares against baselines after C10 (§8.2).
4. **Spec 00-window-chrome §7.** The completion grep drops the bare `isFullScreen` (F17).
5. **Spec 01 §13 risk "Old boot services not yet ported".** Resolved by C3.
6. **Spec 06 r4.** R6-T33 is extended by R7-T17's scaling matrix. `integrity.ts` requires `notch.html` from API 2 (D3). At C7, `notch.html`'s script path and the notch router plugin move with the tree. Nothing in this spec reintroduces inference or a long-lived haptics process (review #22).
7. **Updater (`apps/updater`).** `buildManifest` requires and cross-checks `renderer/build.json` and `agent/build.json`; `turbo.json` adds `ABACUS_BUILD_COMMIT` to both build tasks' `env` (D3, C4).
8. **Specs 02–05.** Every `sessionStorage`-persisted store registers with the continuity registry (C3).
9. **C1 fix log, "Handed over" (cut-over build).** The r1 note "construct `ThreadStore` with `v1Archived: true`" is superseded: the option is deleted (C15), and index evidence is the rule.

## 17. Acceptance

**Release N (after C14):**

- [ ] §2 entry criteria met, including P1–P6 merged and re-verified; every §3 row closed or carried to N+1 by name.
- [ ] Legacy behaviour was unchanged through C4. C5 is the only behaviour change (D1), and its PR carries the full release-candidate evidence.
- [ ] `DEFAULT_RENDERER_GENERATION` is gone, and the app has one renderer at `src/renderer` loaded from `index.html`, plus `notch.html`.
- [ ] `FOUNDATION_API = 2` in both places; an API-1 experience and a stale tree with a new stamp are both refused (provenance); swaps use the two-stage barrier; a failed candidate never boots after a restart (P3); the activity beacon and continuity work (R7-T2, R7-T3).
- [ ] Every agent spawn is agui. Compat is byte-identical on the 24 goldens and on 3 spawned scenarios × 3 OSes, and tap input matches under fragmented, long and unterminated input (P5). Every tap fires (R7-T5 … R7-T8, R7-T9a; R7-T9b at C10).
- [ ] The §5 greps are empty (R7-T21). knip is clean with dependencies (R7-T22). size-limit is set (R7-T23).
- [ ] Preload exposes `{ abacusHost }` only; the IPC surface is the transport (R7-T19, R7-T20).
- [ ] The window-chrome acceptance (00-window-chrome §12) passes on the packaged RC, including items (A) and (B) (R7-T28, R7-T29).
- [ ] Parity sign-off (§11): every row green, retired or deferred with an owner; each "Parity" row demonstrated on the packaged RC (R7-T25, R7-T30).
- [ ] Upgrade from every retained source-layout fixture, drift, multi-profile, downgrade and re-upgrade all pass (R7-T10 … R7-T13, R7-T11b), with oversized history shown **in N**. First-launch migration is within budget (R7-T32). N reads a home after any partial N+1 commit, preferences included (R7-T14).
- [ ] Performance: M1–M6 within budget on both reference machines; the phase budgets hold (R7-T24, §14.2).
- [ ] Packaged smoke on 3 OSes with renderer and notch markers (R7-T16). Asar contents are right (R7-T18). No gallery, fixture or harness in the release (R7-T31). The update path N−1 → N works (R7-T33).
- [ ] The signed RC checklist is done on macOS, Windows and Linux hardware (R7-T17). R6-T31's probe records are committed, and the haptics default follows 06 §10.7.
- [ ] `CHANGELOG.md` notes, the support article, and the PLAN, PROGRESS and spec 00 amendments (§16) are merged.
- [ ] `pnpm check` is green, and CI now includes knip, registry and size-limit.

**Release N+1 (after C15):**

- [ ] N at 100 % for ≥ 14 days, with no trigger hit.
- [ ] Steps 3 and 4 registered, and `v1Archived` deleted in the same commit, with index evidence still the rule. The repair, the dual-remove and the startup import deleted. The fallback reader kept. `--restore-legacy-files` shipped as the only restore procedure. R7-T14 and R7-T15 green. R7-T10/T11 re-run with N+1.

## 18. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A tap depends on NDJSON ordering relative to something agui changes. Stop and reset now hold admission, a documented divergence. | §8.2 item 5; R7-T7 drives every tap through spawned agents; the goldens cover stop and reset scenarios. |
| R2 | The frozen `.ndjson` oracles cannot grow after C10. New compat scenarios lose independence. | §8.2 item 6: derived baselines are labelled and reviewed. The later taps-to-AG-UI slice removes the need. |
| R3 | The downgrade path breaks because N−1's store readers choke on a field phases 3–5 added (05 attempt ids, 04 checkout fields, 03 looks). | R7-T13 on every RC. Any non-additive schema change needs its own migration step, and the field stays optional. |
| R4 | First-launch migration on a very large home (many GB of transcripts) takes minutes. The runner blocks the main window while it runs. | R7-T32 reports the 50 MB, 200 MB and 1 GB points. If 1 GB exceeds 3 min, step 1 becomes incremental: convert on hydrate, and let the runner do only the index. That decision is made before C14. |
| R5 | The shared experience target (`latest.zip`) makes N−1 clients refuse N experiences at every check for the whole rollout. | §6.4. The cost is measured in R7-T3. Staged rollout keeps the window short. |
| R6 | The JXA probe or haptics trigger a TCC prompt on a notarized build. | R7-T17 on the signed RC. Per 06 r4, a failed probe disables the companion on that display (no inference), and haptics default off beyond 150 ms latency. |
| R7 | Turns added under N−1 to a thread N already owned are not shown after re-upgrading. The model context has them. | Documented (§12.3). A later relay change can append v1-newer segments to an `agui` thread on hydrate if support sees it. |
| R8 | Cleared or archived history is misread across partial commits, downgrades and failed AG-UI deletions. | Orphans and markers are on HEAD. C1 adds per-thread archive records and marker-retirement proof. N decides each thread from them. R7-T14 checks after every partial commit and kill point (§9.3). |
| R9 | A gallery or fixture dist reaches a release because the screenshot and acceptance runs share `dist/renderer`. | C4's guard in `beforePack` and `build-experience.js` (R7-T31). |
| R10 | A prerequisite (P3–P6; P1 and P2 are done) slips, and the flip ships with it open. | §2 item 2 makes each an entry criterion with an owner. The C5 gate re-runs their tests (R7-T3, R7-T7, R7-T14, R7-T27). The relay findings are fixed on HEAD (relay fix log r1 and r2). |
| R11 | A user on a slow link is mid-download of the N−1 experience when N arrives. | Experiences are version-pinned; the N−1 bundle is refused on N and the N target replaces it. Nothing to do. |
| R12 | Removing `'unsafe-eval'` breaks transformers.js (dictation) in some path. | C12 narrows it only if R7-T16/T30 pass with `'wasm-unsafe-eval'`, including a dictation run; otherwise it is kept. |
| R13 | A `framer-motion` removal attempt also drops `motion`'s own copy. | F14: only the direct dependency is removed; `pnpm-workspace.yaml:69` stays; knip keeps `motion`. |
| R15 | The perf fixture cannot reach the shell offline on the source build (§13.3 step 3). | The generator fails loudly, and C5's gate names the blocker. M1–M5 are never measured on the onboarding fixture (review #20). |
| R17 | A shipped client mid-download installs N after a halt (F27). | Documented; counted in the downgrade population; C2's re-check ships from the dormant release so later rollouts are not exposed. |
| R18 | `.archive-index.json` becomes unreadable after N+1, and archived threads read as cleared. | Fail closed and log it. Nothing is lost: the v1 files are in the backups, and `--restore-legacy-files` or a later step-4 run rewrites the index. The support article covers it. |
| R16 | A user misses the 30-day window after N+1 and then needs N−1. | Backups the index references are kept 30 days after the step is applied. Beyond that, N (no restore needed) is the floor. The support article says so. |
| R14 | Windows `--compat-fd 3` behaves differently on some machines (AV hooks on pipes). | Inline mode exists (agent spec :373-377); R7-T6 runs both modes on Windows; `compat_lost` is a rollout trigger. |

## 19. Open questions for the coordinator

1. §2 item 4: will `rewrite/renderer` ship in a dormant release before the flip? That makes steps 1–2 field-proven and gives §13 its dormant fixtures.
2. §14 budgets are relative to the last shipped build, because the repo records no absolute cold-start or memory numbers. Should absolute caps be set after the first C5 measurement?
3. The 150 MB notch renderer RSS cap is a proposal pending R6-T27's measurement.
4. The rollout stages and the N+1 soak (≥ 14 days at 100 %) are proposals for the release manager.
5. The fallback reader's 512 MB streaming ceiling and its "too large" notice (P6) need a design owner for the copy.

## Review responses (r1)

*Kept as written for r2. r3 supersedes the `threads/<id>.archived` record (HEAD's `.archive-index.json`), `removals.jsonl` (derived `restore-index.jsonl`) and the manual appendix (withdrawn); see the r2 responses below.*

Source: `docs/rewrite/specs/reviews/07-cut-over.codex-r1.md` (25 items: 3 blockers, 18 major, 4 minor), reviewed against `c46e77d9`. The coordinator's decisions:
- #1: durable per-thread archive provenance in N;
- #3: keep a fallback v1 reader;
- #4: adopt HEAD's marker and token protocol;
- #5, #6: restore paths from recorded roots, plus an index of every committed removal;
- #8: keep the read-only startup import through N;
- #12: two Vite inputs;
- #13: a two-stage barrier;
- #14: build-time provenance;
- #15: withdraw, or percentage 0;
- #16, #17: the legacy inventory and parsed specifiers;
- #18: keymap, then delete;
- #19: split R7-T9;
- #20, #21: separate, immutable fixtures;
- #22: follow 06 r4;
- #24: knip project scope;
- #25: exact ids and resolved consumers.

Items #2, #7, #9, #10 and #11 are code defects on HEAD, routed to implementation agents. They are recorded here as prerequisites P1–P5 with their owners, not as cut-over PR work.

| # | Sev. | Verdict | What changed |
|---|---|---|---|
| 1 | Blocker | **Accepted** | D2 (a); C1 `threads/<id>.archived`, committed with each removal; §9.3's per-thread rule replaces r1's "step 4 applied" switch; R7-T14 checks N after every partial commit and kill point; R7-T15 checks N without a restore. |
| 2 | Blocker | **Accepted, routed** | Prerequisite **P1** (§2, register row 56): only absence reads as empty, and an unlistable directory stops orphan removal and completion; injected `EACCES`/`EIO` in R7-T14. |
| 3 | Blocker | **Accepted** | D2; C15 keeps a read-only fallback v1 reader: streaming above 64 MB up to 512 MB, then a notice with Show in folder; unreadable files retried; removal deferred until field logs show no retained sources. R7-T14 covers oversized, unreadable and failed sources. |
| 4 | Major | **Accepted** | C1 keeps HEAD's `threads/<id>.cleared` and token protocol. The r1 `.cleared/<id>` and mtime prescription is withdrawn. Step 4 retires a marker only when neither pre-clear file remains; a failed AG-UI deletion keeps it (§9.3, R7-T14). |
| 5 | Major | **Accepted** | F22; §12.4 derives destinations from each removal's recorded root, per profile (`userData` = `<home>/electron`). R7-T15 runs the published command and appendix verbatim on two profiles. |
| 6 | Major | **Accepted** | D2 (b); C1 `removals.jsonl`, rebuilt from `commit.log` after a torn tail; pruning honours it; §12.4 restores every attempt oldest-first with collision handling; R7-T15 covers partial commits and an interrupted recovery. |
| 7 | Major | **Accepted, routed** | Prerequisite **P2**: refuse or durably journal history changes on held threads; R7-T14 covers send, reset and quit while unresolved. r1's "defers until the next launch" is removed from C1. |
| 8 | Major | **Accepted** | D2 (c); C11 keeps the read-only, provenance-aware startup import through N and removes only the live listener; §5.5; new drift fixture and R7-T11b. |
| 9 | Major | **Accepted, routed** | Prerequisite **P3** (transactional activation, or restore on `SwapNotReady`); R7-T3 adds a full restart after a failed swap. |
| 10 | Major | **Accepted, routed** | Prerequisite **P4** (authoritative turn-state source); keep-awake is removed from C2; R7-T27 checks both pipe orderings. |
| 11 | Major | **Accepted, routed** | Prerequisite **P5** (incremental decoding, overflow and EOF on both pipes); §8.2 item 4 states what byte identity covers; R7-T7 drives taps through the manager with fragmented, long and unterminated input. |
| 12 | Major | **Accepted** | D10; C6 keeps `main` and `notch` inputs; its gate and R7-T18 require both HTML files in the packaged app and the experience. |
| 13 | Major | **Accepted** | D11; C3 defines stage 1 (readiness), then capture, then stage 2 (the restore promise, bounded), then the flip; readiness never waits on restoration; R7-T3 asserts the observed order. |
| 14 | Major | **Accepted** | D3; C4 writes `build.json` from the source constants in both builds; `buildManifest` and `integrity.ts` check it; §6.2 item 1 no longer claims the API number catches a restamped tree; R7-T2 packages an old tree with the new builder. |
| 15 | Major | **Accepted** | F23, D9; §12.2 halts with percentage 0 or withdrawal, never a freeze; downloaded builds are dropped by shipped clients after two not-offered checks (`update-service.ts:153-175`), with the residual (quit inside the window, macOS staged) named; R7-T33 covers it. |
| 16 | Major | **Accepted** | §5.1 proof: a legacy inventory with blob shas, resolved module specifiers, and a negative control; R7-T21. |
| 17 | Major | **Accepted** | §5.6: `check-removed-deps.mjs` over parsed specifiers (every import form, CSS) and manifests, with a test of every form; the regular expression is removed. |
| 18 | Major | **Accepted** | C13 is reordered: apply the keymap, compute the final consumer set (literals, plural stems, data-held keys, `i18nKey`, declared or prefix-covered templates), then delete, then remove the lists; R7-T26. |
| 19 | Major | **Accepted** | R7-T9a (C5: absent `--wire` is still ndjson, agui works, CI AG-UI step) and R7-T9b (C10: absent means agui, ndjson exits 64). |
| 20 | Major | **Accepted** | §13.2: a separate `perf-home-v<ver>` with onboarding completed through the source build (§13.3 step 3); M1–M5 never use the onboarding fixture; R15. |
| 21 | Minor | **Accepted** | D7, §13.2: immutable, versioned fixtures per source layout (pre-rewrite, dormant, drift, perf), each with its producer manifest and source-binary hash; new releases add and never replace. |
| 22 | Major | **Accepted** | F15, §10, register row 52, §17 and R6 follow 06 r4: one-shot haptics with the 150 ms default rule, no inference, the companion disabled on a failed probe; the long-lived process and aspect-ratio fallback are withdrawn. |
| 23 | Minor | **Accepted** | Rebased to `c46e77d9`: F1, F3, F6, F8, F12, F13, F15, F16 and new F19–F23; §2 lists the merged fixes; register rows 5, 6, 9–11, 15, 16, 19–22, 26 and 52 marked **Done** or re-pointed, with rows 56–62 added; C1 and C2 no longer prescribe work HEAD has done; the relay and C1 fix logs are cited in the header. |
| 24 | Minor | **Accepted** | C7 replaces `project` and `ignore`, not only entries; R7-T22 plants an unused file in each of main, shared, preload, renderer and scripts and requires knip to report it. |
| 25 | Minor | **Accepted** | D5 and §11: `parity-ids.json` gives the exact expected set; the `PARITY.md` set is enumerated from the bridge before C8; every `file#symbol` resolves through the TypeScript program; R7-T25. |

## Review responses (r2)

Source: `docs/rewrite/specs/reviews/07-cut-over.codex-r2.md` (16 items: 3 blockers, 13 major), reviewed against r2. r3 is rebased to `8dc67139`, where step 4 writes `threads/.archive-index.json` in the same commit as its removals and never takes a listed twin for an orphan, `ThreadStore` serves listed twins, clears fail closed (`savedAfterClear`), and held writes are durable under `threads/.pending/`. Coordinator decisions:
- #1, #2: per-thread index evidence in N and N+1, and `v1Archived` never decides alone;
- #3: an N reader for step 3's retirement record;
- #4: index `replace-user` backups with op and digest;
- #5: retained per-attempt manifest and completion record, with the index derived from them;
- #6: restoration generations, latest applicable backup per destination;
- #7: no manual procedure, only the command;
- #8, #9: the bounded streaming fallback with clear checks in N, routed to the thread-store owner;
- #10: the pinned commit in Turbo cache keys;
- #11: `oxc-parser`;
- #12: `src/renderer-next` consumers through C6;
- #13: full typed draft state;
- #14: delayed smoke exit, accepting a disabled companion;
- #15: enumerated scripts and a canary outside the entries;
- #16: the limitation documented, plus withdrawal-aware suspension.

| # | Sev. | Verdict | What changed |
|---|---|---|---|
| 1 | Blocker | **Accepted (rebased)** | HEAD's `threads/.archive-index.json` (same commit as the removals; a later run never orphans a listed twin) replaces r2's `threads/<id>.archived`. C1 makes step 4 merge the index. §9.3 decides every thread from it. R7-T14 runs two successive commits with archived and newly converted threads, and hydrates in N after each. |
| 2 | Blocker | **Accepted** | D2 (a), C1, C15: `ThreadStore.archived()` loses the `v1Archived` short-circuit (`thread-store.ts:576`), and C15 deletes the option. In N+1, as in N, nothing is served without index evidence. R7-T14 covers a failed plan, an unresolved recovery and an unreadable orphan twin. |
| 3 | Blocker | **Accepted** | F28. Step 3 writes `renderer-state.retired.json` in its commit (C1). N's `importLegacyPrefsAtStartup` skips absent keys listed there, never calling `resetLegacy` (C11). R7-T14: N+1 → N leaves `prefs.json` byte-identical. |
| 4 | Major | **Accepted** | The attempt manifest indexes `remove`, `replace` and `create` ops with root, source, backup, `originalSha256` and `resultSha256` (C1). §12.4 restores `renderer-state.json` from step 3's `replace` backup and never restores `prefs.json`. |
| 5 | Major | **Accepted** | A runner requirement (C1, register row 65): `attempt.json` plus `completed.json` kept in each backup directory. `restore-index.jsonl` is derived and rebuilt from them. R7-T14 damages the index after staging cleanup and after three partial commits. |
| 6 | Major | **Accepted** | §12.4 step 2.2: `restorations.jsonl` generations; per destination, the latest completed attempt the last generation has not consumed. R7-T15 runs the full two-cycle sequence. |
| 7 | Major | **Accepted** | The manual appendix is withdrawn. The command is the only supported procedure, and it runs before the runner and any window (§12.4, C14). |
| 8 | Major | **Accepted, routed** | Prerequisite **P6** ships the bounded streaming fallback in **N** (thread-store owner). §13.4 and R7-T10 assert the over-64 MB thread on N. C15 only keeps it. |
| 9 | Major | **Accepted, routed** | P6 applies the marker token, `v1Fingerprint` and `savedAfterClear` rules, with a streamed fingerprint, before any fallback conversion (§9.3). R7-T14 clears a retained oversized source whose deletion fails, then restarts. |
| 10 | Major | **Accepted** | F25, C4: `ABACUS_BUILD_COMMIT` is pinned, required in CI and release, and in both builds' Turbo `env`. R7-T2 tests an agent-only hotfix. |
| 11 | Major | **Accepted** | F24; §5.1 and §5.6 use `oxc-parser` 0.150.0 (installed; pinned as a root devDependency), with `rolldown/parseAst` as the stated fallback. `ts.preProcessFile` is removed. |
| 12 | Major | **Accepted** | §11: consumers resolve under `src/renderer-next/` through C6. C7 rewrites them and regenerates `PARITY.md` before C8 freezes it. R7-T25. |
| 13 | Major | **Accepted** | C3's draft part: every `sessionStorage` store (02 §8.7, 03 §8.3, 04, 05) registers with a schema and travels with the snapshot. Attachments go by reference, and a snapshot over 4 MB defers the swap. `guards.test.ts` rejects unregistered keys. R7-T3. |
| 14 | Major | **Accepted** | F26, C4: the smoke exit waits (≤ 90 s) for the renderer outcome and the companion outcome. `notch disabled: <reason>` is accepted, and expected on the macOS runner. R7-T16. |
| 15 | Major | **Accepted** | C7: executable scripts are enumerated from their callers (`check-knip-entries.mjs`), and helpers stay in project scope. R7-T22 plants `scripts/lib/__knip-canary.mjs` outside every entry. |
| 16 | Major | **Accepted** | F27, §12.2: the in-progress download limitation is documented for shipped clients. C2 adds the install-time feed re-check and mid-download cancellation, taken into the dormant release. R7-T33 halts during a download for both kinds of client. |

**Consistency pass (r3).**
- Every `threads/<id>.archived`, `removals.jsonl` and "manual appendix" reference is replaced.
- P1 and P2 are marked done, and P6 is added.
- `v1Archived` appears only as the option C15 deletes.
- R7-T1 … R7-T33 (with T9a/T9b and T11b) are each cited by a gate.
# Release N cut-over evidence

Worktree: `codex-cutover`, starting at `c92812e7`. This report separates implementation checks from release acceptance. A missing hardware, signed-artifact or last-release comparison is a gap, never a passing gate. C15 is excluded: the production registry remains `[1, 2, 5]`.

## Prerequisites verified on the starting tree

| Prerequisite | Code evidence | Regression evidence |
| --- | --- | --- |
| P1 strict archive enumeration | `migrations/steps/transcript-files.ts`, step 4; enumeration failures cannot authorize orphan removal | Step-4 failure tests |
| P2 held changes | `services/session/held-files.ts`; shared thread store; startup replay immediately after migrations | Thread-store recovery tests |
| P3 transactional activation | `experience-updater.ts`, store pending activation; scheduler commits after readiness | `experience-activation.test.ts` and renderer-host suites in broad run |
| P4 main keep-awake | `followMainAgentBusy`, relay aggregate busy; AG-UI excludes compat turn-state ordering | `keep-awake.test.ts`, `agent-busy.test.ts` |
| P5 taps framing | CLI manager splitter streams UTF-8, drops complete oversized lines and waits for both EOFs before exit | `line-splitter.test.ts`, `cli-manager-taps.test.ts` |
| P6 bounded fallback | ThreadStore streams retained 64–512 MB v1 without writing a conversion; larger files produce clearable notices | `stream-v1.test.ts`, thread-store suites |

The focused prerequisite run passed 85 tests in seven files. The broader run also exercised activation and RPC suites.

## Stack

Commit numbering follows the spec's C1–C14 headings. The task brings the restore command into N while keeping retirement steps unregistered; that overrides the spec's C15 command timing.

| PR | Implementation | Local checks | Remaining release evidence |
| --- | --- | --- | --- |
| C1 | Per-thread evidence (ignoring the global archived hint), invalid-index logging, retirement-aware startup import and step-3 plan; completed attempt manifests/index; retained partial generations; stop after partial; marker retirement proof; held replay and quit flush | Focused 174 tests; broad 4,333 passed / 484 files, one skipped suite and seven pre-existing chrome TODOs; 13 existing crash matrices (the earlier failing run reached 5,250 kill points; the passing run did not print a count); two additional actual step-3/4 runner-mutation matrices pass; TypeScript, oxlint (legacy warnings only), registry, legacy-diff and scoped knip pass | Real N+1 partial-home downgrade through packaged N; real last-release synthetic fixtures. Step planning uses direct fs rather than injected runner IO, so the kill matrix covers runner mutations, not kills inside every planner read/write. |
| C2 | Hidden probes wait on native events; recreate IPC is wco-only; mode-matched health checks; compatibility refusal memo; fresh install admission and download cancellation; API coupling check; seven chrome cases now executable | 74 tests in ten files; real macOS Electron chrome: five pass, two Linux-only cases skipped; TypeScript and oxlint pass | Windows/Linux CI; chrome fixture uses real BaseWindow/RendererHost but does not prove every production popup, browser-runtime layout, pre-exposure geometry, persisted-route recreation or signed artifact. Private feed withdrawal/install-on-quit and already-shipped clients need release-pipeline evidence. |
| C3 | Main-only activity beacon; versioned, validated complete draft registry with live-store hydration; full bot edits and baseline; anchored DOM continuity; 4 MB stand-down; awaited/logged stage 2 before exposure; log rings in both entries | 85 focused tests in 11 files; two real Electron MessagePort/readiness tests with delayed candidate stage 1 and stage 2, capture/restore/flip timestamps; TypeScript, oxlint and scoped knip pass | Packaged production-route draft demonstrations and virtualized off-window anchor restoration; Windows/Linux execution. |
| C4 | Source-derived renderer and agent provenance; builder/install agreement checks; pinned Turbo environment; production-only graph and content checks; dev harness elimination; bounded renderer/companion smoke outcomes; CI exit-status checks; gzip baseline | Production Vite build and release checker pass; gallery build rejected; 55 desktop tests, 14 updater tests, two Node provenance/cache-configuration tests; desktop and script TypeScript and oxlint pass | Actual agent-only hotfix cache miss and same-commit cache hit have not been executed. Packaged smoke and signed pipeline still pending. Size baseline is a local build measurement, not M1–M6. |
| C5 | **Partial implementation; release gate open.** Default wco with unpackaged legacy override; API 2 desktop/updater; API-2 notch-entry requirement; experience classifier; AG-UI spawn CI; exact 313 feature parity ids and parsed declaration checks; legacy blob inventory; notch Settings and tour replay handoff | 4,370 unit tests / 491 files; 11 integrity tests and four health-check tests after adding the missing-notch refusal case; 122 parity/bot tests after consumer corrections; 14 updater tests; four real agent spawn cases; four Node checks. Required Electron run: 301 pass / one performance failure / two Linux skips; isolated rerun passes all nine chat-kit cases, yielding passing evidence for 302 distinct cases. TypeScript, format, lint, registry, legacy-diff, scoped knip and locale checks pass. Production release checker and experience build pass. | Bridge map consumer column, frozen bridge enumerations/sign-off, final green/retired/deferred schema with evidence and PLAN anchors, release-note generation and packaged per-area demonstrations remain unfinished. Source-API fixture generation and a comparative CDP driver are now implemented in part, as detailed below. Synthetic source fixture completion, reference-machine performance acceptance, bridge consumers and packaged demonstrations remain open. The user-login comparison below supplies local M1–M6 observations. The unsigned directory smoke now handles a missing updater configuration without a fatal-pattern error; three-OS T16 acceptance remains open. |
| C6 | Not started; entry switch/deletion gate remains behind C5 | Not run | Legacy tree, entry and oracle moves remain. |
| C7 | Not started | Not run | Renderer rename, complete project scope and canary checks remain. |
| C8 | Not started | Not run | Legacy preload/window.api/raw IPC removal remains. |
| C9 | Not started | Not run | Generation/chrome collapse and Linux native-frame CI remain. |
| C10 | Not started | Not run | CLI/default wire removal, frozen oracle recorder, fragmented manager byte-identity cases and final CI wire step remain. |
| C11 | Not started | Not run | Live legacy preferences sync/dual writer removal remains; startup import must stay. |
| C12 | Not started | Not run | Removed-dependency checker/removal, final size limits and v1Archived option removal remain. |
| C13 | Not started | Not run | Keymap application, final consumer enumeration and locale purge remain. |
| C14 | Not started | Not run | Packaging corrections, restoration command, support article, release notes, rollout rule and final release acceptance remain. |

## Open evidence gaps

- R7-T10–T13, T11b and T32 require homes created by each retained real shipped build with synthetic data, including dormant-release drift, profiles, clearing and oversized histories. Hand-authored unit fixtures do not prove these gates.
- R7-T24 / M1–M6 require both specified reference machines and complete probe evidence. The authorized user-login comparison below replaces the local source-login blocker; Windows and signed RC acceptance remain open.
- Windows and Linux packaged execution and native-frame acceptance require CI/hardware results. Signed/notarized macOS and Windows hardware checks require the private release pipeline.
- Parity requires exact static ids/consumers and packaged per-area demonstrations; prior phase reports contain partial acceptance, so they are not a blanket sign-off.

## Commit record and candidate status

- C1: `f6b2effd`.
- C2: `afaf2ba9`.
- C3: `75842556`.
- C4: `6b5d2f59`.
- C5: `fa3c9ae7`, partial implementation, not a completed release-candidate sign-off. C6–C14 have not been implemented. This worktree is **not release N complete**.

## Local package and source-artifact observations

`electron-builder --config electron-builder.yml --dir --mac --arm64 --publish never` produced the real unsigned macOS app, with code-signing discovery disabled. The production checker passes after clearing `dist/main` explicitly; before that fix it correctly refused a stale mutation-harness chunk left by an acceptance build. The experience builder produced an API-2 archive from the production dist and agreeing renderer/agent provenance.

Launching the packaged app on an isolated empty synthetic home printed `[smoke] main process ready`, `[smoke] renderer ready`, and `[smoke] notch ready`, then exited 0. The same log contains an updater ENOENT/unhandled-rejection pattern because the unsigned `--dir` app lacks `Contents/Resources/app-update.yml`. Therefore R7-T16's no-fatal-pattern condition is **not proven**. This artifact was built from the dirty local C5 tree before the C5 commit and before local-history fixups; it is not exact-final-commit evidence. The package is not signed or notarized, and the companion-ready outcome does not establish notched-display geometry or hardware behavior.

The original shipped v1.0.85 macOS arm64 archive was downloaded and launched on a separate empty synthetic home. CDP reached its actual renderer and enumerated its `window.api`; the owned process was stopped afterward. [Artifact provenance](07-shipped-artifact.json) records the binary hash. This is an observation of the real source build, **not** a completed §13 content fixture. The 12 bots, 40 sessions, 2,000 histories, oversized/corrupt histories, profiles, routines, memories, grants, dormant drift and completed onboarding/stub account fixtures still need the generator and acceptance runs. No real user data was used.

All 24 NDJSON files compare byte-for-byte with starting commit `c92812e7`.

## Performance and size measurements

| Measurement | Local result | Limit of this evidence |
| --- | --- | --- |
| C4 main initial gzip | 1,247,875 bytes | Static entry/module-preload/style list; includes all emitted preload links. |
| C5 draft main initial gzip | 1,253,383 bytes | Same static method; not CDP first-paint resource measurement. |
| Shipped v1.0.85 static initial gzip | 1,001,567 bytes | Extracted directly from shipped asar, seven entry resources. |
| Static initial comparison | +25.14% | Over the M6 budget by this proxy; the specified CDP comparison is still missing. Do not claim M6 green. |
| C5 notch initial gzip | 622,079 bytes | Companion bundle only, not memory or latency. |
| Largest emitted lazy JS candidate | 917,079 bytes | `editor.api2` belongs to the remaining legacy build; workers and entry resources excluded. C4's earlier 1,483,496-byte candidate was a TS worker and must not be treated as a lazy route. |
| Math lazy gzip | 59,838 bytes | Static temml chunk. |
| Chat history expansion p95, contended Electron run | 50.6 ms | Failed the existing 50 ms phase gate; isolated nine-case rerun passed. The rerun did not print numeric measurements. |
| M1–M5 median/p90, M6 CDP resources | See the user-login comparison below | Seven alternating pairs, first discarded; local unsigned macOS evidence. Windows, wrong-theme frames and separate companion RSS remain open. |

[Draft size data](07-size-flip.json) and [shipped static size data](07-shipped-size.json) are retained separately. The +10% rule applies to M1–M5; M6's spec budget is at most the old initial bundle. Windows reference measurements and Linux Xvfb reports remain CI/hardware gaps. No comparative performance gate has passed.

## Release gate register at this checkpoint

| Gate | Status and exact outstanding evidence |
| --- | --- |
| R7-T1 | Local C5 default/override tests pass. C6/C9 entry and generation removal pending. |
| R7-T2 | Local API coupling, stale provenance, builder/verifier commit disagreement and missing-notch refusal checks pass. Actual new-commit Turbo miss and same-commit joint hit experiment pending. |
| R7-T3 | Existing real handshake/swap and activation tests pass; production-route packaged continuity demonstration pending. |
| R7-T4 | Local classifier tests pass through C5. Final C7 path classifier checks pending. |
| R7-T5 | Wco default selects AG-UI; existing relay/manager tests pass. Final unconditional construction and all-spawn audit pending C10. |
| R7-T6 | All 24 oracle bytes unchanged. Final AG-UI recorder and complete frozen-oracle run pending. |
| R7-T7 | Framing/EOF/UTF-8/oversize regression tests pass. Three scenario byte-identity runs through the real manager with fragmented fd/inline input pending. |
| R7-T8 | Both-mode argv/readiness and RUN_ERROR checks pass; AG-UI exits-without-ready and NDJSON-only readiness refusals pass. C10 collapse pending. |
| R7-T9a | Four real spawned entry cases pass, including absent-wire legacy default, AG-UI fd and inline compat. Complete explicit no-compat and sandbox-probe entry matrix still required. |
| R7-T9b | Not implemented; C10 default AG-UI and ndjson exit-64 contract pending. |
| R7-T10 | Full real pre-rewrite synthetic-content fixture and packaged upgrade assertions not implemented/run. |
| R7-T11 | Dormant-release identification, original artifact fixture and packaged upgrade assertions not implemented/run. |
| R7-T11b | Dormant→pre-rewrite drift fixture, pinned/theme changes and startup provenance assertions not implemented/run. |
| R7-T12 | Two-profile first-activation migration and untouched inactive-profile packaged demonstration not implemented/run. |
| R7-T13 | Packaged N−1 downgrade and N re-upgrade on the same generated homes, including records whose newer fields were dropped, not implemented/run. |
| R7-T14 | Local bounded fallback/recovery tests pass; original-shipped oversized/unreadable source fixtures and packaged demonstrations pending. |
| R7-T15 | Durable attempt manifests/index exist, but executable restoration command and two-profile/two-cycle/conflict/recovery acceptance are pending C14. |
| R7-T16 | Real unsigned macOS package exits 0 and prints main/renderer/notch readiness. Missing app-update.yml is explicitly logged before checks, and the new empty-home smoke has no fatal/unhandled-rejection pattern. Linux/Windows runs, no-companion Linux and shortcut cleanup remain pending; signed acceptance is separate. |
| R7-T17 | Signed/notarized macOS acceptance, physical notch/external-display/haptics/TCC/mic checks, Windows signed upgrade/scaling/taskbar/uninstall and Linux artifacts require pipeline/hardware. |
| R7-T18 | Production experience builds. Final asar/experience entry/provenance/CSP and removed-asset checks pending deletion and dependency steps. |
| R7-T19 | Legacy window.api is still exposed. C8 removal and both-window handshake/exposure assertions pending. |
| R7-T20 | Legacy raw IPC/IpcChannels remain. Parsed allow-list/removal assertions pending C8. |
| R7-T21 | Parsed-specifier helper and negative consumer checks exist. Inventory import-resolution negative control and final grep gate are not implemented. |
| R7-T22 | Current scoped knip passes. Main/shared/preload/script project widening, exact executable entries, five planted canaries and dependency checks pending. |
| R7-T23 | Baseline/report measurements exist; final RC limits +5% and CI package budget enforcement pending. |
| R7-T24 | User-authorized logged-in shipped v1.0.85 fixture measured against the fresh unsigned candidate on Apple M3 / 16 GiB. Seven alternating pairs, first discarded. Numeric M2 timing, M4 and M5 pass; M1 (+259.32%), total process-tree M3 (+38.60%) and observed M6 (+25.43%) fail. Wrong-theme frames, separate companion RSS, M1 route comparability, Windows reference hardware, Linux reporting, signed RC and phase-budget acceptance remain open. The static M6 proxy is unchanged and also fails. |
| R7-T25 | All 313 feature ids and parsed declarations pass. Bridge consumer mapping and frozen exact sets, final row status/evidence/owner anchors, notes and packaged per-area sign-off remain incomplete. |
| R7-T26 | Current i18n and all 11 locale schemas pass. C13 final post-keymap used-key equality and dynamic-key enumeration/purge pending. |
| R7-T27 | Main authoritative busy/keep-awake regression tests pass. |
| R7-T28 | Hidden/minimized/full-screen probe and wco-only recreate tests pass. Final absence of recreate IPC pending C8. |
| R7-T29 | macOS real Electron fixture: five pass; two Linux cases skip. Three-OS packaged production geometry/popup/browser-view/density/full-screen evidence pending. |
| R7-T30 | 302 distinct local Electron cases have passing evidence after isolated rerun, with two platform-only skips. These run dev acceptance fixtures, not the packaged RC; the specified packaged area demonstrations are missing. |
| R7-T31 | Gallery and stale-harness output were refused; production passes both admissions. Explicit fixture-flag rejection test and packaged env-override matrix remain incomplete. |
| R7-T32 | A partial original-source home has a packaged first-launch observation: 3.204 s overall, step 1 1.102 s. Complete fixtures, progress responsiveness and the 50 MB/200 MB/1 GB comparison remain missing. |
| R7-T33 | Local fresh-install admission, withdrawal cancellation and late completion tests pass. Real generic-feed N−1→N installation/relaunch/halt matrix, shipped-client limitation and capsule file-lock evidence require remaining implementation and platform execution. |

## Per-area sign-off still required

The bridge lacks its resolved consumer column and final frozen enumerations. Chrome needs three-OS packaged production geometry evidence. Agent wire needs the final frozen oracle/manager matrix. Foundation needs packaged screenshots/axe and hotkey checks; Chat needs packaged real approvals and reference performance; Bots/Sessions need packaged routes, terminal/device/browser and attachment cases; Routines/Artifacts/Library/Settings need packaged interaction and stress cases; Onboarding/Tour/Notifications need fresh install, settings/command-menu integration, dictation and hardware demonstrations. Static feature consumer resolution is not a substitute for these checks. Existing `partial` phase entries are deliberately not relabeled as accepted.


## Continuation checkpoint, 1 October 2026

The renderer merge is `19c8dd96`. The combined Vite configuration retains source provenance, release graph checks, production readiness definitions, main output cleanup and the updater bundle. It also retains detached main/preload aliases, registry compiler exclusions and route-test ignore prefixes. Production build output has zero React Compiler diagnostics. A bounded Vite dev launch on a fresh synthetic home built main/preload and opened the app without an unresolved `#shared/contract` import. Both detached resolver tests pass after adapting them to the config function.

C5 remains partial. C6–C14 have not started. This checkpoint does not authorize a release or claim that C5's entry gate has passed. Spec 07 §13.3 and risk R15 require refusing a performance fixture when the original source build cannot reach its shell through the synthetic account stub. The source account fetch bypasses the loopback proxy environment and returns `unidentified-account`. At that checkpoint, a user decision about recorded main-debugger fetch instrumentation was pending. The user later authorized the logged-in fixture described below. No fetch instrumentation workaround has run. The disabled alternative is implemented and tested in `scripts/cutover/source-fetch-proxy.mjs`, with exact synthetic-home checks, loopback-only forwarding and a recorded script hash.

### C5 continuation changes and checks

| Change | Evidence | Limit |
| --- | --- | --- |
| Unsigned directory updater handling | Missing `app-update.yml` logs that updates are disabled before a check starts. Automatic download promises now have a rejection observer. Two new regression tests pass. Empty-home unsigned macOS smoke exits 0 and prints all readiness markers with no fatal or unhandled-rejection pattern. | This does not prove signed updater installation or three-OS T16 acceptance. |
| Source fixture generator | Original v1.0.85 archive hash remains `e2ab8da004af1570ad6165bc009311b5badb5de1337f0d88d2f960641a2dd2df`. Own API writes create bots, sessions, 2,000 histories, preferences, geometry, memories and routine attempts. Oversized content is constructed from a seed inside the source renderer to avoid oversized CDP commands. The second profile follows the explicitly permitted registry construction. | The shipped pairing decision API cannot create an absent sender. The auto-reply grant is missing. Source-completed onboarding and final upgrade/downgrade assertions remain open. Partial archives cannot satisfy the complete fixture gates. |
| Comparative probe driver | Same bot/composer and long-session probes for both builds; seven alternating pairs, first discarded; median/p90; parentage RSS sampler including Windows code; GC/heap sampling; observed CDP Network resources and per-resource gzip sizes. Manifest-verified home copies exclude incidental Chromium state. Full mode requires a completed source perf-home and a separately migrated candidate manifest. | At this checkpoint M1–M5 had not run; the follow-up below supplies measurements. Wrong-theme frame classification and companion RSS attribution remain unimplemented. Windows sampling has not run on hardware. This is a partial implementation of R7-T24, not a passing gate. |
| Agent indexing integration | The merged multiline CSS `:is(...)` selector exposed a line-location assertion that assumed a selector's first component fit one line. The assertion now verifies both its starting line and normalized selector continuation. The complete agent unit project passes after the fix. | No production indexer behavior changed. Full agent typecheck also required adding the missing declaration for the existing build provenance helper. |

The immutable partial source archives and their manifests are retained under `apps/desktop/src/main/migrations/__fixtures__/legacy-home-pre-rewrite-v1.0.85*.partial.*`. The second partial variant corrects the draft preference envelopes, uses the shared bot templates and includes a typed v1 tool call. Neither claims complete source-home acceptance.

[Tool usage and limitations](../../../scripts/cutover/README.md) documents the commands and refusal behavior. The source archive is never read from a user home, and no content came from openbot.run.

| Check | Current result |
| --- | --- |
| Desktop `tsc -b`; agent full typecheck; tools typecheck | Pass |
| Desktop shared/main/renderer/renderer-next unit projects, `--maxWorkers=2` | 5,432 tests pass across 609 files; the added second updater test also passes in its focused two-test file |
| Required Electron main-serial | 302 pass, two Linux-only skips across 12 files |
| Agent unit project | 1,732 pass, two skips across 100 passing files and one skipped file |
| Updater / connectors | 14 tests pass in each package |
| Cut-over Node tooling checks | Eleven tests pass |
| oxlint / oxfmt | No lint errors; inherited legacy warnings. Format check passes after formatting the new reports and scripts. |
| UI registry / legacy diff / scoped knip / React Compiler | Pass; zero compiler diagnostics |
| NDJSON frozen oracles | All 24 are byte-identical to `c92812e7` |
| Release graph checker | Production passes; the final package is rebuilt from the checkpoint commit after acceptance builds |
| Packaged macOS smoke | Unsigned local result only; all readiness outcomes and exit 0. Signed, Windows and Linux acceptance remain gaps. |

### Measured observations

| Measurement | Old | Candidate | Finding |
| --- | --- | --- | --- |
| M6 CDP onboarding diagnostic, median / p90 | 1,001,567 / 1,001,567 gzip bytes | 1,251,321 / 1,251,321 gzip bytes | +24.94%. The numeric M6 budget fails. Seven alternating pairs ran; first pair discarded. These fresh onboarding homes are not the required completed performance homes, so no R7-T24 acceptance is claimed. |
| Partial source-home packaged first launch | Not a comparative run | 3.204 s overall; step 1 1.102 s; step 2 0.006 s; step 5 0.008 s | 2,002 files examined; 1,997 converted; three oversized files kept; one corrupt and one unknown-version file skipped. Six routines had 120 recorded attempts, six linked to sessions. This is a partial fixture observation, not T10/T32 acceptance. |
| M1–M5 at the prior checkpoint | Unmeasured then | Unmeasured then | Superseded by the authorized user-login measurements below. |

[Actual CDP resources and run samples](07-cdp-m6-diagnostic.json) retain all 14 runs. [Partial upgrade observation](07-partial-upgrade.json) records the log and source-file hash comparison. The source transcript hashes and inactive-profile hashes are checked separately from intentionally changed migration records. The partial producer records its dirty generator provenance; it is not exact committed-generator fixture acceptance. The partial archive retains its seeded 30 MB history; the specified acceptance-time regeneration remains unfinished.

### Decisions and remaining gates

- The dormant-release version is still a coordinator question. No dormant or dormant-to-pre-rewrite fixture is inferred from an unshipped branch.
- The user authorized the real logged-in shipped home for performance. The synthetic generator still refuses the perf fixture under the strict source-proxy path. No fetch instrumentation was used.
- The bridge consumer column, frozen exact bridge sets, final parity row schema, notes and packaged per-area demonstrations remain C5 work. Existing partial reports remain partial.
- C6–C14 are unimplemented. Legacy deletion, renderer move, preload/raw IPC removal, generation collapse, wire cleanup, transition writer removal, dependency and locale cleanup, restore command, support article and release notes remain outstanding.
- Spec 07 §19 still needs decisions about absolute performance caps, the proposed 150 MB companion RSS cap, rollout stages and the 14-day N+1 soak, and ownership of fallback-reader copy. The source proxy decision and the failed M6 number do not resolve those questions.
- Signed/notarized macOS, physical notch/external-display/haptics/TCC/microphone checks, Windows signed upgrade/scaling/taskbar/uninstall and Linux packaged/native-frame checks need pipeline or hardware evidence. None passes by omission.


## User-login performance follow-up, 1 October 2026

The user authorized the logged-in shipped v1.0.85 home for M1–M5. The original home was copied into a private temporary directory outside the repository before any app launch or API write. No file from that home, app log, private producer manifest or credential-file hash is committed. `.build/` was already ignored; `git check-ignore .build/cutover/probe` confirmed it, and the initial `git status --short` was clean.

The private producer records `"user-login, shipped v1.0.85, not source-generated"`, `provenance: "user-login"` and `sourceGenerated: false`. The original home had no bots or sessions. The shipped build's `window.api` created 12 bots, 40 sessions and 2,000 synthetic histories on the scratch copy. The target session has 1,000 messages; the other histories contain two short messages. This is the authorized performance workload, not the oversized synthetic migration fixture in §13.3. Source shell admission uses the user's login. Neither the synthetic account stub nor main-debugger fetch instrumentation was used. macOS outbound network access is blocked during the runs.

The candidate production build and unsigned arm64 directory package were rebuilt from application source at `1b14bc91`. A separate candidate scratch copy ran the packaged migrations before timing. Step 1 converted all 2,000 histories; steps 2 and 5 completed. Both private file manifests are hash-checked before each run. The driver creates a new private home for each launch and removes it after stopping the owned process. Incidental Chromium state, logs and runtime files are excluded from the measured copies.

The comparison alternates seven old/new pairs on this machine, discards pair 1, and reports the median and nearest-rank p90 of the six remaining samples. M3 is sampled 60 seconds after M1; M4 follows explicit heap-profiling enablement and garbage collection. The common readiness probe requires a visible fixture bot in the sidebar and a composer that can take focus. The shipped shell opens a short regular session and reopens Bots; the candidate opens the fixture bot. That route difference limits M1 comparability. M5 opens the same 1,000-message session in both builds and times the session click until its last message is visible.

CDP now selects the main `index.html` or `index-next.html` document, records resources separately for each page, and excludes the notch document. The additional resource-tracking connection closes after first paint before idle/heap sampling. Earlier setup attempts produced no complete comparison. One attempt stopped after its discarded pair when the next old-build GC request timed out. It contributes no samples to the final medians or p90 values.

The existing M6 static proxy above is unchanged. Wrong-theme screencast classification, separate companion RSS attribution, Windows reference hardware, Linux Xvfb reporting, signed RC checks and the packaged phase budgets remain open. This work supplies local numerical evidence and does not complete R7-T24 or C5.


All 432 original-home file hashes are unchanged after the comparison. [Reviewed numerical samples and build hashes](07-user-login-perf.json) retain all 14 runs, per-process RSS, per-resource gzip bytes and unrounded summaries. Private paths, process command lines, the credential manifest and fixture content are omitted. The machine is an Apple M3 with 16 GiB RAM, macOS arm64.

| Metric | Old median / p90 | New median / p90 | New median budget | Numeric result |
| --- | --- | --- | --- | --- |
| M1 interactive, ms | 1,803.050 / 2,741.600 | 6,478.800 / 7,282.500 | ≤ 1,983.355 | Fail |
| M2 first paint, ms | 1,680.900 / 2,137.600 | 1,637.650 / 1,664.300 | ≤ 1,848.990 | Pass for timing; theme check open |
| M3 total process-tree RSS, bytes | 659,496,960 / 669,057,024 | 914,038,784 / 983,891,968 | ≤ 725,446,656 | Fail; companion included |
| M4 renderer JS heap, bytes | 19,180,194 / 19,262,056 | 20,159,910 / 20,167,356 | ≤ 21,098,213.4 | Pass |
| M5 long session, ms | 721.500 / 725.200 | 163.050 / 313.100 | ≤ 793.650 and < 600 | Pass |
| M6 observed initial gzip, bytes | 1,001,567 / 1,001,567 | 1,256,227 / 1,256,227 | ≤ 1,001,567 | Fail |


Milliseconds in this table are displayed to three decimals. Decisions use the unrounded JSON values; no rounding changes a failure into a pass. M3 includes the companion in the total, so it cannot establish the main-window tree or the separate 150 MB cap. M2's timing passes, but its complete gate still needs the wrong-theme frame check. Local M4 and M5 meet their numeric budgets. M1, M3 and M6 fail numerically. R7-T24 remains open; this does not authorize C6 or a release.

The prior static M6 proxy remains 1,001,567 bytes old versus 1,253,383 bytes candidate, +25.14%, failing its 1,001,567-byte budget. The new observed CDP result is 1,001,567 versus 1,256,227 bytes, +25.43%, and also fails.

No additional user login or fetch-instrumentation approval is needed for these local measurements. Windows 11 x64 reference measurements, Linux Xvfb reporting, signed RC and physical platform acceptance still need hardware or the release pipeline. Theme-frame and companion-RSS checks need implementation. Spec §19's unresolved release-policy and cap decisions remain separate user/coordinator work.

## Implementation continuation

| PR | Implementation checks | Release evidence |
| --- | --- | --- |
| C5 completion (`d8bccf17`) | Bridge consumers resolve to implementing main routers; exact bridge enumerations frozen; final feature metadata and visible-note generator. Focused: 11 tests. | Hardware, signed, comparative and packaged acceptance gaps above remain open. Green rows record implementation checks only; partial acceptance is deferred. |
| C6 (`2e4c6e3a`) | Deleted legacy renderer except locales, froze preference/starter oracles, single main entry plus notch, moved shared tool result types, removed legacy build/test/lint project. Focused: 49 tests. | Build and packaged/screenshot evidence deferred to final gates; hardware gaps remain. |
| C7 (`b28230c2`) | Moved renderer and executable scripts, rewrote consumers/aliases/configuration, regenerated bridge report, widened knip and checked five planted canaries. Focused: 16 tests pass. The initial canary failure was resolved in final validation by isolating project scope from test readers; all five areas pass. | Unused exports/dependencies found by widened knip are queued for C12. Screenshot/hardware acceptance remains open. |
| C8 (`0eef628b`) | Removed window.api, bridge/types/generator, raw legacy IPC/channels and legacy event sends; bus-only host events and subscription-only two-stage swaps. Focused: 64 tests. | Packaged handshake/smoke and hardware acceptance remain open. |
| C9 (`3473aa84`) | Collapsed generation/chrome/startup theme and notification policy; removed generation modules, legacy metrics and raw update sends. Focused: 43 tests. | Linux native-frame CI retained. The spec’s conditional webview removal cannot yet run: the new FilePreview still consumes it, so its main security guard stays. Three-OS geometry/hardware acceptance remains open. |
| C10 (`1a3249b0`) | Unconditional AG-UI spawn/health check, removed NDJSON-only host/wire selection, structured exit-64 refusal, AG-UI/compat/stdin recording, six fragmented frozen-scenario manager cases. Focused: 56 tests; all 24 NDJSON files byte-identical. | Dist-dependent spawned/recorder/golden suites deferred until dependency builds after C14. Three-OS spawned evidence remains open. |
| C11 (`3f4217fd`) | Removed live legacy preferences sync, durable-state contract and the v1 transcript/dual writer. Kept read-only startup drift import, retirement protection, repair/fallback and dual removal; old-build saves are test-only fixtures. Focused: 64 tests. | Real-build downgrade and multi-platform acceptance remain open. |
| C12 (`5d6e88cc`) | Removed unused legacy dependencies/patch, widened knip dependencies and unlisted checks, resolved unused exports, declared transitive imports, fixed five-area canary, set C5 +5% bundle limits and CI gate, removed v1Archived. Focused: 29 tests. | CSP narrowing and peak heap require final packaged evidence; licensed ConnectorMark paths remain. |
| C13 (`330d7ac7`) | Applied the keymap to all 11 locales, then pruned 3022 to 2082 leaves using parsed literal/data/prop keys, plural stems and finite dynamic families. Restored indirect data/template catalogues discovered during final validation; removed keymap/retired transition lists and their tests. Focused: 25 tests; locale and JSX i18n checks pass. | Language screenshots and platform acceptance remain open. |
| C14 (`this commit`) | Digest-checked restore command before migrations/windows, rebuilt per-profile index, generations/latest attempts, collision handling and two-cycle tests; release notes generated from visible parity metadata, support article, PLAN/PROGRESS, duplicate microphone key removed, foundation version 1.0.13. Focused: 24 tests. | Recorded notch probes/150ms haptics decision, signed RC, three-OS smoke, reference performance and release-manager go remain gaps. |


### Final implementation gates

All C5–C14 commits preceded dependency builds and production validation. Connectors, agent and updater were built before dist-dependent tests. The full unit and required Electron gates ran once; only affected files were rerun after repairs. No package or comparative probe was run in this implementation continuation. The checks below supersede earlier implementation checkpoints, without changing historical acceptance evidence.

| Gate | Result |
| --- | --- |
| `tsc -b` | Pass after stale-reference repairs. |
| Desktop unit projects, `--maxWorkers=2` | Initial full run: 4213 pass, 101 fail in 488 files. Affected main tests: 43 pass; affected renderer/shared tests: 123 pass after repairs (one obsolete legacy-dialog test removed). Additional import guards: 18 pass. Full suite was not repeated. |
| Agent / updater / connectors unit projects | 1733 pass, two skips / 14 pass / 14 pass. |
| Dist-dependent AG-UI / compatibility | 28 spawned/golden tests and five recorder tests pass. All 24 NDJSON golden files remain byte-identical to `c92812e7`. |
| Cutover Node tooling | 25 tests pass after the focused canary repair; locale consumer tooling adds three passing tests. |
| Required Electron `main-serial`, `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1` | **Not green.** Initial full run: 274 pass, five fail, 25 skipped. Affected five-file rerun: 214 pass, three fail. Startup, notch and browser functional failures are repaired. Remaining timing failures: streaming busy p95 60.404 ms, history expansion 60.9 ms, 3000-tool expansion 50.5 ms; each requires <50 ms. Thresholds were preserved. |
| oxlint / oxfmt | Pass. |
| UI registry / deletion inventory | Pass. `check:legacy-diff` was retired with the legacy renderer; parsed-import and deletion inventory guards replace it. |
| Complete knip / five-area canaries | Pass. `check:knip` replaces the retired `check:knip-next`; includes files, exports, types, duplicates, dependencies and unlisted imports. |
| React Compiler / production release checker | Pass; zero compiler diagnostics. Production output is an unsigned implementation build from the working tree, not signed RC acceptance. |
| Locale / JSX i18n | Pass; all 11 locales have 2082 leaves and dynamic consumer families are covered. |
| C5 +5% gzip size limits | Pass: main 1.2 MB, companion 600.35 kB, largest lazy chunk 162.07 kB, math 59.71 kB. [Measured bundle inventory](07-size-current.json) records this local build, not old/new reference performance. |
| Additional C12 dependency audit | **Not green.** High advisories: undici GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3, GHSA-vp8m-p9jh-q5pm; brace-expansion GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. No acceptance exemption was added. Dependency remediation remains release-blocking. |

Final validation repairs are included in C14: stale source aliases and transport mocks, real spawned default/refusal cases, restored indirect locale consumers, AG-UI input recording, source provenance, tooling canaries and CI size enforcement. The user-visible notes are in the actual Unreleased changelog section. `.build/` remains ignored and no account-home files are staged or committed.

### Still-open §19 decisions and evidence gaps

1. Whether to ship a dormant release before the flip, and thus obtain field-proven steps 1–2 and dormant fixtures.
2. Whether to set absolute cold-start and memory caps after the first C5 measurement.
3. Confirmation of the proposed 150 MB companion RSS cap after R6-T27 measurement.
4. Release-manager rollout stages and the proposed N+1 soak of at least 14 days at 100%.
5. Design ownership of the 512 MB fallback ceiling and the “too large” notice.

Signed/notarized macOS, signed Windows upgrade/scaling/taskbar/uninstall, Linux packaged/native-frame checks, physical notch/external-display geometry, microphone/TCC and recorded R6-T31 haptics (<150 ms) remain gaps. Packaged fresh-install and feature demonstrations, complete immutable shipped-source migration fixtures, Windows reference and Linux performance evidence, wrong-theme frames and separate companion RSS remain gaps. The historical M1/M3/M6 numeric failures are unchanged. CSP narrowing and heap-limit reduction still need packaged evidence; webview removal remains conditional on replacing FilePreview's active consumer. The Electron timing and dependency-audit failures above prevent a green release gate. Release-manager go is still required.

exec
/bin/zsh -c 'command -v rg; ls /usr/local/bin/git /usr/local/bin/rg; find .. -name AGENTS.md -print; cat apps/desktop/src/main/migrations/restore-legacy.ts; cat apps/desktop/src/main/services/config/legacy-prefs.ts' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
exec
/bin/zsh -c 'cat apps/desktop/src/main/migrations/restore-legacy.ts apps/desktop/src/main/services/config/legacy-prefs.ts; cat apps/desktop/src/main/migrations/steps/index.ts; cat apps/desktop/src/main/migrations/runner.ts' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
import { randomUUID } from "node:crypto";
/** Digest-checked rollback from completed migration evidence, independently per profile. */
import fs from "node:fs";
import path from "node:path";

import {
  readArchiveIndexStrict,
  ARCHIVE_INDEX_NAME,
} from "../services/session/thread-store";
import { rebuildRestoreIndex } from "./attempt-records";
import {
  backupsRoot,
  formatStamp,
  sha256File,
  nodeIo,
  inside,
  writeFileAtomic,
} from "./backup";
import { readRecordState, writeRecord } from "./record";
import { runMigrations } from "./runner";
interface Generation {
  generation: string;
  at: string;
  consumed: string[];
  destinations: string[];
}
export interface RestoreResult {
  home: string;
  restored: string[];
  collisions: string[];
  skipped: string[];
}
const safePath = (root: string, relative: string): string => {
  const file = path.resolve(root, relative);
  if (inside(root, file) === null)
    throw new Error(`Restore path outside root: ${relative}`);
  return file;
};
export const profileHomes = (base: string): string[] => {
  const homes = new Set([path.resolve(base)]);
  const file = path.join(base, "profiles.json");
  if (fs.existsSync(file)) {
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const value of Object.values(registry.profiles ?? {})) {
      if (typeof value !== "string") throw new Error("Invalid profile path");
      const home = path.resolve(base, value);
      if (home !== path.resolve(base) && inside(base, home) === null)
        throw new Error("Profile outside base");
      homes.add(home);
    }
  }
  for (const home of homes) {
    let current = home;
    while (current !== path.dirname(path.resolve(base))) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink in profile path: ${current}`);
      current = path.dirname(current);
    }
  }
  return [...homes];
};
export const restoreLegacyHome = async (
  home: string,
  now = new Date()
): Promise<RestoreResult> => {
  const userData = path.join(home, "electron");
  // Finish or undo an interrupted commit before reading its completion evidence.
  const recovery = await runMigrations({
    home,
    userData,
    steps: [],
    appVersion: "restore",
    log: () => {},
  });
  if (recovery.failed || recovery.unresolved.length)
    throw new Error(`Unresolved migration in ${home}`);
  const recordState = readRecordState(home);
  if (recordState.status !== "ok" && recordState.status !== "missing")
    throw new Error(
      `Cannot restore with ${recordState.status} migration record`
    );
  const entries = rebuildRestoreIndex(home);
  const journal = path.join(backupsRoot(home), "restorations.jsonl");
  const generations: Generation[] = fs.existsSync(journal)
    ? fs
        .readFileSync(journal, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  for (const g of generations)
    if (
      typeof g.generation !== "string" ||
      !Array.isArray(g.consumed) ||
      !g.consumed.every((id) => typeof id === "string") ||
      !Array.isArray(g.destinations) ||
      !g.destinations.every((dest) => typeof dest === "string")
    )
      throw new Error("Invalid restoration journal");
  const latest = new Map<string, (typeof entries)[number]>();
  const allByDestination = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (![3, 4].includes(entry.step) || !entry.backup || !entry.originalSha256)
      continue;
    const destination = safePath(
      entry.root === "home" ? home : userData,
      entry.source
    );
    if (destination === path.join(home, "prefs.json")) continue;
    if (
      entry.op !== "remove" &&
      !(
        entry.op === "replace" &&
        destination === path.join(userData, "renderer-state.json")
      )
    )
      continue;
    if (entry.roots.home !== home || entry.roots.userData !== userData)
      throw new Error("Restore roots differ from profile");
    const consumed = new Set(
      generations
        .filter((g) => g.destinations.includes(destination))
        .flatMap((g) => g.consumed)
    );
    if (consumed.has(entry.attempt)) continue;
    const list = allByDestination.get(destination) ?? [];
    list.push(entry);
    allByDestination.set(destination, list);
    const previous = latest.get(destination);
    if (
      !previous ||
      entry.stamp > previous.stamp ||
      (entry.stamp === previous.stamp && entry.attempt > previous.attempt)
    )
      latest.set(destination, entry);
  }
  const result: RestoreResult = {
    home,
    restored: [],
    collisions: [],
    skipped: [],
  };
  const consumed = new Set<string>();
  const destinations: string[] = [];
  const index = readArchiveIndexStrict(path.join(home, "threads"));
  for (const [destination, entry] of latest) {
    const backup = safePath(
      path.join(backupsRoot(home), entry.directory),
      entry.backup!
    );
    try {
      if (sha256File(backup, nodeIo) !== entry.originalSha256) {
        result.skipped.push(`${destination}: backup digest mismatch`);
        continue;
      }
    } catch (error) {
      result.skipped.push(`${destination}: ${String(error)}`);
      continue;
    }
    // Reject symlinks along either path. No restore may follow a profile link outside its home.
    for (const file of [destination, backup]) {
      let current = file;
      while (inside(home, current) !== null) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
          throw new Error(`Symlink in restore path: ${current}`);
        current = path.dirname(current);
      }
    }
    const current = fs.existsSync(destination)
      ? sha256File(destination, nodeIo)
      : null;
    let target = destination;
    if (
      current !== null &&
      current !== entry.originalSha256 &&
      current !== entry.resultSha256
    ) {
      const parsed = path.parse(destination);
      target = path.join(
        parsed.dir,
        `${parsed.name}.restored-${formatStamp(now)}-${entry.attempt}${parsed.ext}`
      );
      if (
        fs.existsSync(target) &&
        sha256File(target, nodeIo) !== entry.originalSha256
      )
        throw new Error(`Restore collision already exists: ${target}`);
      result.collisions.push(target);
    }
    if (current !== entry.originalSha256 || target !== destination) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, fs.readFileSync(backup), nodeIo);
    }
    // Keep backup evidence for the rollback window and retry after interrupted metadata writes.
    result.restored.push(destination);
    destinations.push(destination);
    for (const op of allByDestination.get(destination) ?? [])
      consumed.add(op.attempt);
    if (
      destination.startsWith(path.join(home, "transcripts") + path.sep) ||
      destination.startsWith(path.join(home, "threads") + path.sep)
    )
      delete index.archived[
        path.basename(destination).replace(/\.(json|cleared)$/, "")
      ];
    if (destination === path.join(userData, "renderer-state.json"))
      fs.rmSync(path.join(userData, "renderer-state.retired.json"), {
        force: true,
      });
  }
  if (destinations.length) {
    writeFileAtomic(
      path.join(home, "threads", ARCHIVE_INDEX_NAME),
      JSON.stringify(index),
      nodeIo
    );
    const record = recordState.record;
    record.applied = record.applied.map((entry) =>
      [3, 4].includes(entry.id)
        ? { ...entry, restoredAt: now.toISOString() }
        : entry
    );
    record.partial = record.partial?.filter(
      (entry) => ![3, 4].includes(entry.id)
    );
    writeRecord(home, record);
    const generation: Generation = {
      generation: randomUUID(),
      at: now.toISOString(),
      consumed: [...consumed],
      destinations,
    };
    writeFileAtomic(
      journal,
      generations.map((g) => JSON.stringify(g) + "\n").join("") +
        JSON.stringify(generation) +
        "\n",
      nodeIo
    );
  }
  return result;
};
export const restoreLegacyFiles = async (
  base: string
): Promise<RestoreResult[]> => {
  const results: RestoreResult[] = [];
  for (const home of profileHomes(base))
    results.push(await restoreLegacyHome(home));
  return results;
};
import path from "node:path";

/**
 * The old renderer's durable state (`userData/renderer-state.json`) mapped
 * onto the prefs row (spec 00 C.4). One mapping, three import points: the
 * one-time migration step (`migrations/steps/002-*`), the live legacy sync
 * below (transition only; removed with the old renderer), and the final
 * import at cut-over.
 *
 * Several legacy keys can feed one prefs field (`sidebar` takes `pinned` from
 * `local-code-ui-store` and `openSection` from `sidebar-accordion`), so a
 * field is always composed from every key the old renderer holds, over the
 * field's defaults. That is also what the old renderer shows: a key it does
 * not hold means that part is at its default.
 *
 * Merges go by provenance through `PrefsStore.importLegacy` and
 * `resetLegacy`, never by default-equality. `renderer-state.json` is only
 * ever read here.
 */
import * as v from "valibot";

import { PrefsPatchSchema } from "#shared/contract/db";
import {
  SUPPORTED_LANGUAGES,
  type PrefsField,
  type PrefsPatch,
} from "#shared/contract/rows";

import { PREFS_DEFAULTS, type PrefsStore } from "./prefs-store";
import { readRendererStateFile } from "./renderer-state";
import { readRetiredPrefs, RETIRED_PREFS_FILE } from "./retired-prefs";

/** Every legacy key that maps to something, and the prefs fields it feeds. */
export const LEGACY_PREFS_KEYS: ReadonlyMap<string, readonly PrefsField[]> =
  new Map<string, readonly PrefsField[]>([
    ["theme", ["theme"]],
    ["abacusai-bot-language", ["language"]],
    [
      "local-code-ui-store",
      [
        "sidebar",
        "models",
        "defaultMode",
        "workspaceExpanded",
        "pinned",
        "lastPickedWorkspaceId",
      ],
    ],
    ["sidebar-accordion", ["sidebar"]],
    ["abacus-credits", ["creditsExhaustedAt"]],
    ["abacusai-bot-code-folder", ["recentFolders"]],
    ["browser.homepage", ["browserHomepage"]],
    ["onboarding.step", ["onboardingStep", "onboardingFlow"]],
    ["referral-card.dismissed-until", ["dismissals"]],
    ["local-code:upsell-dismissed", ["dismissals"]],
  ]);

/** The prefs fields any legacy key feeds, in row order. */
export const LEGACY_PREFS_FIELDS: readonly PrefsField[] = (
  Object.keys(PREFS_DEFAULTS) as PrefsField[]
).filter((field) =>
  Array.from(LEGACY_PREFS_KEYS.values()).some((fields) =>
    fields.includes(field)
  )
);

/** Object fields that several keys fill member by member. */
const MEMBER_FIELDS = new Set<PrefsField>([
  "sidebar",
  "models",
  "pinned",
  "dismissals",
]);

/** What one legacy key says about the fields it feeds. */
export interface LegacyKeyMapping {
  /**
   * Per field: the whole value, or for a member field (`sidebar`, `models`,
   * `pinned`, `dismissals`) the members this key holds. Members the key does
   * not hold take the field's defaults, as the old renderer's zustand merge
   * does.
   */
  values: Partial<Record<PrefsField, unknown>>;
  /** Fields the key names but whose stored value is unusable. */
  invalid: PrefsField[];
}

/**
 * The old renderer's onboarding screens (`onboarding-steps.ts` `STEP_ORDER`;
 * `legacy-prefs.test.ts` checks they match). A stored step outside it reads
 * as none there.
 */
export const LEGACY_ONBOARDING_STEPS: readonly string[] = [
  "auth",
  "welcome",
  "connectors",
  "models",
  "explainer",
];

/**
 * A legacy step id in the new renderer's vocabulary (spec 06 F10, §23.6).
 * Both vocabularies contain `"welcome"` with different meanings, so the
 * import translates before it writes, and marks the row `onboardingFlow = 2`
 * alongside; a step outside the legacy order reads as none.
 */
export const CANONICAL_ONBOARDING_STEPS: Readonly<Record<string, string>> = {
  auth: "welcome",
  welcome: "connected",
  connectors: "connectors",
  models: "models",
  explainer: "first-bot",
};

/** The onboarding vocabulary `onboardingFlow = 2` marks. */
export const ONBOARDING_FLOW = 2;

export const canonicalOnboardingStep = (legacy: string): string | null =>
  LEGACY_ONBOARDING_STEPS.includes(legacy)
    ? (CANONICAL_ONBOARDING_STEPS[legacy] ?? null)
    : null;

/**
 * `browser-homepage.ts`'s `normalizeBrowserHomepage` for a non-blank value
 * (the test checks they agree): a bare host gains `https://`, anything but
 * http(s) is null (the default).
 */
export const normalizeBrowserHomepage = (value: string): string | null => {
  const trimmed = value.trim();
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Drops members zustand would not have (absent, so the default applies). */
const defined = (members: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(members).filter(([, value]) => value !== undefined)
  );

/**
 * A zustand `persist()` value, `{ state, version }`. `version` is what the
 * store declares; a stored version that differs, for a store without
 * `migrate`, is discarded by zustand, so it holds nothing.
 */
const zustandState = (
  raw: string,
  storeVersion: number | null
): Record<string, unknown> | "invalid" | "absent" => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return "invalid";
  // zustand compares `stored.version !== options.version`, so a missing
  // version is a mismatch too, and without `migrate` the value is dropped.
  if (storeVersion !== null && parsed.version !== storeVersion) return "absent";
  return parsed.state;
};

const fromZustand = (
  raw: string,
  fields: readonly PrefsField[],
  storeVersion: number | null,
  map: (state: Record<string, unknown>) => LegacyKeyMapping["values"]
): LegacyKeyMapping | null => {
  const state = zustandState(raw, storeVersion);
  if (state === "absent") return null;
  if (state === "invalid") return { values: {}, invalid: [...fields] };
  return { values: map(state), invalid: [] };
};

/** `local-code-ui-store` (code-store.ts, version 4 with `migrate`). */
const mapCodeStore = (
  state: Record<string, unknown>
): LegacyKeyMapping["values"] => {
  // code-store.ts's migrate only deletes fields (isRightPanelVisible,
  // activeRightTab below 3; workspaceSelectedModes below 4) that map to
  // nothing, so every version reads the same way. `codeSidebarTab` is dropped:
  // the new renderer has no equivalent.
  const values: LegacyKeyMapping["values"] = {
    sidebar: defined({ pinned: state.isSidebarVisible }),
    models: defined({
      selectedModelId: state.selectedModelId,
      favoriteModelIds: state.favoriteModelIds,
      perWorkspace: state.workspaceSelectedModelIds,
    }),
    pinned: defined({
      sessionIds: state.pinnedSessionIds,
      botIds: state.pinnedBotIds,
    }),
  };
  if (state.globalSelectedMode !== undefined)
    values.defaultMode = state.globalSelectedMode;
  if (state.workspaceAccordionExpanded !== undefined)
    values.workspaceExpanded = state.workspaceAccordionExpanded;
  if (state.lastPickedWorkspaceId !== undefined)
    values.lastPickedWorkspaceId = state.lastPickedWorkspaceId;
  return values;
};

/**
 * One legacy key's contribution, or null when the key maps to nothing (or
 * holds nothing the old renderer would read). Pure; never throws.
 */
export const mapLegacyKey = (
  key: string,
  raw: string
): LegacyKeyMapping | null => {
  const fields = LEGACY_PREFS_KEYS.get(key);
  if (fields === undefined) return null;
  switch (key) {
    case "theme":
      return raw === "light" || raw === "dark" || raw === "system"
        ? { values: { theme: raw }, invalid: [] }
        : { values: {}, invalid: ["theme"] };
    case "abacusai-bot-language": {
      // As i18n.ts's storedLanguage: an explicit supported code wins; anything
      // else (corrupt, unsupported) falls through to the OS languages, which
      // is the row's "system". The version is not checked there either.
      let code: unknown;
      try {
        const parsed = JSON.parse(raw) as unknown;
        code =
          isRecord(parsed) && isRecord(parsed.state)
            ? parsed.state.languageCode
            : undefined;
      } catch {
        code = undefined;
      }
      const supported = (SUPPORTED_LANGUAGES as readonly unknown[]).includes(
        code
      );
      return {
        values: { language: supported ? code : "system" },
        invalid: [],
      };
    }
    case "local-code-ui-store":
      return fromZustand(raw, fields, null, mapCodeStore);
    case "sidebar-accordion":
      return fromZustand(raw, fields, 0, (state) => ({
        sidebar: defined({ openSection: state.openSection }),
      }));
    case "abacus-credits":
      return fromZustand(raw, fields, 0, (state) =>
        state.exhaustedAt === undefined
          ? {}
          : { creditsExhaustedAt: state.exhaustedAt }
      );
    case "abacusai-bot-code-folder":
      // `currentFolder` is dropped: the URL owns location in the new renderer.
      return fromZustand(raw, fields, 0, (state) =>
        state.recentFolders === undefined
          ? {}
          : { recentFolders: state.recentFolders }
      );
    case "browser.homepage": {
      // As browser-homepage.ts's getBrowserHomepage: blank or not http(s)
      // shows the default (the row's null); anything else is normalised.
      const normalized =
        raw.trim() === "" ? null : normalizeBrowserHomepage(raw);
      return { values: { browserHomepage: normalized }, invalid: [] };
    }
    case "onboarding.step": {
      // As onboarding-flow.tsx: a step it does not know reads as none. A
      // known one is written in the new vocabulary, with its flow marker.
      const step = canonicalOnboardingStep(raw);
      return {
        values: {
          onboardingStep: step,
          onboardingFlow: step == null ? null : ONBOARDING_FLOW,
        },
        invalid: [],
      };
    }
    case "referral-card.dismissed-until": {
      const until = Number(raw);
      return Number.isFinite(until)
        ? { values: { dismissals: { referralCardUntil: until } }, invalid: [] }
        : { values: {}, invalid: ["dismissals"] };
    }
    case "local-code:upsell-dismissed":
      // Presence is the flag (credits-exhausted-card.tsx).
      return { values: { dismissals: { upsell: true } }, invalid: [] };
    default:
      return null;
  }
};

/** The legacy state composed into prefs fields. */
export interface LegacyPrefs {
  /** Fields with a usable legacy value, validated. */
  patch: PrefsPatch;
  /** Fields the old renderer holds nothing for (it shows their defaults). */
  absent: PrefsField[];
  /** Fields it holds something unusable for; left at their current value. */
  invalid: PrefsField[];
  /**
   * Member fields with some unusable keys and some usable ones: imported
   * from the usable ones (in `patch`), and counted as invalid.
   */
  invalidMembers: PrefsField[];
  /** The mapped keys present. */
  keys: string[];
}

const FIELD_SCHEMAS = PrefsPatchSchema.entries;

/**
 * What the old renderer shows for a member no key holds. Only one differs
 * from the prefs default: a fresh old sidebar opens Bots
 * (sidebar-accordion-store.ts), while the new row starts with none.
 */
const legacyBase = (field: PrefsField): unknown =>
  field === "sidebar"
    ? { ...PREFS_DEFAULTS.sidebar, openSection: "bots" }
    : PREFS_DEFAULTS[field];

/**
 * Composes `fields` from every legacy key `read` returns a value for. Keys
 * are applied in `LEGACY_PREFS_KEYS` order.
 */
export const composeLegacyPrefs = (
  read: (key: string) => string | undefined,
  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS
): LegacyPrefs => {
  const result: LegacyPrefs = {
    patch: {},
    absent: [],
    invalid: [],
    invalidMembers: [],
    keys: [],
  };
  const mappings: LegacyKeyMapping[] = [];
  for (const key of LEGACY_PREFS_KEYS.keys()) {
    const raw = read(key);
    if (raw === undefined) continue;
    const mapping = mapLegacyKey(key, raw);
    if (mapping == null) continue;
    result.keys.push(key);
    mappings.push(mapping);
  }
  for (const field of fields) {
    const contributing = mappings.filter(
      (mapping) => field in mapping.values || mapping.invalid.includes(field)
    );
    if (contributing.length === 0) {
      result.absent.push(field);
      continue;
    }
    const valid = contributing.filter(
      (mapping) => !mapping.invalid.includes(field)
    );
    // A scalar field with any unusable key, or a member field whose every
    // key is unusable, is left at its current value. A member field keeps
    // what its usable keys hold: the old renderer shows the base for the
    // members an unusable key would have held (zustand drops a corrupt
    // store; `Number("abc")` hides nothing).
    if (
      valid.length === 0 ||
      (!MEMBER_FIELDS.has(field) && valid.length < contributing.length)
    ) {
      result.invalid.push(field);
      continue;
    }
    if (valid.length < contributing.length) result.invalidMembers.push(field);
    let value: unknown = structuredClone(legacyBase(field));
    for (const mapping of valid) {
      const part = mapping.values[field];
      value =
        MEMBER_FIELDS.has(field) && isRecord(value) && isRecord(part)
          ? { ...value, ...part }
          : part;
    }
    if (!v.safeParse(FIELD_SCHEMAS[field], value).success) {
      result.invalid.push(field);
      continue;
    }
    (result.patch as Record<string, unknown>)[field] = value;
  }
  return result;
};

export interface LegacyImportStats {
  /** Mapped keys present in the legacy state. */
  keys: number;
  /** Fields that took a legacy value (changed or not). */
  imported: number;
  /** Fields left alone because the user set them in the new UI. */
  keptUser: number;
  /** Fields with an unusable legacy value, left at their current value. */
  invalid: number;
  /** Legacy-sourced fields reset to their defaults (their keys are gone). */
  reset: number;
}

/**
 * Brings `fields` of the prefs row in line with the legacy state, by
 * provenance: a `"user"` field is never touched; a field with a legacy value
 * takes it and becomes `"legacy"`; a `"legacy"` field whose keys are gone
 * goes back to its default.
 */
export const importLegacyPrefs = (
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  read: (key: string) => string | undefined,
  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS,
  retiredKeys: ReadonlySet<string> = new Set()
): LegacyImportStats => {
  const legacy = composeLegacyPrefs(read, fields);
  const provenance = prefs.provenance();
  const named = Object.keys(legacy.patch) as PrefsField[];
  // Provenance is per leaf; a field counts as kept when any leaf of it is
  // the user's (the import skips exactly those leaves).
  const keptUser = named.filter((field) =>
    Object.entries(provenance).some(
      ([leaf, mark]) =>
        mark === "user" && (leaf === field || leaf.startsWith(`${field}.`))
    )
  );
  const { invalid } = prefs.importLegacy(legacy.patch);
  const reset = prefs.resetLegacy(
    legacy.absent.filter(
      (field) =>
        !Array.from(LEGACY_PREFS_KEYS).some(
          ([key, mapped]) =>
            mapped.includes(field) &&
            read(key) === undefined &&
            retiredKeys.has(key)
        )
    )
  );
  return {
    keys: legacy.keys.length,
    imported: named.length - keptUser.length - invalid,
    keptUser: keptUser.length,
    invalid: legacy.invalid.length + legacy.invalidMembers.length + invalid,
    reset: reset.length,
  };
};

/**
 * The old renderer's sound opt-out lives in `config.json`
 * (`notificationSoundDisabled`, `settings.ts` `readNotificationSettings`),
 * not in its durable state (spec 05 §31.5 i). An opt-out is imported into
 * `sounds.enabled = false` as `"legacy"`; once it is lifted, a legacy-sourced
 * `false` goes back to the default. A `"user"` leaf is never touched.
 * Returns what happened.
 */
export const importLegacySoundOptOut = (
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  soundDisabled: unknown
): "imported" | "kept-user" | "reset" | "none" => {
  const mark = prefs.provenance()["sounds.enabled"];
  if (mark === "user") return soundDisabled === true ? "kept-user" : "none";
  if (soundDisabled === true) {
    prefs.importLegacy({ sounds: { enabled: false } });
    return "imported";
  }
  if (mark !== "legacy") return "none";
  // Only `sounds.enabled` is ever legacy-sourced, so resetting the group's
  // legacy leaves resets exactly it.
  prefs.resetLegacy(["sounds"]);
  return "reset";
};

/** Read-only startup import kept through release N, including after N+1. */
export const importLegacyPrefsAtStartup = (
  source: string,
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">
): LegacyImportStats => {
  const legacy = readRendererStateFile(source);
  const retired = readRetiredPrefs(
    path.join(path.dirname(source), RETIRED_PREFS_FILE)
  );
  return importLegacyPrefs(
    prefs,
    (key) => legacy.get(key),
    LEGACY_PREFS_FIELDS,
    new Set(Object.keys(retired?.keys ?? {}))
  );
};
/**
 * The registered steps, by id (spec 00 C.2, C.5). Ids are never reused or
 * renumbered:
 * - 1 `transcripts-v2`: transcripts v1 → `threads/<id>.json` (C.3).
 * - 2 `prefs-from-renderer-state` (C.4).
 * - 3 `final-legacy-prefs-import-and-drop`, 4 `archive-transcripts-v1`:
 *   reserved for release N+1 (C.5). Step 4 is written
 *   (`004-archive-transcripts-v1.ts`) and registered only in its test.
 * - 5 `routine-attempt-ids`: stable ids, kinds and sessions for the routine
 *   history entries in `cronjobs.json` (spec 05 §31.5 f).
 */
import type { MigrationStep } from "../types";
import { transcriptsV2 } from "./001-transcripts-v2";
import { prefsFromRendererState } from "./002-prefs-from-renderer-state";
import { routineAttemptIds } from "./005-routine-attempt-ids";

export const MIGRATION_STEPS: readonly MigrationStep[] = [
  transcriptsV2(),
  prefsFromRendererState(),
  routineAttemptIds(),
];
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * The one-time, versioned migration runner (spec 00 C.1). Runs in main
 * inside `whenReady`, after the single-instance lock and before any service
 * reads the files it migrates.
 *
 * On launch it first settles every attempt a previous launch left in
 * `.migrating/` (see "Recovery" below). Then each step not yet in
 * `migrations.json` runs in ascending id: it plans (staging every output),
 * then the runner commits the plan:
 * 1. back up every `replace-user` destination (with its hash);
 * 2. write `commit.journal` (the plan and a unique attempt id) once;
 * 3. move each staged file onto its destination and each removal into the
 *    backup directory, appending a `done` line to `commit.log` after each,
 *    and yielding to the event loop every `yieldEvery` moves;
 * 4. append the record entry (with the attempt id), then a `recorded` line;
 * 5. delete the staging, journal first.
 *
 * Recovery, per staging directory, after reading and validating every
 * journal (nothing is touched before):
 * - no journal: the attempt died before committing; staging is discarded;
 * - the attempt is recorded (record entry with its step and attempt, or a
 *   `recorded` log line): it finished; staging is discarded;
 * - otherwise it is rolled back (`rollback`), then the journal is deleted,
 *   then its backups, then the staging. Once the journal is gone the
 *   attempt is over, so a crash after that leaves only an orphan backup;
 * - a journal that is unreadable or invalid, or a rollback that fails, or a
 *   record that cannot be trusted to judge it: the attempt is **unresolved**.
 *   Its files are kept as they are, no step runs, and `unresolved` lists the
 *   destinations it may cover (null: unknown, so all) so startup can keep
 *   writers off them (`isWriteBlocked`). The app still starts.
 *
 * A failure in this launch is recorded as `lastFailure` and stops the run;
 * the next launch retries from that step. `runMigrations` never throws.
 * Applied steps are never rolled back automatically.
 */
import {
  completeAttempt,
  completedAttempts,
  rebuildRestoreIndex,
  writeAttemptManifest,
} from "./attempt-records";
import {
  backupDirName,
  backupPathFor,
  backupsRoot,
  copyFileAtomic,
  exists,
  formatStamp,
  isAbsentError,
  migratingRoot,
  moveFile,
  nodeIo,
  pruneBackups,
  sha256File,
  type MigrationIo,
} from "./backup";
import {
  appendLog,
  destinationsOf,
  isDestination,
  JOURNAL_VERSION,
  journalFile,
  logFile,
  readJournal,
  rollback,
  writeJournal,
  type CommitJournal,
  type JournalLog,
} from "./journal";
import {
  backupOf,
  recordsAttempt,
  readRecordState,
  setAsideCorruptRecord,
  writeRecord,
  type AppliedMigration,
  type MigrationRecord,
} from "./record";
import type { MigrationContext, MigrationPlan, MigrationStep } from "./types";

/**
 * Test seams for the commit. Throwing is a failure in this launch (undone
 * at once); returning `"crash"` stops the runner dead, as a `SIGKILL` would,
 * leaving the journal and staging for the next launch. The filesystem-level
 * crash harness (`runner.crash.test.ts`) uses `io` instead.
 */
export interface CommitHooks {
  /** After the `index`th write's move (0-based) and its log line. */
  afterMove?: (index: number, dest: string) => void | "crash";
  /** After every move, before the record entry. */
  beforeRecord?: () => void | "crash";
  /** After the record entry, before the staging is deleted. */
  afterRecord?: () => void | "crash";
}

export interface RunMigrationsOptions {
  home: string;
  userData: string;
  appVersion: string;
  steps: readonly MigrationStep[];
  /** Ids to run again (`--rerun-migration`, unpackaged), after recovery. */
  rerun?: readonly number[];
  now?: () => Date;
  log?: (message: string) => void;
  /** Overall progress across the steps that run. */
  onProgress?: (done: number, total: number, label: string) => void;
  hooks?: CommitHooks;
  /** The filesystem (tests inject crashes and cross-volume renames). */
  io?: MigrationIo;
  /** A fresh id per commit attempt (tests only). */
  attemptId?: () => string;
  /** Moves between event-loop yields during a commit or rollback (20). */
  yieldEvery?: number;
}

export interface UnresolvedAttempt {
  staging: string;
  id: number | null;
  name: string | null;
  /**
   * Every path the attempt may have changed, or null when that is unknown
   * (the journal cannot be read), which blocks every destination.
   */
  destinations: string[] | null;
  error: string;
}

export interface RunMigrationsResult {
  /** Ids committed and recorded in this run. */
  applied: number[];
  /** Ids committed in this run with work left (`plan.pending`): not recorded. */
  partial: number[];
  failed: { id: number; name: string; error: string } | null;
  /** Staging directories found on launch, with what was done to them. */
  recovered: {
    staging: string;
    action: "undone" | "discarded" | "finished";
  }[];
  /**
   * Attempts left as found because recovering them was not safe. While any
   * is listed, writers must stay off its destinations (`isWriteBlocked`).
   */
  unresolved: UnresolvedAttempt[];
  /** The record was written by a newer build: nothing ran or was written. */
  skipped?: "newer-record";
  /** A hook asked for a simulated crash (tests only). */
  crashed?: boolean;
}

/**
 * Whether `file` may be covered by an unresolved commit. A writer that
 * finds it blocked must not write it this launch (the next launch's
 * rollback could otherwise overwrite that write, or be defeated by it).
 */
export const isWriteBlocked = (
  result: Pick<RunMigrationsResult, "unresolved"> | null,
  file: string
): boolean => {
  if (result == null) return false;
  const target = path.resolve(file);
  return result.unresolved.some(
    (attempt) =>
      attempt.destinations == null || attempt.destinations.includes(target)
  );
};

class SimulatedCrash extends Error {}

/** Share of a step's progress given to `plan()`; the commit gets the rest. */
const PLAN_SHARE = 0.8;

/**
 * Partial commits in a row whose `pending` did not go down before the step
 * is recorded as applied as it stands (so a step never reruns forever).
 */
export const MAX_STALLED_PARTIALS = 2;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stagingFor = (home: string, step: MigrationStep): string =>
  path.join(migratingRoot(home), `${step.id}-${step.name}`);

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const STAGING_NAME = /^(\d+)-([a-z0-9-]+)$/;

export const runMigrations = async (
  options: RunMigrationsOptions
): Promise<RunMigrationsResult> => {
  const io = options.io ?? nodeIo;
  const now = options.now ?? (() => new Date());
  const newAttempt =
    options.attemptId ?? (() => randomBytes(8).toString("hex"));
  const yieldEvery = Math.max(1, options.yieldEvery ?? 20);
  const log =
    options.log ??
    ((message: string) => console.log(`[migrations] ${message}`));
  const result: RunMigrationsResult = {
    applied: [],
    partial: [],
    failed: null,
    recovered: [],
    unresolved: [],
  };
  const { home, userData } = options;

  const removeStaging = (staging: string): void => {
    // The journal goes first: staging without a journal is only discarded.
    io.rmSync(journalFile(staging));
    io.rmSync(staging, { recursive: true });
  };

  const recordState = readRecordState(home, io);
  /** Null while the record cannot be trusted or written. */
  let record: MigrationRecord | null =
    recordState.status === "ok" || recordState.status === "missing"
      ? recordState.record
      : null;

  const fail = (
    step: { id: number; name: string },
    error: unknown
  ): RunMigrationsResult => {
    const message = errorMessage(error);
    log(`step ${step.id} ${step.name} failed: ${message}`);
    result.failed = { id: step.id, name: step.name, error: message };
    if (record == null) return result;
    record.lastFailure = {
      id: step.id,
      name: step.name,
      at: now().toISOString(),
      error: message,
    };
    try {
      writeRecord(home, record, io);
    } catch (writeError) {
      log(`cannot record the failure: ${errorMessage(writeError)}`);
    }
    return result;
  };

  // ── Recovery ─────────────────────────────────────────────────────────
  let entries: string[] = [];
  try {
    entries = io.readdirSync(migratingRoot(home)).sort();
  } catch (error) {
    if (!isAbsentError(error))
      result.unresolved.push({
        staging: migratingRoot(home),
        id: null,
        name: null,
        destinations: null,
        error: `cannot list: ${errorMessage(error)}`,
      });
  }

  // Read and validate everything before touching anything.
  const inspected = entries.map((entry) => {
    const staging = path.join(migratingRoot(home), entry);
    const named = STAGING_NAME.exec(entry);
    return {
      staging,
      id: named == null ? null : Number(named[1]),
      name: named == null ? null : (named[2] ?? null),
      read: readJournal({ home, userData, staging }, io),
    };
  });

  if (recordState.status === "newer") {
    // A later build's record: judge nothing, write nothing.
    log(
      `migrations.json is version ${recordState.version}, newer than this build; running nothing`
    );
    result.skipped = "newer-record";
    for (const attempt of inspected)
      if (attempt.read.status !== "missing")
        result.unresolved.push({
          staging: attempt.staging,
          id: attempt.id,
          name: attempt.name,
          destinations:
            attempt.read.status === "ok"
              ? destinationsOf(attempt.read.journal)
              : null,
          error: "left for the newer build",
        });
    return result;
  }

  const unresolve = (
    attempt: (typeof inspected)[number],
    destinations: string[] | null,
    error: string
  ) => {
    log(`${path.basename(attempt.staging)}: unresolved, kept: ${error}`);
    result.unresolved.push({
      staging: attempt.staging,
      id: attempt.id,
      name: attempt.name,
      destinations,
      error,
    });
  };

  for (const attempt of inspected) {
    const { staging, read } = attempt;
    const entry = path.basename(staging);
    if (read.status === "missing") {
      try {
        removeStaging(staging);
      } catch (error) {
        log(`cannot delete ${staging}: ${errorMessage(error)}`);
      }
      result.recovered.push({ staging, action: "discarded" });
      continue;
    }
    if (read.status !== "ok") {
      unresolve(attempt, null, `${read.status} journal: ${read.error}`);
      continue;
    }
    const { journal } = read;
    const finished =
      read.log.recorded ||
      (record != null && recordsAttempt(record, journal.id, journal.attempt));
    if (finished) {
      // Only the staging's deletion was cut short.
      try {
        // Older journals predate retained records; they remain recoverable.
        if (exists(path.join(journal.backupDir, "attempt.json"), io)) {
          const partial =
            record?.partial?.some(
              (entry) => entry.attempt === journal.attempt
            ) ?? false;
          completeAttempt(
            journal.backupDir,
            journal.attempt,
            partial,
            now().toISOString(),
            io
          );
        }
        removeStaging(staging);
      } catch (error) {
        unresolve(
          attempt,
          destinationsOf(journal),
          `completion failed: ${errorMessage(error)}`
        );
        continue;
      }
      result.recovered.push({ staging, action: "finished" });
      continue;
    }
    if (record == null) {
      unresolve(
        attempt,
        destinationsOf(journal),
        `the record is ${recordState.status}, so whether this commit finished is unknown`
      );
      continue;
    }
    try {
      const undone = await undo(staging, journal, read.log);
      log(
        `${entry}: undid an interrupted commit (restored ${undone.restored.length}, deleted ${undone.deleted.length}, kept ${undone.kept.length})`
      );
      result.recovered.push({ staging, action: "undone" });
    } catch (error) {
      unresolve(
        attempt,
        destinationsOf(journal),
        `rollback failed: ${errorMessage(error)}`
      );
    }
  }

  if (result.unresolved.length > 0) {
    const first = result.unresolved[0];
    return fail(
      { id: first?.id ?? 0, name: first?.name ?? "recovery" },
      new Error(`recovery failed: ${first?.error ?? "unknown"}`)
    );
  }

  if (recordState.status === "unreadable")
    return fail(
      { id: 0, name: "record" },
      new Error(`cannot read migrations.json: ${recordState.error}`)
    );
  if (recordState.status === "corrupt") {
    try {
      const aside = setAsideCorruptRecord(home, now(), io);
      log(
        `migrations.json is corrupt (${recordState.error}); kept as ${aside}`
      );
    } catch (error) {
      return fail({ id: 0, name: "record" }, error);
    }
    record = { version: 1, applied: [] };
  }
  // Non-null from here: missing, ok, or a corrupt one set aside.
  let current: MigrationRecord = record ?? { version: 1, applied: [] };
  record = current;

  // `--rerun-migration`, only now that every attempt is settled.
  if (options.rerun != null && options.rerun.length > 0) {
    const rerun = new Set(options.rerun);
    const before = current.applied.length;
    const next = {
      ...current,
      applied: current.applied.filter((entry) => !rerun.has(entry.id)),
    };
    if (next.applied.length !== before) {
      try {
        writeRecord(home, next, io);
      } catch (error) {
        return fail({ id: 0, name: "record" }, error);
      }
      current = next;
      record = current;
      log(`rerunning ${[...rerun].join(", ")}`);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────
  const appliedIds = new Set(
    current.applied
      .filter((entry) => !entry.restoredAt)
      .map((entry) => entry.id)
  );
  const pending = [...options.steps]
    .sort((a, b) => a.id - b.id)
    .filter((step) => !appliedIds.has(step.id));

  for (const [index, step] of pending.entries()) {
    const attempt = newAttempt();
    const staging = stagingFor(home, step);
    const started = Date.now();
    const fraction = (share: number, label?: string) => {
      options.onProgress?.(
        index * 1000 + Math.round(Math.min(1, Math.max(0, share)) * 1000),
        pending.length * 1000,
        label ?? step.name
      );
    };
    const report = (done: number, total: number, label?: string) => {
      fraction(total > 0 ? (done / total) * PLAN_SHARE : 0, label);
    };

    let plan: MigrationPlan;
    try {
      removeStaging(staging);
      io.mkdirSync(staging);
      const context: MigrationContext = {
        attempt,
        home,
        userData,
        appVersion: options.appVersion,
        staging,
        progress: report,
        log: (message) => log(`${step.id} ${step.name}: ${message}`),
      };
      report(0, 1);
      plan = await step.plan(context);
      validatePlan(plan, staging, { home, userData }, io);
    } catch (error) {
      try {
        removeStaging(staging);
      } catch (cleanupError) {
        log(`cannot delete ${staging}: ${errorMessage(cleanupError)}`);
      }
      return fail(step, error);
    }

    const commit = formatStamp(now());
    const backupName = backupDirName(commit, step.id, step.name, attempt);
    const journal: CommitJournal = {
      version: JOURNAL_VERSION,
      attempt,
      id: step.id,
      name: step.name,
      commit,
      backupDir: path.join(backupsRoot(home), backupName),
      writes: [],
      removals: [],
    };
    let journaled = false;
    let partial = false;
    try {
      // 1. Back up what may hold data found nowhere else.
      const roots = { home, userData };
      for (const write of plan.writes) {
        const present = exists(write.dest, io);
        // A `create` whose destination appeared since the plan is treated as
        // user data: never replaced without a copy. A `replace-user` whose
        // destination is gone has nothing to keep.
        const kind =
          write.kind === "create" && present
            ? "replace-user"
            : write.kind === "replace-user" && !present
              ? "create"
              : write.kind;
        if (kind !== "replace-user") {
          journal.writes.push({
            ...write,
            kind,
            backup: null,
            originalHash: null,
            stagedHash: null,
          });
          continue;
        }
        const backup = backupPathFor(journal.backupDir, write.dest, roots);
        const originalHash = sha256File(write.dest, io);
        copyFileAtomic(write.dest, backup, io);
        if (sha256File(backup, io) !== originalHash)
          throw new Error(`${write.dest} changed while it was backed up`);
        journal.writes.push({
          ...write,
          kind,
          backup,
          originalHash,
          stagedHash: sha256File(write.staged, io),
        });
      }
      for (const removal of plan.removals) {
        if (!exists(removal, io)) continue;
        journal.removals.push({
          path: removal,
          backup: backupPathFor(journal.backupDir, removal, roots),
        });
      }
      // 2. The journal, once.
      writeJournal(staging, journal, io);
      journaled = true;
      writeAttemptManifest(journal, roots, io);
      // 3. Moves, each followed by an appended `done`.
      const total = journal.writes.length + journal.removals.length;
      let moved = 0;
      const progressed = async () => {
        moved += 1;
        if (moved % yieldEvery === 0) {
          fraction(PLAN_SHARE + (1 - PLAN_SHARE) * (moved / total));
          await tick();
        }
      };
      for (const [i, write] of journal.writes.entries()) {
        moveFile(write.staged, write.dest, io);
        appendLog(
          staging,
          attempt,
          { op: "done", target: "write", index: i },
          io
        );
        if (options.hooks?.afterMove?.(i, write.dest) === "crash")
          throw new SimulatedCrash();
        await progressed();
      }
      for (const [i, removal] of journal.removals.entries()) {
        moveFile(removal.path, removal.backup, io);
        appendLog(
          staging,
          attempt,
          { op: "done", target: "removal", index: i },
          io
        );
        await progressed();
      }
      if (options.hooks?.beforeRecord?.() === "crash")
        throw new SimulatedCrash();
      // 4. The record, then its mark in the log. A plan that left work for
      // the next launch (`pending`) is recorded as a partial commit: final
      // (never rolled back), but the step is not applied, so it runs again.
      // A step whose pending work stops going down is applied as it stands
      // after `MAX_STALLED_PARTIALS` such commits, so it never reruns
      // forever (what it could not do stays where it was, untouched).
      const pending = plan.pending ?? 0;
      const others = (current.partial ?? []).filter(
        (entry) => entry.id !== step.id
      );
      const previous = current.partial?.find((entry) => entry.id === step.id);
      const stalled =
        pending > 0 && previous != null && pending >= previous.pending
          ? previous.stalled + 1
          : 0;
      partial = pending > 0 && stalled < MAX_STALLED_PARTIALS;
      const next: MigrationRecord = { ...current };
      if (partial) {
        next.partial = [
          ...others,
          {
            id: step.id,
            name: step.name,
            at: now().toISOString(),
            commit,
            attempt,
            backup: backupName,
            pending,
            stalled,
          },
        ];
      } else {
        if (pending > 0)
          log(
            `${step.id} ${step.name}: ${pending} left after ${stalled + 1} commits without progress; recording it as applied`
          );
        const entry: AppliedMigration = {
          id: step.id,
          name: step.name,
          appliedAt: now().toISOString(),
          appVersion: options.appVersion,
          durationMs: Date.now() - started,
          stats:
            pending > 0 ? { ...plan.stats, pendingLeft: pending } : plan.stats,
          commit,
          attempt,
          backup: backupName,
        };
        next.applied = [
          ...current.applied.filter((old) => old.id !== entry.id),
          entry,
        ];
        if (others.length > 0) next.partial = others;
        else delete next.partial;
      }
      if (next.lastFailure?.id === step.id) delete next.lastFailure;
      writeRecord(home, next, io);
      current = next;
      record = current;
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        result.crashed = true;
        return result;
      }
      // Undo at once, as the next launch would.
      if (journaled) {
        try {
          // The same rollback as the next launch's: it does not depend on
          // `done`, and nothing has been undone yet.
          await undo(staging, journal, {
            done: new Set(),
            undone: new Set(),
            recorded: false,
          });
        } catch (undoError) {
          log(
            `undo of ${step.id} ${step.name} failed, left for the next launch: ${errorMessage(undoError)}`
          );
          result.unresolved.push({
            staging,
            id: step.id,
            name: step.name,
            destinations: destinationsOf(journal),
            error: `rollback failed: ${errorMessage(undoError)}`,
          });
        }
      } else {
        try {
          // Nothing was moved: only copies were made.
          io.rmSync(journal.backupDir, { recursive: true });
          removeStaging(staging);
        } catch (cleanupError) {
          log(`cannot delete ${staging}: ${errorMessage(cleanupError)}`);
        }
      }
      return fail(step, error);
    }

    // The record is the commit point. Completion failure must never undo it.
    try {
      completeAttempt(
        journal.backupDir,
        attempt,
        partial,
        now().toISOString(),
        io
      );
    } catch (error) {
      result.unresolved.push({
        staging,
        id: step.id,
        name: step.name,
        destinations: destinationsOf(journal),
        error: errorMessage(error),
      });
      return fail(step, error);
    }
    // 5. The staging. A failure here is finished on the next launch.
    try {
      appendLog(staging, attempt, { op: "recorded" }, io);
      if (options.hooks?.afterRecord?.() === "crash") {
        result.crashed = true;
        return result;
      }
      removeStaging(staging);
    } catch (error) {
      log(`cannot delete ${staging}: ${errorMessage(error)}`);
    }
    fraction(1);
    (partial ? result.partial : result.applied).push(step.id);
    log(
      `${partial ? `committed with ${plan.pending} left for the next launch:` : "applied"} ${step.id} ${step.name} in ${Date.now() - started} ms ${JSON.stringify(plan.stats)}`
    );
    if (partial) {
      log(
        `stopping after pending step ${step.id}; later steps wait for the next launch`
      );
      break;
    }
  }

  // ── Housekeeping, on every launch that got here without a failure ─────
  try {
    io.rmdirSync(migratingRoot(home));
  } catch {
    // Not empty (a staging we could not delete) or already gone.
  }
  try {
    rebuildRestoreIndex(home, io, log);
    const retained = new Set(
      completedAttempts(home, io, log)
        .filter(({ manifest }) => {
          const applied = current.applied.find(
            (entry) => entry.id === manifest.step
          );
          return (
            applied === undefined ||
            now().getTime() - Date.parse(applied.appliedAt) <= 30 * 86400000
          );
        })
        .map(({ directory }) => path.basename(directory))
    );
    const pruned = pruneBackups(home, {
      retained,
      now: now(),
      referenced: new Set([
        ...current.applied.map(backupOf),
        ...(current.partial ?? []).map((entry) => entry.backup),
      ]),
      io,
    });
    if (pruned.length > 0) {
      log(`pruned ${pruned.length} old backups`);
      rebuildRestoreIndex(home, io, log);
    }
  } catch (error) {
    log(`pruning failed: ${errorMessage(error)}`);
  }
  return result;

  /**
   * Rolls an attempt back, then ends it: the journal is deleted before its
   * backups, so no crash can leave a journal whose backups are gone.
   */
  async function undo(
    staging: string,
    journal: CommitJournal,
    journalLog: JournalLog
  ) {
    const undone = await rollback({
      staging,
      journal,
      log: journalLog,
      io,
      yieldEvery,
      note: (message) => log(`${path.basename(staging)}: ${message}`),
    });
    io.rmSync(journalFile(staging));
    try {
      io.rmSync(journal.backupDir, { recursive: true });
      io.rmSync(staging, { recursive: true });
    } catch (error) {
      // The attempt is over; what is left is an orphan, pruned by age.
      log(`cannot delete ${staging} or its backups: ${errorMessage(error)}`);
    }
    return undone;
  }
};

/**
 * Every staged file exists inside the step's staging, once; every
 * destination and removal is under the home or userData, once.
 */
const validatePlan = (
  plan: MigrationPlan,
  staging: string,
  roots: { home: string; userData: string },
  io: MigrationIo
): void => {
  if (
    plan == null ||
    !Array.isArray(plan.writes) ||
    !Array.isArray(plan.removals)
  )
    throw new Error("the step returned no plan");
  const reserved = new Set([journalFile(staging), logFile(staging)]);
  const touched = new Set<string>();
  const staged = new Set<string>();
  for (const write of plan.writes) {
    const inStaging = path.relative(staging, write.staged);
    if (
      inStaging === "" ||
      inStaging.startsWith("..") ||
      path.isAbsolute(inStaging) ||
      reserved.has(write.staged) ||
      !exists(write.staged, io)
    )
      throw new Error(`staged file ${write.staged} is not in the staging`);
    if (staged.has(write.staged))
      throw new Error(`staged file ${write.staged} is used twice`);
    staged.add(write.staged);
    if (!isDestination(write.dest, roots))
      throw new Error(
        `destination ${write.dest} is not under the home or userData`
      );
    if (touched.has(write.dest))
      throw new Error(`destination ${write.dest} is written twice`);
    touched.add(write.dest);
  }
  for (const removal of plan.removals) {
    if (!isDestination(removal, roots) || touched.has(removal))
      throw new Error(
        `removal ${removal} is not under the home or userData, or is also written`
      );
    touched.add(removal);
  }
};

exec
/bin/zsh -c 'ls /Users/rajaniraiyn/.local/share/mise/installs; cat apps/desktop/src/main/migrations/steps/index.ts; git diff 1b14bc91..75516d5f -- apps/desktop/src/main/services/updates/update-service.ts apps/desktop/src/main/services/updates/experience apps/updater/src/classify.ts .github/workflows/ci.yml .size-limit.json' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 7965ms:
acli
buf
bun
cargo-binstall
cargo-boltffi-cli
cargo-cargo-deny
cargo-cargo-machete
cargo-cargo-nextest
claude
codex
gh
git-filter-repo
git-lfs
github-getsentry-cli
github-leanprover-lean4
gradle
jq
kubectl
mr-boxington
node
npm-abacus-ai-cli
npm-agent-browser
npm-corepack
npm-tuistory
npm-typescript
pnpm
ripgrep
rtk
rust
starship
tmux
tokei
uv
xcodegen
xcodes
/**
 * The registered steps, by id (spec 00 C.2, C.5). Ids are never reused or
 * renumbered:
 * - 1 `transcripts-v2`: transcripts v1 → `threads/<id>.json` (C.3).
 * - 2 `prefs-from-renderer-state` (C.4).
 * - 3 `final-legacy-prefs-import-and-drop`, 4 `archive-transcripts-v1`:
 *   reserved for release N+1 (C.5). Step 4 is written
 *   (`004-archive-transcripts-v1.ts`) and registered only in its test.
 * - 5 `routine-attempt-ids`: stable ids, kinds and sessions for the routine
 *   history entries in `cronjobs.json` (spec 05 §31.5 f).
 */
import type { MigrationStep } from "../types";
import { transcriptsV2 } from "./001-transcripts-v2";
import { prefsFromRendererState } from "./002-prefs-from-renderer-state";
import { routineAttemptIds } from "./005-routine-attempt-ids";

export const MIGRATION_STEPS: readonly MigrationStep[] = [
  transcriptsV2(),
  prefsFromRendererState(),
  routineAttemptIds(),
];
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-21WaTOeW' (errno=Operation not permitted)
2026-10-01 15:22:00.940 xcodebuild[58615:4420090]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:22:01.366 xcodebuild[58615:4420086] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-duz4GFTs' (errno=Operation not permitted)
2026-10-01 15:22:03.940 xcodebuild[58630:4420247]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:22:04.377 xcodebuild[58630:4420246] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 20ad7171..89e95b88 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -22,10 +22,7 @@ concurrency:
   cancel-in-progress: true
 
 env:
-  # The renderer bundle (monaco, shiki, katex) no longer fits in Node's default
-  # ~2GB old-space during the transform. Without this the build dies with
-  # `FATAL ERROR: JavaScript heap out of memory` and exit 134, which names a
-  # symptom rather than a cause.
+  # Keep the existing heap cap until a final-build peak measurement is available.
   NODE_OPTIONS: --max-old-space-size=4096
   TURBO_TELEMETRY_DISABLED: 1
   ABACUS_BUILD_COMMIT: ${{ github.sha }}
@@ -85,9 +82,8 @@ jobs:
       # not exist fails here rather than in six platform jobs several minutes
       # later.
       - run: pnpm run typecheck
-      - run: pnpm run check:knip-next
+      - run: pnpm run check:knip
       - run: pnpm --filter @abacus-ai/desktop run check:ui-registry
-      - run: pnpm --filter @abacus-ai/desktop run check:legacy-diff
       - name: i18n and locale guards
         run: |
           pnpm --filter @abacus-ai/desktop run check:i18n
@@ -207,31 +203,13 @@ jobs:
           cd packages/agent
           ../../node_modules/.bin/vitest run --project e2e src/agui/agui-spawn.e2e.test.ts --testNamePattern 'same bytes on fd 3'
 
-      - name: The desktop entry still speaks NDJSON
-        shell: bash
-        run: |
-          set -uo pipefail
-          export ABACUSAI_BOT_HOME="$RUNNER_TEMP/abacusai-bot-empty"
-          output=$(echo '{"type":"send","message":"hi"}' | node packages/agent/dist/main.js 2>/dev/null | head -20)
-
-          echo "$output"
-          echo "$output" | node -e '
-            let raw = ""
-            process.stdin.on("data", chunk => { raw += chunk })
-            process.stdin.on("end", () => {
-              const events = raw.split("\n").filter(Boolean).map(line => JSON.parse(line))
-              if (events.length === 0) throw new Error("the agent emitted no protocol events")
-              if (!events.some(event => typeof event.type === "string")) throw new Error("events carry no type")
-            })
-          '
-
-  # renderer-next's screenshot gate (spec 01 §10.2) in the real Electron
+  # renderer's screenshot gate (spec 01 §10.2) in the real Electron
   # window: every route and band, the collapsed, floating, split, compact and
   # full-screen states, axe, and the Linux native-frame probe. The probe runs
   # only on Linux, so this job requires it: a run that skipped it fails
   # (ABACUSBOT_REQUIRE_NATIVE_FRAME). macOS runs record it as skipped.
-  screenshots-next:
-    name: renderer-next screenshots (Linux)
+  screenshots:
+    name: renderer screenshots (Linux)
     needs: [check]
     runs-on: ubuntu-latest
     steps:
@@ -261,7 +239,7 @@ jobs:
         working-directory: apps/desktop
         env:
           ABACUSBOT_REQUIRE_NATIVE_FRAME: "1"
-        run: xvfb-run -a --server-args="-screen 0 1920x1080x24" node scripts/screenshots-next.mjs --require-native-frame
+        run: xvfb-run -a --server-args="-screen 0 1920x1080x24" node scripts/screenshots.mjs --require-native-frame
 
   package:
     name: Package (${{ matrix.os }})
@@ -288,11 +266,12 @@ jobs:
       - name: Reject React Compiler bailouts
         run: pnpm --filter @abacus-ai/desktop run check:react-compiler
 
+      - name: Bundle budgets
+        run: pnpm --dir apps/desktop run measure:size && pnpm exec size-limit
+
       - name: Package unpacked app
         env:
-          # Without this, electron-builder picks up whatever identity happens to
-          # be in the runner keychain and fails confusingly. Unsigned is the
-          # correct outcome for a build from this repo.
+          # Use an unsigned package in public CI.
           CSC_IDENTITY_AUTO_DISCOVERY: false
         run: pnpm --filter @abacus-ai/desktop run package:dir
 
diff --git a/.size-limit.json b/.size-limit.json
index eacf93a5..1e3c2c6c 100644
--- a/.size-limit.json
+++ b/.size-limit.json
@@ -2,194 +2,127 @@
   {
     "name": "Main initial",
     "gzip": true,
+    "limit": "1310269 B",
     "path": [
-      "apps/desktop/dist/renderer/assets/next-CYZebUZ7.js",
-      "apps/desktop/dist/renderer/assets/rolldown-runtime-C0FnF6B9.js",
-      "apps/desktop/dist/renderer/assets/jsx-runtime-D3F0h15I.js",
-      "apps/desktop/dist/renderer/assets/dist-DL20HYaR.js",
-      "apps/desktop/dist/renderer/assets/path-BdFQ2FkC.js",
-      "apps/desktop/dist/renderer/assets/shim-D7SCD8Sw.js",
-      "apps/desktop/dist/renderer/assets/useSelector-DlgnKuvT.js",
-      "apps/desktop/dist/renderer/assets/matchContext-CiCn8Kl3.js",
-      "apps/desktop/dist/renderer/assets/InternalBackdrop-UtUNEptK.js",
-      "apps/desktop/dist/renderer/assets/redirect-k_XIa7GT.js",
+      "apps/desktop/dist/renderer/assets/main-BvavMJkA.js",
+      "apps/desktop/dist/renderer/assets/rolldown-runtime-Dd_uD5pT.js",
+      "apps/desktop/dist/renderer/assets/useSelector-hMeUlnhI.js",
+      "apps/desktop/dist/renderer/assets/useTranslation-C4fzJ8NF.js",
+      "apps/desktop/dist/renderer/assets/matchContext-jlmOrjiL.js",
+      "apps/desktop/dist/renderer/assets/compiler-runtime-DdEb7m_W.js",
+      "apps/desktop/dist/renderer/assets/frame-CQGisaUp.js",
+      "apps/desktop/dist/renderer/assets/spinner-DoqPDy5j.js",
+      "apps/desktop/dist/renderer/assets/redirect-AmaS3P9G.js",
       "apps/desktop/dist/renderer/assets/not-found-i5RsCZif.js",
       "apps/desktop/dist/renderer/assets/root-DLTE-HSj.js",
-      "apps/desktop/dist/renderer/assets/Match-BN5yd91N.js",
-      "apps/desktop/dist/renderer/assets/Matches-DJkyOfbH.js",
-      "apps/desktop/dist/renderer/assets/useTranslation-DzorYd_v.js",
-      "apps/desktop/dist/renderer/assets/en-US-CRczPHnt.js",
-      "apps/desktop/dist/renderer/assets/useQuery-BZjyKRtq.js",
-      "apps/desktop/dist/renderer/assets/useParams-DPofAYbO.js",
-      "apps/desktop/dist/renderer/assets/useSearch-CnHXTPLS.js",
+      "apps/desktop/dist/renderer/assets/Match-DO_EsbqY.js",
+      "apps/desktop/dist/renderer/assets/Matches-GtOcHBhM.js",
+      "apps/desktop/dist/renderer/assets/sound-DOvbnGxL.js",
+      "apps/desktop/dist/renderer/assets/chevron-down-CNmRlT3p.js",
+      "apps/desktop/dist/renderer/assets/registry-mCnq-mu5.js",
+      "apps/desktop/dist/renderer/assets/hotkey-manager-B4gkC1Bb.js",
+      "apps/desktop/dist/renderer/assets/ui-DE1RYzs3.js",
+      "apps/desktop/dist/renderer/assets/hover-card-BqHHar1V.js",
+      "apps/desktop/dist/renderer/assets/bots-qGVRGLA3.js",
+      "apps/desktop/dist/renderer/assets/messaging-BcBXMRra.js",
+      "apps/desktop/dist/renderer/assets/messaging-DGWbWN6g.js",
       "apps/desktop/dist/renderer/assets/preload-helper-HclGiUj8.js",
-      "apps/desktop/dist/renderer/assets/useFileTree-D4yUkKOZ.js",
-      "apps/desktop/dist/renderer/assets/models-D5sdXKBV.js",
-      "apps/desktop/dist/renderer/assets/dist-CbJ1Pi6q.js",
-      "apps/desktop/dist/renderer/assets/agent-types-DpG64hVY.js",
-      "apps/desktop/dist/renderer/assets/compiler-runtime-BiNu7y5K.js",
-      "apps/desktop/dist/renderer/assets/frame-BAq58oSZ.js",
-      "apps/desktop/dist/renderer/assets/spinner-NEGWP0ai.js",
-      "apps/desktop/dist/renderer/assets/sound-Bl8pVLe1.js",
-      "apps/desktop/dist/renderer/assets/registry-Ct2R9BN3.js",
-      "apps/desktop/dist/renderer/assets/MenuTrigger-BQZReVvu.js",
-      "apps/desktop/dist/renderer/assets/message-reactions-DuA2cNXA.js",
-      "apps/desktop/dist/renderer/assets/PreviewCardPopup-DjGWQJm_.js",
-      "apps/desktop/dist/renderer/assets/settings-BDhsOj2r.js",
-      "apps/desktop/dist/renderer/assets/local-models-BaVB923D.js",
-      "apps/desktop/dist/renderer/assets/react-ejPbDFI_.js",
-      "apps/desktop/dist/renderer/assets/ui-XQS48oCz.js",
-      "apps/desktop/dist/renderer/assets/turns-Cr8yGqoY.js",
-      "apps/desktop/dist/renderer/assets/pptx-BMo_D7zr.js",
-      "apps/desktop/dist/renderer/assets/connector-requests-nEPgfBMK.js",
-      "apps/desktop/dist/renderer/assets/react-resizable-panels-DstEzbWh.js",
-      "apps/desktop/dist/renderer/assets/DialogRoot-99ppRHeb.js",
-      "apps/desktop/dist/renderer/assets/AlertDialogRoot-9Yh_0l9h.js",
-      "apps/desktop/dist/renderer/assets/use-app-context-DkQ5sbuv.js",
-      "apps/desktop/dist/renderer/assets/hotkey-manager-C4G-p09N.js",
-      "apps/desktop/dist/renderer/assets/hover-card-CaMm_1dx.js",
-      "apps/desktop/dist/renderer/assets/separator-mXBQvoN8.js",
-      "apps/desktop/dist/renderer/assets/link-pl7iHhTD.js",
-      "apps/desktop/dist/renderer/assets/app-link-Dm3Zqyc_.js",
-      "apps/desktop/dist/renderer/assets/resizable-CEyjiRE5.js",
-      "apps/desktop/dist/renderer/assets/alert-dialog-BR7VVr0X.js",
-      "apps/desktop/dist/renderer/assets/ContextMenuPositioner-BdbmFkPu.js",
-      "apps/desktop/dist/renderer/assets/registry-nkyBWlrs.js",
-      "apps/desktop/dist/renderer/assets/connector-request-card-BnHpITkq.js",
-      "apps/desktop/dist/renderer/assets/dropdown-menu-BJdn6pyM.js",
-      "apps/desktop/dist/renderer/assets/sessions-os0px7b6.js",
-      "apps/desktop/dist/renderer/assets/useNavigate-CJKg9hKS.js",
-      "apps/desktop/dist/renderer/assets/route-D6up4V3B.js",
-      "apps/desktop/dist/renderer/assets/searchMiddleware-kblLhPBY.js",
-      "apps/desktop/dist/renderer/assets/fileRoute-bfjtUwe9.js",
-      "apps/desktop/dist/renderer/assets/lazyRouteComponent-CsK_9PeZ.js",
-      "apps/desktop/dist/renderer/assets/AvatarFallback-D15zY4rU.js",
-      "apps/desktop/dist/renderer/assets/check-BIlEERF8.js",
-      "apps/desktop/dist/renderer/assets/scrollable-CDceqheG.js",
-      "apps/desktop/dist/renderer/assets/useForm-CoC9DVCL.js",
-      "apps/desktop/dist/renderer/assets/field-CTpVc-Zd.js",
-      "apps/desktop/dist/renderer/assets/form-kit-C0mpthep.js",
-      "apps/desktop/dist/renderer/assets/CHANGELOG-DcO1YV3k.js",
-      "apps/desktop/dist/renderer/assets/search-B2ffgO7S.js",
-      "apps/desktop/dist/renderer/assets/tour-Nw6FiunP.js",
-      "apps/desktop/dist/renderer/assets/chevron-down-CogD4oIp.js",
-      "apps/desktop/dist/renderer/assets/confirm-BJFLW0-_.js",
-      "apps/desktop/dist/renderer/assets/bot-avatar-C8zgJzJ4.js",
-      "apps/desktop/dist/renderer/assets/bot-memory-list-vIfPsTBJ.js",
       "apps/desktop/dist/renderer/assets/log-ring-BZ2uGgM8.js",
-      "apps/desktop/dist/renderer/assets/settings-DkirLCf0.js",
-      "apps/desktop/dist/renderer/assets/useStore-DnoXlDpe.js",
-      "apps/desktop/dist/renderer/assets/messaging-CBOV8sHT.js",
-      "apps/desktop/dist/renderer/assets/empty-state-DZNRI787.js",
+      "apps/desktop/dist/renderer/assets/transition-types-kBeCKY2x.js",
+      "apps/desktop/dist/renderer/assets/separator-0BiUZ2KB.js",
+      "apps/desktop/dist/renderer/assets/useParams-edixy8GZ.js",
+      "apps/desktop/dist/renderer/assets/useSearch-BuW7dCbE.js",
+      "apps/desktop/dist/renderer/assets/dropdown-menu-0FDckRBw.js",
+      "apps/desktop/dist/renderer/assets/turns-CO8eSM_q.js",
+      "apps/desktop/dist/renderer/assets/local-models-DyqHcex1.js",
+      "apps/desktop/dist/renderer/assets/settings-BDhsOj2r.js",
+      "apps/desktop/dist/renderer/assets/connector-requests-DeJo6Fjf.js",
+      "apps/desktop/dist/renderer/assets/registry-BglAJ6CW.js",
+      "apps/desktop/dist/renderer/assets/connector-request-card-DF2vB5WK.js",
+      "apps/desktop/dist/renderer/assets/link-Ch3HzHVM.js",
+      "apps/desktop/dist/renderer/assets/app-link-DMIwPhN7.js",
+      "apps/desktop/dist/renderer/assets/resizable-BpinGj3w.js",
+      "apps/desktop/dist/renderer/assets/alert-dialog-DQZJ9_Dq.js",
+      "apps/desktop/dist/renderer/assets/sessions-Cktpx59b.js",
+      "apps/desktop/dist/renderer/assets/useNavigate-D5KOICuw.js",
+      "apps/desktop/dist/renderer/assets/fileRoute-Bk5pnR5L.js",
+      "apps/desktop/dist/renderer/assets/searchMiddleware-C0hj9KBZ.js",
+      "apps/desktop/dist/renderer/assets/lazyRouteComponent-AMenGOe8.js",
+      "apps/desktop/dist/renderer/assets/useStore-Jt_fedF3.js",
+      "apps/desktop/dist/renderer/assets/empty-state-BUK85Zdy.js",
+      "apps/desktop/dist/renderer/assets/field-PduoNJwE.js",
+      "apps/desktop/dist/renderer/assets/form-kit-D0cM1gZ0.js",
+      "apps/desktop/dist/renderer/assets/useBlocker-CXHfK7xh.js",
+      "apps/desktop/dist/renderer/assets/confirm-CUpFW1vI.js",
+      "apps/desktop/dist/renderer/assets/bot-avatar-K2XYybxl.js",
+      "apps/desktop/dist/renderer/assets/cues-BWDDQkLq.js",
+      "apps/desktop/dist/renderer/assets/routines-Jufz3BL8.js",
       "apps/desktop/dist/renderer/assets/areas-Bc_iaQJF.js",
-      "apps/desktop/dist/renderer/assets/useBlocker-Duezqq4b.js",
-      "apps/desktop/dist/renderer/assets/remember-XfSApllt.js",
-      "apps/desktop/dist/renderer/assets/bots-DdNBRmsz.js",
-      "apps/desktop/dist/renderer/assets/check-in-C8Qv0pWX.js",
-      "apps/desktop/dist/renderer/assets/cues-sdIG_3RW.js",
-      "apps/desktop/dist/renderer/assets/connector-mark-BlsHLYt2.js",
-      "apps/desktop/dist/renderer/assets/shared-element-C1DaGsh4.js",
-      "apps/desktop/dist/renderer/assets/bots-DbKPHTxe.js",
-      "apps/desktop/dist/renderer/assets/messaging-BUfBuxkX.js",
-      "apps/desktop/dist/renderer/assets/sparkles-CJfsmBxI.js",
-      "apps/desktop/dist/renderer/assets/routines-DqJY1DcI.js",
-      "apps/desktop/dist/renderer/assets/shell-Bng3TrNu.js",
-      "apps/desktop/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-aEkSWT6i.js",
-      "apps/desktop/dist/renderer/assets/triangle-alert-9MzacqwM.js",
-      "apps/desktop/dist/renderer/assets/chat-DXTCXe4G.js",
-      "apps/desktop/dist/renderer/assets/transition-types-D1lB3ClK.js",
-      "apps/desktop/dist/renderer/assets/runtime-im_sWhnB.js",
-      "apps/desktop/dist/renderer/assets/onboarding-CmoH60vL.js",
+      "apps/desktop/dist/renderer/assets/tour-Bh9-227c.js",
+      "apps/desktop/dist/renderer/assets/bot-memory-list-CQmAvQoU.js",
+      "apps/desktop/dist/renderer/assets/settings-FcssjZR7.js",
+      "apps/desktop/dist/renderer/assets/connector-mark-DqueaLFN.js",
+      "apps/desktop/dist/renderer/assets/shared-element-CcviPcKT.js",
+      "apps/desktop/dist/renderer/assets/bots-DMzaIjuM.js",
+      "apps/desktop/dist/renderer/assets/shell-SX_KO9SK.js",
+      "apps/desktop/dist/renderer/assets/chat-D9DWX5i0.js",
+      "apps/desktop/dist/renderer/assets/runtime-D1c6OXEy.js",
+      "apps/desktop/dist/renderer/assets/onboarding-DEkFX9xS.js",
       "apps/desktop/dist/renderer/assets/actions-mKPtWnRH.js",
-      "apps/desktop/dist/renderer/assets/_shell-CD3Wetpp.js",
-      "apps/desktop/dist/renderer/assets/settings-CwPLn1wN.js",
-      "apps/desktop/dist/renderer/assets/onboarding._step-C2ZHurIa.js",
-      "apps/desktop/dist/renderer/assets/bots-D52UxNtA.js",
-      "apps/desktop/dist/renderer/assets/settings.account-P7aUYGRn.js",
-      "apps/desktop/dist/renderer/assets/settings.models-BwZr_KDj.js",
-      "apps/desktop/dist/renderer/assets/bots._botId-BQPQgpdt.js",
-      "apps/desktop/dist/renderer/assets/bots.new-D_wliVYb.js",
-      "apps/desktop/dist/renderer/assets/library.connectors-phT_AP5u.js",
-      "apps/desktop/dist/renderer/assets/routines._routineId-D5kTBWS5.js",
-      "apps/desktop/dist/renderer/assets/sessions._sessionId-Cl4P-Eyk.js",
-      "apps/desktop/dist/renderer/assets/sessions.new-BryHpZyQ.js",
-      "apps/desktop/dist/renderer/assets/bots._botId.check-in-C7z2pG1Y.js",
-      "apps/desktop/dist/renderer/assets/bots._botId_.edit-BNiFCElb.js",
-      "apps/desktop/dist/renderer/assets/library.tools._toolsetId-Cv41lOiI.js",
-      "apps/desktop/dist/renderer/assets/routines._routineId.edit-S443_lQU.js",
-      "apps/desktop/dist/renderer/assets/sessions._sessionId.diff-By_2WbrU.js",
-      "apps/desktop/dist/renderer/assets/bots._botId_.chats._sessionId-D20LCbhm.js",
+      "apps/desktop/dist/renderer/assets/transition-types-B8Ger0ke.css",
       "apps/desktop/dist/renderer/assets/bot-avatar-tazUtPIO.css",
       "apps/desktop/dist/renderer/assets/bots-D_YvtmJ6.css",
       "apps/desktop/dist/renderer/assets/shell-CMAYOTMG.css",
       "apps/desktop/dist/renderer/assets/chat-DId50OC-.css",
-      "apps/desktop/dist/renderer/assets/transition-types-B8Ger0ke.css",
       "apps/desktop/dist/renderer/assets/onboarding-CghTNAii.css"
     ]
   },
   {
     "name": "Notch initial",
     "gzip": true,
+    "limit": "653292 B",
     "path": [
-      "apps/desktop/dist/renderer/assets/notch-C0kbhKI-.js",
-      "apps/desktop/dist/renderer/assets/rolldown-runtime-C0FnF6B9.js",
-      "apps/desktop/dist/renderer/assets/jsx-runtime-D3F0h15I.js",
-      "apps/desktop/dist/renderer/assets/dist-DL20HYaR.js",
-      "apps/desktop/dist/renderer/assets/path-BdFQ2FkC.js",
-      "apps/desktop/dist/renderer/assets/shim-D7SCD8Sw.js",
-      "apps/desktop/dist/renderer/assets/useSelector-DlgnKuvT.js",
-      "apps/desktop/dist/renderer/assets/matchContext-CiCn8Kl3.js",
-      "apps/desktop/dist/renderer/assets/InternalBackdrop-UtUNEptK.js",
-      "apps/desktop/dist/renderer/assets/redirect-k_XIa7GT.js",
+      "apps/desktop/dist/renderer/assets/notch-Du2GNNrM.js",
+      "apps/desktop/dist/renderer/assets/rolldown-runtime-Dd_uD5pT.js",
+      "apps/desktop/dist/renderer/assets/useSelector-hMeUlnhI.js",
+      "apps/desktop/dist/renderer/assets/useTranslation-C4fzJ8NF.js",
+      "apps/desktop/dist/renderer/assets/matchContext-jlmOrjiL.js",
+      "apps/desktop/dist/renderer/assets/compiler-runtime-DdEb7m_W.js",
+      "apps/desktop/dist/renderer/assets/frame-CQGisaUp.js",
+      "apps/desktop/dist/renderer/assets/spinner-DoqPDy5j.js",
+      "apps/desktop/dist/renderer/assets/redirect-AmaS3P9G.js",
       "apps/desktop/dist/renderer/assets/not-found-i5RsCZif.js",
       "apps/desktop/dist/renderer/assets/root-DLTE-HSj.js",
-      "apps/desktop/dist/renderer/assets/Match-BN5yd91N.js",
-      "apps/desktop/dist/renderer/assets/Matches-DJkyOfbH.js",
-      "apps/desktop/dist/renderer/assets/useTranslation-DzorYd_v.js",
-      "apps/desktop/dist/renderer/assets/en-US-CRczPHnt.js",
-      "apps/desktop/dist/renderer/assets/link-pl7iHhTD.js",
-      "apps/desktop/dist/renderer/assets/useParams-DPofAYbO.js",
-      "apps/desktop/dist/renderer/assets/useSearch-CnHXTPLS.js",
-      "apps/desktop/dist/renderer/assets/useNavigate-CJKg9hKS.js",
-      "apps/desktop/dist/renderer/assets/route-D6up4V3B.js",
-      "apps/desktop/dist/renderer/assets/fileRoute-bfjtUwe9.js",
-      "apps/desktop/dist/renderer/assets/dist-CbJ1Pi6q.js",
-      "apps/desktop/dist/renderer/assets/agent-types-DpG64hVY.js",
-      "apps/desktop/dist/renderer/assets/compiler-runtime-BiNu7y5K.js",
-      "apps/desktop/dist/renderer/assets/frame-BAq58oSZ.js",
-      "apps/desktop/dist/renderer/assets/spinner-NEGWP0ai.js",
-      "apps/desktop/dist/renderer/assets/sound-Bl8pVLe1.js",
-      "apps/desktop/dist/renderer/assets/registry-Ct2R9BN3.js",
-      "apps/desktop/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-aEkSWT6i.js",
-      "apps/desktop/dist/renderer/assets/check-BIlEERF8.js",
-      "apps/desktop/dist/renderer/assets/chevron-down-CogD4oIp.js",
-      "apps/desktop/dist/renderer/assets/MenuTrigger-BQZReVvu.js",
-      "apps/desktop/dist/renderer/assets/message-reactions-DuA2cNXA.js",
-      "apps/desktop/dist/renderer/assets/PreviewCardPopup-DjGWQJm_.js",
-      "apps/desktop/dist/renderer/assets/triangle-alert-9MzacqwM.js",
+      "apps/desktop/dist/renderer/assets/Match-DO_EsbqY.js",
+      "apps/desktop/dist/renderer/assets/Matches-GtOcHBhM.js",
+      "apps/desktop/dist/renderer/assets/sound-DOvbnGxL.js",
+      "apps/desktop/dist/renderer/assets/chevron-down-CNmRlT3p.js",
+      "apps/desktop/dist/renderer/assets/registry-mCnq-mu5.js",
+      "apps/desktop/dist/renderer/assets/hotkey-manager-B4gkC1Bb.js",
+      "apps/desktop/dist/renderer/assets/ui-DE1RYzs3.js",
+      "apps/desktop/dist/renderer/assets/hover-card-BqHHar1V.js",
+      "apps/desktop/dist/renderer/assets/bots-qGVRGLA3.js",
+      "apps/desktop/dist/renderer/assets/messaging-BcBXMRra.js",
+      "apps/desktop/dist/renderer/assets/messaging-DGWbWN6g.js",
       "apps/desktop/dist/renderer/assets/preload-helper-HclGiUj8.js",
-      "apps/desktop/dist/renderer/assets/use-app-context-DkQ5sbuv.js",
-      "apps/desktop/dist/renderer/assets/hotkey-manager-C4G-p09N.js",
-      "apps/desktop/dist/renderer/assets/react-ejPbDFI_.js",
-      "apps/desktop/dist/renderer/assets/ui-XQS48oCz.js",
-      "apps/desktop/dist/renderer/assets/hover-card-CaMm_1dx.js",
-      "apps/desktop/dist/renderer/assets/empty-state-DZNRI787.js",
-      "apps/desktop/dist/renderer/assets/turns-Cr8yGqoY.js",
-      "apps/desktop/dist/renderer/assets/dropdown-menu-BJdn6pyM.js",
-      "apps/desktop/dist/renderer/assets/chat-DXTCXe4G.js",
-      "apps/desktop/dist/renderer/assets/useStore-DnoXlDpe.js",
-      "apps/desktop/dist/renderer/assets/check-in-C8Qv0pWX.js",
-      "apps/desktop/dist/renderer/assets/bots-DdNBRmsz.js",
-      "apps/desktop/dist/renderer/assets/messaging-CBOV8sHT.js",
-      "apps/desktop/dist/renderer/assets/messaging-BUfBuxkX.js",
       "apps/desktop/dist/renderer/assets/log-ring-BZ2uGgM8.js",
-      "apps/desktop/dist/renderer/assets/transition-types-D1lB3ClK.js",
-      "apps/desktop/dist/renderer/assets/runtime-im_sWhnB.js",
-      "apps/desktop/dist/renderer/assets/bot-avatar-C8zgJzJ4.js",
-      "apps/desktop/dist/renderer/assets/cues-sdIG_3RW.js",
-      "apps/desktop/dist/renderer/assets/shared-element-C1DaGsh4.js",
-      "apps/desktop/dist/renderer/assets/chat-DId50OC-.css",
+      "apps/desktop/dist/renderer/assets/transition-types-kBeCKY2x.js",
+      "apps/desktop/dist/renderer/assets/link-Ch3HzHVM.js",
+      "apps/desktop/dist/renderer/assets/useParams-edixy8GZ.js",
+      "apps/desktop/dist/renderer/assets/useSearch-BuW7dCbE.js",
+      "apps/desktop/dist/renderer/assets/useNavigate-D5KOICuw.js",
+      "apps/desktop/dist/renderer/assets/fileRoute-Bk5pnR5L.js",
+      "apps/desktop/dist/renderer/assets/empty-state-BUK85Zdy.js",
+      "apps/desktop/dist/renderer/assets/dropdown-menu-0FDckRBw.js",
+      "apps/desktop/dist/renderer/assets/turns-CO8eSM_q.js",
+      "apps/desktop/dist/renderer/assets/chat-D9DWX5i0.js",
+      "apps/desktop/dist/renderer/assets/useStore-Jt_fedF3.js",
+      "apps/desktop/dist/renderer/assets/runtime-D1c6OXEy.js",
+      "apps/desktop/dist/renderer/assets/bot-avatar-K2XYybxl.js",
+      "apps/desktop/dist/renderer/assets/cues-BWDDQkLq.js",
+      "apps/desktop/dist/renderer/assets/shared-element-CcviPcKT.js",
       "apps/desktop/dist/renderer/assets/transition-types-B8Ger0ke.css",
+      "apps/desktop/dist/renderer/assets/chat-DId50OC-.css",
       "apps/desktop/dist/renderer/assets/bot-avatar-tazUtPIO.css",
       "apps/desktop/dist/renderer/assets/notch-DNnXb795.css"
     ]
@@ -197,11 +130,13 @@
   {
     "name": "Largest lazy chunk",
     "gzip": true,
-    "path": ["apps/desktop/dist/renderer/assets/editor.api2-DdadTTrJ.js"]
+    "limit": "1557671 B",
+    "path": ["apps/desktop/dist/renderer/assets/transformers.web-CRbLS8vX.js"]
   },
   {
     "name": "Math lazy chunk",
     "gzip": true,
+    "limit": "62830 B",
     "path": ["apps/desktop/dist/renderer/assets/temml-CiP_lRsR.js"]
   }
 ]
diff --git a/apps/desktop/src/main/services/updates/experience/active-experience.ts b/apps/desktop/src/main/services/updates/experience/active-experience.ts
index c7c08b80..36593f30 100644
--- a/apps/desktop/src/main/services/updates/experience/active-experience.ts
+++ b/apps/desktop/src/main/services/updates/experience/active-experience.ts
@@ -20,6 +20,3 @@ export const experienceAgentEntry = (): string | null => {
 
   return directory === null ? null : path.join(directory, "main.js");
 };
-
-export const activeExperienceVersion = (): string | null =>
-  active?.version ?? null;
diff --git a/apps/desktop/src/main/services/updates/experience/experience-activation.test.ts b/apps/desktop/src/main/services/updates/experience/experience-activation.test.ts
index ddcdb98a..bfef2da8 100644
--- a/apps/desktop/src/main/services/updates/experience/experience-activation.test.ts
+++ b/apps/desktop/src/main/services/updates/experience/experience-activation.test.ts
@@ -136,7 +136,6 @@ const { ExperienceStore, REJECTION_TTL_MS } =
   await import("./experience-store");
 const { rendererChangeNeedsReadiness } = await import("./experience-updater");
 const { rendererUrl } = await import("./app-protocol");
-const { FOUNDATION_API } = await import("#shared/experience");
 const { rendererReadiness } = await import("../../../rpc/readiness");
 const {
   MAX_SWAP_READINESS_ATTEMPTS,
@@ -151,7 +150,7 @@ type Outcome = import("../../../renderer-host").SwapOutcome;
 const VERSION = (n: number) => String(n).repeat(64).slice(0, 64);
 const SHA = (n: number) => `${"f".repeat(63)}${n}`;
 /** The barrier index.ts derives from the shipped FOUNDATION_API. */
-const SHIPPED_BARRIER = FOUNDATION_API >= 2 ? "subscriptions" : "first-commit";
+const SHIPPED_BARRIER = "subscriptions";
 
 beforeEach(() => {
   paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), "experience-"));
@@ -308,16 +307,16 @@ describe("experience activation is transactional with renderer readiness", () =>
     }
   );
 
-  it("the swap's first-commit barrier rejects a candidate that never signals", async () => {
+  it("the swap's subscriptions barrier rejects a candidate that never signals", async () => {
     vi.useFakeTimers();
     const host = makeHost();
     const first = host.webContents;
     fakes.behaviour.silent = ["app://silent/"];
     const swapping = host.swap(new URL("app://silent/"), {
-      barrier: "first-commit",
+      barrier: "subscriptions",
     });
     const rejected = expect(swapping).rejects.toBeInstanceOf(SwapNotReady);
-    await vi.advanceTimersByTimeAsync(6_000);
+    await vi.advanceTimersByTimeAsync(11_000);
     await rejected;
     expect(host.webContents).toBe(first);
   });
diff --git a/apps/desktop/src/main/services/updates/experience/experience-updater.ts b/apps/desktop/src/main/services/updates/experience/experience-updater.ts
index 41742b6b..81468906 100644
--- a/apps/desktop/src/main/services/updates/experience/experience-updater.ts
+++ b/apps/desktop/src/main/services/updates/experience/experience-updater.ts
@@ -14,9 +14,7 @@ import { app } from "electron";
 import extract from "extract-zip";
 import { Updater } from "tuf-js";
 
-import { RENDERER_GENERATION } from "#main/renderer-generation";
 import { resourcePath } from "#main/resources";
-import { defaultWire } from "#main/services/agui/relay-service";
 
 import type { ExperienceStore } from "./experience-store";
 import { checkAgentBundle } from "./health-check";
@@ -257,15 +255,7 @@ export class ExperienceUpdater {
       // The candidate's agent resolves native imports through the linked
       // runtime, so the link must exist before the health check.
       await store.linkRuntime(temporary);
-      await checkAgentBundle(temporary, {
-        wire: defaultWire({
-          generation: RENDERER_GENERATION,
-          isPackaged: app.isPackaged,
-          env: process.env,
-        })
-          ? "agui"
-          : "ndjson",
-      });
+      await checkAgentBundle(temporary);
 
       const installed = path.join(
         store.experiencesDirectory,
diff --git a/apps/desktop/src/main/services/updates/experience/health-check.test.ts b/apps/desktop/src/main/services/updates/experience/health-check.test.ts
index 3af2132c..f3489ad0 100644
--- a/apps/desktop/src/main/services/updates/experience/health-check.test.ts
+++ b/apps/desktop/src/main/services/updates/experience/health-check.test.ts
@@ -5,14 +5,14 @@ import path from "node:path";
 import { expect, it } from "vitest";
 
 import { checkAgentBundle } from "./health-check";
-for (const wire of ["ndjson", "agui"] as const) {
+for (const wire of ["agui"] as const) {
   it(`R7-T8: health check uses ${wire} readiness and exact arguments in an isolated home`, async () => {
     const root = await fs.mkdtemp(path.join(os.tmpdir(), "health-fixture-"));
     try {
       await fs.mkdir(path.join(root, "agent"));
       const args =
         wire === "agui"
-          ? ["--wire", "agui", "--thread-id", "health-check"]
+          ? ["--thread-id", "health-check"]
           : ["--wire", "ndjson"];
       const ready =
         wire === "agui"
@@ -22,14 +22,12 @@ for (const wire of ["ndjson", "agui"] as const) {
         path.join(root, "agent", "main.js"),
         `if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(args))})process.exit(64); console.log(${JSON.stringify(JSON.stringify(ready))});setInterval(()=>{},1000);`
       );
-      await expect(checkAgentBundle(root, { wire })).resolves.toBeUndefined();
+      await expect(checkAgentBundle(root)).resolves.toBeUndefined();
       await fs.writeFile(
         path.join(root, "agent", "main.js"),
         'console.log(JSON.stringify({type:"RUN_ERROR"}));setInterval(()=>{},1000);'
       );
-      await expect(checkAgentBundle(root, { wire })).rejects.toThrow(
-        "RUN_ERROR"
-      );
+      await expect(checkAgentBundle(root)).rejects.toThrow("RUN_ERROR");
     } finally {
       await fs.rm(root, { force: true, recursive: true });
     }
@@ -47,7 +45,7 @@ it.each([
   try {
     await fs.mkdir(path.join(root, "agent"));
     await fs.writeFile(path.join(root, "agent", "main.js"), source);
-    await expect(checkAgentBundle(root, { wire: "agui" })).rejects.toThrow();
+    await expect(checkAgentBundle(root)).rejects.toThrow();
   } finally {
     await fs.rm(root, { force: true, recursive: true });
   }
diff --git a/apps/desktop/src/main/services/updates/experience/health-check.ts b/apps/desktop/src/main/services/updates/experience/health-check.ts
index bbfd3321..4c43fc03 100644
--- a/apps/desktop/src/main/services/updates/experience/health-check.ts
+++ b/apps/desktop/src/main/services/updates/experience/health-check.ts
@@ -32,8 +32,7 @@ const HEALTH_ENV_NAMES = [
 ];
 
 export const checkAgentBundle = async (
-  candidateRoot: string,
-  options: { wire: "ndjson" | "agui" } = { wire: "ndjson" }
+  candidateRoot: string
 ): Promise<void> => {
   const entry = path.join(candidateRoot, "agent", "main.js");
   const home = await fs.mkdtemp(path.join(os.tmpdir(), "abacus-health-"));
@@ -50,10 +49,7 @@ export const checkAgentBundle = async (
     if (value !== undefined) env[name] = value;
   }
 
-  const args =
-    options.wire === "agui"
-      ? [entry, "--wire", "agui", "--thread-id", "health-check"]
-      : [entry, "--wire", "ndjson"];
+  const args = [entry, "--thread-id", "health-check"];
   const child = spawn(process.execPath, args, {
     cwd: home,
     env,
@@ -77,11 +73,8 @@ export const checkAgentBundle = async (
           if (
             typeof parsed === "object" &&
             parsed !== null &&
-            (options.wire === "agui"
-              ? (parsed as { type?: unknown; name?: unknown }).type ===
-                  "CUSTOM" &&
-                (parsed as { name?: unknown }).name === "session.ready"
-              : (parsed as { type?: unknown }).type === "ready")
+            (parsed as { type?: unknown }).type === "CUSTOM" &&
+            (parsed as { name?: unknown }).name === "session.ready"
           ) {
             clearTimeout(timer);
             resolve();
diff --git a/apps/desktop/src/main/services/updates/update-service.ts b/apps/desktop/src/main/services/updates/update-service.ts
index 77f1d5bb..ba0aed55 100644
--- a/apps/desktop/src/main/services/updates/update-service.ts
+++ b/apps/desktop/src/main/services/updates/update-service.ts
@@ -7,7 +7,6 @@ import electronUpdater, { type UpdateInfo } from "electron-updater";
 const { autoUpdater } = electronUpdater;
 import { app, BaseWindow, powerMonitor } from "electron";
 
-import { sendToRenderer } from "#main/renderer-host";
 import { emitBusChannel } from "#main/rpc/emit";
 import type { UpdateFailedPhase, UpdateStatus } from "#shared/update";
 
@@ -537,7 +536,6 @@ export class UpdateService {
   }
 
   private emitStatusUpdate(): void {
-    sendToRenderer("update-status", this.status);
     emitBusChannel("update", this.getStatus());
   }
 }
diff --git a/apps/updater/src/classify.ts b/apps/updater/src/classify.ts
index 559f1dcc..d8ee329b 100644
--- a/apps/updater/src/classify.ts
+++ b/apps/updater/src/classify.ts
@@ -10,9 +10,7 @@ export type ReleaseKind = "experience" | "foundation" | "none";
  */
 const EXPERIENCE_PREFIXES = [
   "apps/desktop/index.html",
-  "apps/desktop/index-next.html",
   "apps/desktop/notch.html",
-  "apps/desktop/src/renderer-next/",
   "apps/desktop/src/renderer/",
   "packages/agent/src/",
 ];

exec
/bin/zsh -c 'ls /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/*/bin; cat apps/desktop/scripts/sync-locales.js apps/desktop/scripts/i18n-consumers.mjs apps/desktop/scripts/measure-release-size.mjs; cat apps/desktop/src/main/services/updates/update-service.ts' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
zsh:1: no matches found: /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/*/bin
#!/usr/bin/env node

/**
 * Keep all locale JSON files in sync with en-US.json (source of truth).
 *
 * - Same keys in every file (no missing / no extra)
 * - Same key order as en-US
 * - Missing values fall back to en-US
 *
 * Usage:
 *   node scripts/sync-locales.js          # rewrite locale files
 *   node scripts/sync-locales.js --check  # exit 1 if any file is out of sync
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCALE_DIR = path.join(ROOT, "src/renderer/locales");
const BASE_LOCALE = "en-US.json";
const checkOnly = process.argv.includes("--check");
function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function serializeLocale(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recurses. The locale files are nested (every UI string lives under a section
// like `agent`), so a shallow copy would see the section as a non-string
// and replace the whole translated subtree with en-US, silently reverting
// every translation in the file the next time anyone ran this script.
function syncLocale(baseObj, localeObj, prefix = "") {
  const synced = {};
  for (const key of Object.keys(baseObj)) {
    const baseValue = baseObj[key];
    const existing = isPlainObject(localeObj) ? localeObj[key] : undefined;
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(baseValue)) {
      synced[key] = syncLocale(
        baseValue,
        isPlainObject(existing) ? existing : {},
        full
      );
    } else {
      synced[key] =
        typeof existing === "string" && existing.trim() !== ""
          ? existing
          : baseValue;
    }
  }
  return synced;
}

// Dotted leaf paths, so the missing/extra report counts real strings rather
// than top-level sections (which made a whole untranslated subtree read as
// "missing 0").
function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(obj[key])) {
      keys.push(...flattenKeys(obj[key], full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

// Both renderers' t() calls resolve against the one set of locale files.
const SOURCE_DIRS = [path.join(ROOT, "src/renderer")];

// CLDR plural categories i18next appends to a plural key.
const PLURAL_SUFFIXES = ["_one", "_other", "_zero", "_two", "_few", "_many"];

/**
 * Every `t("...")` in the renderer must name a key en-US actually has.
 *
 * The sync above only proves the locale files agree with each other; it cannot
 * see a call site left pointing at a key that was renamed away, which renders
 * as the raw key string in the UI. A bulk rename of the `localCode.*` section
 * is exactly how that happens, and the failure is silent: nothing throws, the
 * user just reads "workspace.modelTier.fast" on a button.
 *
 * Template literals (`t(`workspace.modelTier.${tier}`)`) can't be resolved
 * statically, so the static prefix is required to match at least one real key.
 * That is enough to catch a renamed section, which is the case that bites.
 */
function checkKeyUsage(baseKeys) {
  const known = new Set(baseKeys);
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "locales") {
          walk(full);
        }
      } else if (/\.tsx?$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        const rel = path.relative(ROOT, full);

        for (const [, key] of source.matchAll(/\bt\(\s*["']([\w.]+)["']/g)) {
          // A plural key is stored under its CLDR category suffixes
          // (`itemCount_one` / `_other`); the call site names the stem.
          if (
            !(known.has(key) || PLURAL_SUFFIXES.some((s) => known.has(key + s)))
          ) {
            problems.push(
              `${rel}: t("${key}") has no such key in ${BASE_LOCALE}`
            );
          }
        }

        for (const [, prefix] of source.matchAll(/\bt\(\s*`([\w.]*)\$\{/g)) {
          if (prefix && !baseKeys.some((k) => k.startsWith(prefix))) {
            problems.push(
              `${rel}: t(\`${prefix}\${...}\`) has no key in ${BASE_LOCALE} starting with "${prefix}"`
            );
          }
        }
      }
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);

  if (problems.length > 0) {
    console.error(
      `\n[sync-locales] ${problems.length} translation call(s) reference missing keys:`
    );
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  console.log("[sync-locales] All t() keys resolve against the base locale.");
}

function main() {
  const basePath = path.join(LOCALE_DIR, BASE_LOCALE);
  if (!fs.existsSync(basePath)) {
    console.error(`[sync-locales] Missing base locale: ${basePath}`);
    process.exit(1);
  }

  const baseObj = loadJson(basePath);
  const baseKeys = flattenKeys(baseObj);
  const localeFiles = fs
    .readdirSync(LOCALE_DIR)
    .filter((f) => f.endsWith(".json") && f !== BASE_LOCALE)
    .sort();

  let changed = 0;
  const report = [];

  for (const file of localeFiles) {
    const filePath = path.join(LOCALE_DIR, file);
    const localeObj = loadJson(filePath);
    const localeKeys = flattenKeys(localeObj);

    const localeKeySet = new Set(localeKeys);
    const baseKeySet = new Set(baseKeys);
    const missing = baseKeys.filter((k) => !localeKeySet.has(k));
    const extra = localeKeys.filter((k) => !baseKeySet.has(k));

    const synced = syncLocale(baseObj, localeObj);
    const nextContent = serializeLocale(synced);
    const prevContent = fs.readFileSync(filePath, "utf8");

    const fileChanged = nextContent !== prevContent;
    if (fileChanged) changed += 1;

    report.push({
      file,
      keys: localeKeys.length,
      missing: missing.length,
      extra: extra.length,
      changed: fileChanged,
    });

    if (!checkOnly && fileChanged) {
      fs.writeFileSync(filePath, nextContent, "utf8");
    }
  }

  console.log(
    `[sync-locales] Base locale ${BASE_LOCALE}: ${baseKeys.length} keys`
  );
  for (const row of report) {
    const status = row.changed ? (checkOnly ? "OUT OF SYNC" : "UPDATED") : "OK";
    console.log(
      `  ${row.file}: ${row.keys} keys, missing ${row.missing}, extra ${row.extra} (${status})`
    );
  }

  if (checkOnly && changed > 0) {
    console.error(
      `\n[sync-locales] ${changed} locale file(s) out of sync. Run: pnpm --filter @abacus-ai/desktop sync:locales`
    );
    process.exit(1);
  }

  if (!checkOnly) {
    console.log(`\n[sync-locales] Done. ${changed} file(s) updated.`);
  } else {
    console.log("\n[sync-locales] All locale files are in sync.");
  }

  checkKeyUsage(baseKeys);
}

main();
import fs from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
export const flatten = (tree, prefix = "") =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [prefix + key]
      : flatten(value, prefix + key + ".")
  );
const plurals = ["_one", "_other", "_zero", "_two", "_few", "_many"];
const walk = (node, fn) => {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const value of Object.values(node))
    if (Array.isArray(value)) value.forEach((n) => walk(n, fn));
    else if (value && typeof value === "object") walk(value, fn);
};
export const consumers = (keys, sources, dynamic = []) => {
  const used = new Set(),
    literals = new Set(),
    templates = new Set();
  for (const [file, source] of Object.entries(sources))
    walk(parseSync(file, source).program, (node) => {
      if (node.type === "Literal" && typeof node.value === "string")
        literals.add(node.value);
      // Keys may be built in catalogues before they reach t(), including labelKey.
      if (node.type === "TemplateLiteral") {
        const prefix = node.quasis[0].value.cooked;
        if (prefix && keys.some((key) => key.startsWith(prefix)))
          templates.add(prefix);
      }
      if (
        node.type === "CallExpression" &&
        (node.callee?.name === "t" || node.callee?.property?.name === "t") &&
        node.arguments[0]?.type === "TemplateLiteral" &&
        !node.arguments[0].quasis[0].value.cooked &&
        !dynamic.some((row) => row.prefix === "")
      )
        throw new Error(`Unbounded translation template in ${file}`);
    });
  for (const key of keys)
    if (
      literals.has(key) ||
      plurals.some(
        (s) => key.endsWith(s) && literals.has(key.slice(0, -s.length))
      )
    )
      used.add(key);
  for (const row of dynamic)
    for (const value of row.values)
      if (keys.includes(row.prefix + value)) used.add(row.prefix + value);
  for (const prefix of templates)
    if (!dynamic.some((row) => row.prefix === prefix))
      for (const key of keys) if (key.startsWith(prefix)) used.add(key);
  return used;
};
export const sourceFiles = (dir) => {
  const sources = {};
  const visit = (directory) => {
    for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
      if (e.name === "locales" || e.name === "ui") continue;
      const file = path.join(directory, e.name);
      if (e.isDirectory()) visit(file);
      else if (
        /\.tsx?$/.test(file) &&
        !/(?:\.test\.|\.d\.ts$|dynamic-keys\.ts$)/.test(file)
      )
        sources[file] = fs.readFileSync(file, "utf8");
    }
  };
  visit(dir);
  return sources;
};
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
const desktop = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const root = path.resolve(desktop, "../..");
const dist = path.join(desktop, "dist/renderer");
const files = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"));
const gzip = (file) => gzipSync(fs.readFileSync(path.join(dist, file))).length;
const initial = (html) =>
  [
    ...fs
      .readFileSync(path.join(dist, html), "utf8")
      .matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g),
  ].map((m) => m[1].replace(/^\//, ""));
const mainHtml = "index.html";
const entryResources = new Set(
  [mainHtml, "notch.html"]
    .flatMap((file) => initial(file))
    .map((file) => file.replace(/^\.\//, ""))
);
const largest = files
  .filter(
    (file) =>
      !/worker|ort-wasm/.test(file) && !entryResources.has(`assets/${file}`)
  )
  .toSorted((a, b) => gzip(`assets/${b}`) - gzip(`assets/${a}`))[0];
if (!largest) throw new Error("No lazy JavaScript chunk was emitted");
const entries = [
  {
    name: "Main initial",
    path: initial("index.html"),
  },
  { name: "Notch initial", path: initial("notch.html") },
  { name: "Largest lazy chunk", path: [`assets/${largest}`] },
  {
    name: "Math lazy chunk",
    path: files.filter((f) => f.startsWith("temml-")).map((f) => `assets/${f}`),
  },
].map((e) => ({ ...e, gzipBytes: e.path.reduce((n, f) => n + gzip(f), 0) }));
const report = {
  commit: JSON.parse(fs.readFileSync(path.join(dist, "build.json"))).commit,
  measuredAt: new Date().toISOString(),
  entries,
};
const target =
  process.argv[2] ??
  path.join(root, "docs/rewrite/reports/07-size-current.json");
fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(
  path.join(root, ".size-limit.json"),
  JSON.stringify(
    entries.map((e) => ({
      name: e.name,
      gzip: true,
      limit: JSON.parse(
        fs.readFileSync(path.join(root, ".size-limit.json"))
      ).find((limit) => limit.name === e.name)?.limit,
      path: e.path.map((f) =>
        path.relative(root, path.join(dist, f)).replaceAll("\\", "/")
      ),
    })),
    null,
    2
  ) + "\n"
);
console.log(JSON.stringify(report, null, 2));
import { existsSync } from "node:fs";
import { join } from "node:path";

// electron-updater is CommonJS; a named value import fails at load under ESM.
import electronUpdater, { type UpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;
import { app, BaseWindow, powerMonitor } from "electron";

import { emitBusChannel } from "#main/rpc/emit";
import type { UpdateFailedPhase, UpdateStatus } from "#shared/update";

import { markQuitting, clearQuitting } from "../../app-quit-state";
import { isNotchWindow } from "../../notch/registry";
import { markRelaunchHidden, clearRelaunchHidden } from "./relaunch-hidden";

// Static CDN feed: one YAML naming immutable per-version artifacts. The feed
// flip is the last, atomic step of a release.
const DEFAULT_UPDATE_FEED_URL =
  "https://downloads.abacus.ai/abacusai-bot/latest";

// The override is a developer affordance and powerless in a packaged build: an
// attacker-set env var must never redirect a signed app to a hostile feed (on
// Linux that is arbitrary-binary RCE). Unpackaged, https, abacus.ai host only.
const resolveFeedUrl = (): string => {
  const raw = process.env.ABACUSAI_BOT_UPDATE_FEED_URL?.trim();
  if (!raw || app.isPackaged) return DEFAULT_UPDATE_FEED_URL;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "abacus.ai" || host.endsWith(".abacus.ai"))
    ) {
      return raw;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_UPDATE_FEED_URL;
};
const UPDATE_FEED_URL = resolveFeedUrl();

// `criticalBelow`: older running versions get the blocking dialog, not a pill.
const RELEASE_METADATA_URL = `${UPDATE_FEED_URL}/release-metadata.json`;
const RELEASE_METADATA_TIMEOUT_MS = 10_000;

// Above the CDN's 300s feed cache, so polls are answered from the edge.
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// Idle threshold before a downloaded update may apply itself.
const AUTO_RESTART_IDLE_SECONDS = 10 * 60;
const AUTO_RESTART_POLL_MS = 60_000;

// After quitAndInstall() only our own exit stands between the user and the
// update: normal quit first, then hard-exit. 15s clears the 6s cleanup cap.
const QUIT_STALL_MS = 15_000;
const QUIT_FORCE_MS = 30_000;

// a < b over dotted numeric versions; bad segments count as 0, which only
// errs toward "not critical".
function versionLessThan(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.split(".").map((seg) => Number.parseInt(seg, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0];
    if (x !== y) return x < y;
  }
  return false;
}

/** Host knowledge: an agent turn or live PTY makes a restart destructive. */
export interface UpdateServiceDeps {
  isSafeToRestart?: () => boolean;
}

const initialStatus = (): UpdateStatus => ({
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
});

/**
 * The step an updater `error` event interrupted, read from the state before
 * the handler clears `checking`/`downloading`/`progress` (spec 05 §31.5 h).
 */
export const failedPhaseOf = (
  status: Pick<UpdateStatus, "installing" | "downloading">
): UpdateFailedPhase =>
  status.installing ? "install" : status.downloading ? "download" : "check";

export class UpdateService {
  private status = initialStatus();

  private checkTimer: NodeJS.Timeout | null = null;
  private autoRestartTimer: NodeJS.Timeout | null = null;

  // On disk, as opposed to the feed's last offer (`status.updateInfo`); they
  // diverge when the pending install is superseded.
  private downloadedVersion: string | null = null;

  /** Consecutive checks that did not offer the downloaded build. */
  private notOfferedStrikes = 0;
  private transferToken: { cancel(): void } | null = null;
  private checkingFeed: Promise<
    Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  > | null = null;
  private withdrawnDownloads = new Set<string>();

  constructor(private readonly deps: UpdateServiceDeps = {}) {
    this.setupAutoUpdater();
  }

  private setupAutoUpdater(): void {
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });
    } catch (err) {
      console.error("[UpdateService] Failed to set feed URL:", err);
    }

    autoUpdater.autoInstallOnAppQuit = false;
    // autoDownload: see setUpdaterHasPendingBuild().

    autoUpdater.logger = {
      info: () => {},
      debug: () => {},
      warn: (msg) => console.warn(`[UpdateService] ${msg}`),
      error: (msg) => console.error(`[UpdateService] ${msg}`),
    };

    autoUpdater.on("checking-for-update", () => {
      console.log(`[UpdateService] checking ${UPDATE_FEED_URL}`);
      this.status.checking = true;
      this.status.error = null;
      this.status.failedPhase = null;
      this.emitStatusUpdate();
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      console.log(
        `[UpdateService] ${info.version} available (running ${app.getVersion()}), downloading`
      );
      this.notOfferedStrikes = 0;
      this.withdrawnDownloads.delete(info.version);
      // Installing a superseded build would relaunch straight into another
      // "Relaunch to update"; the pill comes down until the replacement lands.
      if (
        this.status.downloaded &&
        this.downloadedVersion !== info.version &&
        !this.status.installing
      ) {
        this.dropDownloadedBuild(
          `${info.version} supersedes downloaded ${this.downloadedVersion ?? "build"}`
        );
      }

      this.status.checking = false;
      this.status.available = true;
      // The flag also keeps the periodic check from disturbing the transfer.
      if (!this.status.downloaded) this.status.downloading = true;
      this.status.updateInfo = { version: info.version };
      this.emitStatusUpdate();
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      console.log(
        `[UpdateService] up to date on ${app.getVersion()} (feed offers ${info.version})`
      );
      this.status.checking = false;
      this.status.available = false;

      if (this.status.downloading) {
        if (this.status.updateInfo != null)
          this.withdrawnDownloads.add(this.status.updateInfo.version);
        this.transferToken?.cancel();
        this.transferToken = null;
        this.status.downloading = false;
        this.dropDownloadedBuild("feed withdrew the active download");
      }
      this.status.updateInfo = { version: info.version };
      // A build the feed stops offering is a pulled release: drop it. On the
      // second consecutive answer, since one stale CDN edge right after a
      // release must not discard a valid build.
      if (this.status.downloaded && !this.status.installing) {
        this.notOfferedStrikes += 1;
        if (this.notOfferedStrikes >= 2) {
          this.dropDownloadedBuild(
            `downloaded ${this.downloadedVersion ?? "build"} no longer offered, dropping it`
          );
        } else {
          console.log(
            `[UpdateService] downloaded ${this.downloadedVersion ?? "build"} not offered by this check, dropping it if that repeats`
          );
        }
      }
      this.emitStatusUpdate();
    });

    autoUpdater.on("error", (error) => {
      // electron-updater errors arrive with full HTTP headers stapled on.
      const fullMsg = error?.message ?? String(error);
      const shortMsg = fullMsg.split("\n")[0] || fullMsg;
      console.warn(`[UpdateService] Update error: ${shortMsg}`);
      this.status.failedPhase = failedPhaseOf(this.status);
      this.status.checking = false;
      this.status.downloading = false;
      // A dead transfer has no progress; a kept figure reads as a live one.
      this.status.progress = null;
      this.status.error = shortMsg;
      this.emitStatusUpdate();
    });

    autoUpdater.on("download-progress", (progress) => {
      this.status.progress = {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      };
      this.emitStatusUpdate();
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      if (this.withdrawnDownloads.has(info.version)) return;
      console.log(`[UpdateService] ${info.version} downloaded, pill is up`);
      this.transferToken = null;
      this.notOfferedStrikes = 0;
      this.status.downloading = false;
      this.status.downloaded = true;
      this.status.updateInfo = { version: info.version };
      this.downloadedVersion = info.version;
      this.setUpdaterHasPendingBuild(true);
      this.emitStatusUpdate();
      this.startAutoRestartPoll();
    });
  }

  /** The build on disk is not the one to install any more; forget it. */
  private dropDownloadedBuild(reason: string): void {
    console.log(`[UpdateService] ${reason}`);
    this.notOfferedStrikes = 0;
    this.status.downloaded = false;
    // A stale progress sample would render as a live download.
    this.status.progress = null;
    this.downloadedVersion = null;
    this.stopAutoRestartPoll();
    this.setUpdaterHasPendingBuild(false);
  }

  /**
   * With a build pending, autoDownload comes off so a re-check is one YAML
   * fetch rather than a re-hash and (macOS) re-stage. When the build is
   * dropped, install-on-quit comes off too, so quitting does not install a
   * build the status has withdrawn; best-effort where Squirrel already
   * staged it.
   */
  private setUpdaterHasPendingBuild(pending: boolean): void {
    autoUpdater.autoDownload = !pending && !this.status.downloading;
    // Every quit goes through installUpdate and its fresh admission check.
    autoUpdater.autoInstallOnAppQuit = false;
  }

  // Wait for a moment when a restart destroys nothing and take it silently;
  // the pill stays as the manual path.
  private startAutoRestartPoll(): void {
    if (this.autoRestartTimer != null) return;

    this.autoRestartTimer = setInterval(
      () => this.tryAutoRestart(),
      AUTO_RESTART_POLL_MS
    );
    this.autoRestartTimer.unref();
  }

  private stopAutoRestartPoll(): void {
    if (this.autoRestartTimer == null) return;
    clearInterval(this.autoRestartTimer);
    this.autoRestartTimer = null;
  }

  private tryAutoRestart(): void {
    if (
      !this.status.downloaded ||
      this.status.installing ||
      this.status.installStalled
    ) {
      return;
    }

    // Where idle time is unavailable (some Wayland setups report 0 forever)
    // this never fires and the pill carries the update.
    if (powerMonitor.getSystemIdleTime() < AUTO_RESTART_IDLE_SECONDS) return;

    if (this.deps.isSafeToRestart != null && !this.deps.isSafeToRestart()) {
      return;
    }

    // macOS can relaunch hidden through the Dock. A hidden Windows window has
    // no tray entry here, so restart it visibly instead of stranding the update.
    const windowVisible = BaseWindow.getAllWindows().some(
      (win) => !isNotchWindow(win) && !win.isDestroyed() && win.isVisible()
    );
    let relaunchHidden = false;
    if (!windowVisible) {
      if (process.platform === "darwin") relaunchHidden = true;
      else if (process.platform !== "win32") return;
    }

    console.log(
      `[UpdateService] ${this.status.updateInfo?.version ?? "update"} ready and the app is idle, restarting silently`
    );
    this.stopAutoRestartPoll();
    void this.installUpdate({ silent: true, relaunchHidden });
  }

  // Fails to "no change": metadata is an escalation channel, never a blocker.
  private async refreshReleaseMetadata(): Promise<void> {
    try {
      const res = await fetch(RELEASE_METADATA_URL, {
        signal: AbortSignal.timeout(RELEASE_METADATA_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const meta: unknown = await res.json();
      const criticalBelow = (meta as { criticalBelow?: unknown })
        ?.criticalBelow;
      const critical =
        typeof criticalBelow === "string" &&
        versionLessThan(app.getVersion(), criticalBelow);
      if (critical !== this.status.criticalUpdate) {
        console.log(
          `[UpdateService] criticalBelow=${String(criticalBelow)}, critical: ${critical}`
        );
        this.status.criticalUpdate = critical;
        this.emitStatusUpdate();
      }
    } catch (err) {
      console.warn(
        `[UpdateService] release metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async checkFeed(
    metadataOnly = false
  ): Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> {
    // A concurrent older check cannot authorize an install; await it, then fetch again.
    if (metadataOnly && this.checkingFeed != null) await this.checkingFeed;
    if (this.checkingFeed != null) return this.checkingFeed;
    const previous = autoUpdater.autoDownload;
    if (metadataOnly || this.status.downloading || this.status.downloaded)
      autoUpdater.autoDownload = false;
    this.checkingFeed = autoUpdater.checkForUpdates();
    try {
      return await this.checkingFeed;
    } finally {
      this.checkingFeed = null;
      autoUpdater.autoDownload =
        previous && !this.status.downloaded && !this.status.downloading;
    }
  }

  async checkForUpdates(): Promise<{ success: boolean; error?: string }> {
    if (
      app.isPackaged &&
      !existsSync(join(process.resourcesPath, "app-update.yml"))
    ) {
      console.log(
        "[UpdateService] app-update.yml absent; updates disabled for this unpacked distribution"
      );
      return { success: true };
    }
    try {
      this.status.error = null;
      this.status.failedPhase = null;
      this.status.installStalled = false;
      this.emitStatusUpdate();

      void this.refreshReleaseMetadata();

      const result = await this.checkFeed();
      if (result?.downloadPromise != null) {
        this.transferToken = result.cancellationToken;
        // The check resolves before an automatic download. Observe its rejection too.
        void result.downloadPromise.catch((error: unknown) => {
          console.warn(
            `[UpdateService] Download did not complete: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
      return { success: true };
    } catch (error) {
      const fullMsg = error instanceof Error ? error.message : String(error);
      const shortMsg = fullMsg.split("\n")[0] || fullMsg;
      console.warn(`[UpdateService] Failed to check for updates: ${shortMsg}`);
      this.status.error = shortMsg;
      this.status.failedPhase = "check";
      this.status.checking = false;
      this.emitStatusUpdate();
      return { success: false, error: shortMsg };
    }
  }

  async installUpdate(options?: {
    /** Windows: run the NSIS installer with no UI. The auto path sets this. */
    silent?: boolean;
    /** macOS: the window was hidden at restart, so come back hidden. */
    relaunchHidden?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.status.downloaded) {
        throw new Error("No update downloaded to install");
      }

      // A second ShipIt process makes the first abort on macOS.
      if (this.status.installing) {
        return { success: true };
      }
      const version = this.downloadedVersion;
      const offer = await this.checkFeed(true);
      if (
        offer == null ||
        !offer.isUpdateAvailable ||
        offer.updateInfo.version !== version ||
        !this.status.downloaded ||
        this.downloadedVersion !== version
      ) {
        this.dropDownloadedBuild("fresh feed check refused install");
        throw new Error(
          "The downloaded update is no longer offered to this client"
        );
      }
      this.status.installing = true;
      this.emitStatusUpdate();

      // Declare quit intent before handing off: Squirrel.Mac only closes the
      // windows, and the macOS 'close' handler hides unless a quit is underway.
      this.stopPeriodicChecks();
      this.stopAutoRestartPoll();
      markQuitting();
      if (options?.relaunchHidden) markRelaunchHidden();

      try {
        autoUpdater.quitAndInstall(options?.silent ?? false, true);
      } catch (err) {
        // No hand-off: drop the quit intent (else the next close terminates
        // instead of hiding) and resume the watchers.
        clearQuitting();
        if (options?.relaunchHidden) clearRelaunchHidden();
        if (app.isPackaged) this.startPeriodicChecks();
        this.startAutoRestartPoll();
        throw err;
      }
      this.startQuitWatchdog();
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("[UpdateService] Failed to install update:", errorMessage);
      this.status.installing = false;
      this.status.error = errorMessage;
      this.status.failedPhase = "install";
      this.emitStatusUpdate();
      return { success: false, error: errorMessage };
    }
  }

  // Backstop for an install that never quits: the installer applies on exit,
  // so escalate. Stage 1 keeps before-quit cleanup (the vm-helper would
  // otherwise collide with the relaunched app); stage 2 hard-exits.
  private startQuitWatchdog(): void {
    setTimeout(() => {
      console.warn(
        `[UpdateService] Still running ${QUIT_STALL_MS / 1000}s after install hand-off, forcing quit`
      );
      this.status.installStalled = true;
      this.emitStatusUpdate();
      try {
        app.quit();
      } catch (err) {
        console.warn(
          "[UpdateService] app.quit() during stalled install failed:",
          err
        );
      }
    }, QUIT_STALL_MS).unref();

    setTimeout(() => {
      console.warn(
        `[UpdateService] Still running ${QUIT_FORCE_MS / 1000}s after install hand-off, exiting`
      );
      app.exit(0);
    }, QUIT_FORCE_MS).unref();
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async checkForUpdatesOnStartup(): Promise<void> {
    if (!app.isPackaged) {
      console.log("[UpdateService] dev build, not checking for updates");
      return;
    }
    this.checkForUpdates();
    this.startPeriodicChecks();
  }

  // Keeps polling once a build is downloaded, so the pending install stays at
  // most one interval behind the feed.
  private startPeriodicChecks(): void {
    if (this.checkTimer != null) return;

    this.checkTimer = setInterval(() => {
      if (this.status.installing) return;

      this.checkForUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);

    this.checkTimer.unref();
  }

  stopPeriodicChecks(): void {
    if (this.checkTimer == null) return;

    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  private emitStatusUpdate(): void {
    emitBusChannel("update", this.getStatus());
  }
}

 succeeded in 67247ms:
/Users/rajaniraiyn/.local/share/mise/shims/rg
ls: /usr/local/bin/git: No such file or directory
ls: /usr/local/bin/rg: No such file or directory
import { randomUUID } from "node:crypto";
/** Digest-checked rollback from completed migration evidence, independently per profile. */
import fs from "node:fs";
import path from "node:path";

import {
  readArchiveIndexStrict,
  ARCHIVE_INDEX_NAME,
} from "../services/session/thread-store";
import { rebuildRestoreIndex } from "./attempt-records";
import {
  backupsRoot,
  formatStamp,
  sha256File,
  nodeIo,
  inside,
  writeFileAtomic,
} from "./backup";
import { readRecordState, writeRecord } from "./record";
import { runMigrations } from "./runner";
interface Generation {
  generation: string;
  at: string;
  consumed: string[];
  destinations: string[];
}
export interface RestoreResult {
  home: string;
  restored: string[];
  collisions: string[];
  skipped: string[];
}
const safePath = (root: string, relative: string): string => {
  const file = path.resolve(root, relative);
  if (inside(root, file) === null)
    throw new Error(`Restore path outside root: ${relative}`);
  return file;
};
export const profileHomes = (base: string): string[] => {
  const homes = new Set([path.resolve(base)]);
  const file = path.join(base, "profiles.json");
  if (fs.existsSync(file)) {
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const value of Object.values(registry.profiles ?? {})) {
      if (typeof value !== "string") throw new Error("Invalid profile path");
      const home = path.resolve(base, value);
      if (home !== path.resolve(base) && inside(base, home) === null)
        throw new Error("Profile outside base");
      homes.add(home);
    }
  }
  for (const home of homes) {
    let current = home;
    while (current !== path.dirname(path.resolve(base))) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink in profile path: ${current}`);
      current = path.dirname(current);
    }
  }
  return [...homes];
};
export const restoreLegacyHome = async (
  home: string,
  now = new Date()
): Promise<RestoreResult> => {
  const userData = path.join(home, "electron");
  // Finish or undo an interrupted commit before reading its completion evidence.
  const recovery = await runMigrations({
    home,
    userData,
    steps: [],
    appVersion: "restore",
    log: () => {},
  });
  if (recovery.failed || recovery.unresolved.length)
    throw new Error(`Unresolved migration in ${home}`);
  const recordState = readRecordState(home);
  if (recordState.status !== "ok" && recordState.status !== "missing")
    throw new Error(
      `Cannot restore with ${recordState.status} migration record`
    );
  const entries = rebuildRestoreIndex(home);
  const journal = path.join(backupsRoot(home), "restorations.jsonl");
  const generations: Generation[] = fs.existsSync(journal)
    ? fs
        .readFileSync(journal, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  for (const g of generations)
    if (
      typeof g.generation !== "string" ||
      !Array.isArray(g.consumed) ||
      !g.consumed.every((id) => typeof id === "string") ||
      !Array.isArray(g.destinations) ||
      !g.destinations.every((dest) => typeof dest === "string")
    )
      throw new Error("Invalid restoration journal");
  const latest = new Map<string, (typeof entries)[number]>();
  const allByDestination = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (![3, 4].includes(entry.step) || !entry.backup || !entry.originalSha256)
      continue;
    const destination = safePath(
      entry.root === "home" ? home : userData,
      entry.source
    );
    if (destination === path.join(home, "prefs.json")) continue;
    if (
      entry.op !== "remove" &&
      !(
        entry.op === "replace" &&
        destination === path.join(userData, "renderer-state.json")
      )
    )
      continue;
    if (entry.roots.home !== home || entry.roots.userData !== userData)
      throw new Error("Restore roots differ from profile");
    const consumed = new Set(
      generations
        .filter((g) => g.destinations.includes(destination))
        .flatMap((g) => g.consumed)
    );
    if (consumed.has(entry.attempt)) continue;
    const list = allByDestination.get(destination) ?? [];
    list.push(entry);
    allByDestination.set(destination, list);
    const previous = latest.get(destination);
    if (
      !previous ||
      entry.stamp > previous.stamp ||
      (entry.stamp === previous.stamp && entry.attempt > previous.attempt)
    )
      latest.set(destination, entry);
  }
  const result: RestoreResult = {
    home,
    restored: [],
    collisions: [],
    skipped: [],
  };
  const consumed = new Set<string>();
  const destinations: string[] = [];
  const index = readArchiveIndexStrict(path.join(home, "threads"));
  for (const [destination, entry] of latest) {
    const backup = safePath(
      path.join(backupsRoot(home), entry.directory),
      entry.backup!
    );
    try {
      if (sha256File(backup, nodeIo) !== entry.originalSha256) {
        result.skipped.push(`${destination}: backup digest mismatch`);
        continue;
      }
    } catch (error) {
      result.skipped.push(`${destination}: ${String(error)}`);
      continue;
    }
    // Reject symlinks along either path. No restore may follow a profile link outside its home.
    for (const file of [destination, backup]) {
      let current = file;
      while (inside(home, current) !== null) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
          throw new Error(`Symlink in restore path: ${current}`);
        current = path.dirname(current);
      }
    }
    const current = fs.existsSync(destination)
      ? sha256File(destination, nodeIo)
      : null;
    let target = destination;
    if (
      current !== null &&
      current !== entry.originalSha256 &&
      current !== entry.resultSha256
    ) {
      const parsed = path.parse(destination);
      target = path.join(
        parsed.dir,
        `${parsed.name}.restored-${formatStamp(now)}-${entry.attempt}${parsed.ext}`
      );
      if (
        fs.existsSync(target) &&
        sha256File(target, nodeIo) !== entry.originalSha256
      )
        throw new Error(`Restore collision already exists: ${target}`);
      result.collisions.push(target);
    }
    if (current !== entry.originalSha256 || target !== destination) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, fs.readFileSync(backup), nodeIo);
    }
    // Keep backup evidence for the rollback window and retry after interrupted metadata writes.
    result.restored.push(destination);
    destinations.push(destination);
    for (const op of allByDestination.get(destination) ?? [])
      consumed.add(op.attempt);
    if (
      destination.startsWith(path.join(home, "transcripts") + path.sep) ||
      destination.startsWith(path.join(home, "threads") + path.sep)
    )
      delete index.archived[
        path.basename(destination).replace(/\.(json|cleared)$/, "")
      ];
    if (destination === path.join(userData, "renderer-state.json"))
      fs.rmSync(path.join(userData, "renderer-state.retired.json"), {
        force: true,
      });
  }
  if (destinations.length) {
    writeFileAtomic(
      path.join(home, "threads", ARCHIVE_INDEX_NAME),
      JSON.stringify(index),
      nodeIo
    );
    const record = recordState.record;
    record.applied = record.applied.map((entry) =>
      [3, 4].includes(entry.id)
        ? { ...entry, restoredAt: now.toISOString() }
        : entry
    );
    record.partial = record.partial?.filter(
      (entry) => ![3, 4].includes(entry.id)
    );
    writeRecord(home, record);
    const generation: Generation = {
      generation: randomUUID(),
      at: now.toISOString(),
      consumed: [...consumed],
      destinations,
    };
    writeFileAtomic(
      journal,
      generations.map((g) => JSON.stringify(g) + "\n").join("") +
        JSON.stringify(generation) +
        "\n",
      nodeIo
    );
  }
  return result;
};
export const restoreLegacyFiles = async (
  base: string
): Promise<RestoreResult[]> => {
  const results: RestoreResult[] = [];
  for (const home of profileHomes(base))
    results.push(await restoreLegacyHome(home));
  return results;
};
import path from "node:path";

/**
 * The old renderer's durable state (`userData/renderer-state.json`) mapped
 * onto the prefs row (spec 00 C.4). One mapping, three import points: the
 * one-time migration step (`migrations/steps/002-*`), the live legacy sync
 * below (transition only; removed with the old renderer), and the final
 * import at cut-over.
 *
 * Several legacy keys can feed one prefs field (`sidebar` takes `pinned` from
 * `local-code-ui-store` and `openSection` from `sidebar-accordion`), so a
 * field is always composed from every key the old renderer holds, over the
 * field's defaults. That is also what the old renderer shows: a key it does
 * not hold means that part is at its default.
 *
 * Merges go by provenance through `PrefsStore.importLegacy` and
 * `resetLegacy`, never by default-equality. `renderer-state.json` is only
 * ever read here.
 */
import * as v from "valibot";

import { PrefsPatchSchema } from "#shared/contract/db";
import {
  SUPPORTED_LANGUAGES,
  type PrefsField,
  type PrefsPatch,
} from "#shared/contract/rows";

import { PREFS_DEFAULTS, type PrefsStore } from "./prefs-store";
import { readRendererStateFile } from "./renderer-state";
import { readRetiredPrefs, RETIRED_PREFS_FILE } from "./retired-prefs";

/** Every legacy key that maps to something, and the prefs fields it feeds. */
export const LEGACY_PREFS_KEYS: ReadonlyMap<string, readonly PrefsField[]> =
  new Map<string, readonly PrefsField[]>([
    ["theme", ["theme"]],
    ["abacusai-bot-language", ["language"]],
    [
      "local-code-ui-store",
      [
        "sidebar",
        "models",
        "defaultMode",
        "workspaceExpanded",
        "pinned",
        "lastPickedWorkspaceId",
      ],
    ],
    ["sidebar-accordion", ["sidebar"]],
    ["abacus-credits", ["creditsExhaustedAt"]],
    ["abacusai-bot-code-folder", ["recentFolders"]],
    ["browser.homepage", ["browserHomepage"]],
    ["onboarding.step", ["onboardingStep", "onboardingFlow"]],
    ["referral-card.dismissed-until", ["dismissals"]],
    ["local-code:upsell-dismissed", ["dismissals"]],
  ]);

/** The prefs fields any legacy key feeds, in row order. */
export const LEGACY_PREFS_FIELDS: readonly PrefsField[] = (
  Object.keys(PREFS_DEFAULTS) as PrefsField[]
).filter((field) =>
  Array.from(LEGACY_PREFS_KEYS.values()).some((fields) =>
    fields.includes(field)
  )
);

/** Object fields that several keys fill member by member. */
const MEMBER_FIELDS = new Set<PrefsField>([
  "sidebar",
  "models",
  "pinned",
  "dismissals",
]);

/** What one legacy key says about the fields it feeds. */
export interface LegacyKeyMapping {
  /**
   * Per field: the whole value, or for a member field (`sidebar`, `models`,
   * `pinned`, `dismissals`) the members this key holds. Members the key does
   * not hold take the field's defaults, as the old renderer's zustand merge
   * does.
   */
  values: Partial<Record<PrefsField, unknown>>;
  /** Fields the key names but whose stored value is unusable. */
  invalid: PrefsField[];
}

/**
 * The old renderer's onboarding screens (`onboarding-steps.ts` `STEP_ORDER`;
 * `legacy-prefs.test.ts` checks they match). A stored step outside it reads
 * as none there.
 */
export const LEGACY_ONBOARDING_STEPS: readonly string[] = [
  "auth",
  "welcome",
  "connectors",
  "models",
  "explainer",
];

/**
 * A legacy step id in the new renderer's vocabulary (spec 06 F10, §23.6).
 * Both vocabularies contain `"welcome"` with different meanings, so the
 * import translates before it writes, and marks the row `onboardingFlow = 2`
 * alongside; a step outside the legacy order reads as none.
 */
export const CANONICAL_ONBOARDING_STEPS: Readonly<Record<string, string>> = {
  auth: "welcome",
  welcome: "connected",
  connectors: "connectors",
  models: "models",
  explainer: "first-bot",
};

/** The onboarding vocabulary `onboardingFlow = 2` marks. */
export const ONBOARDING_FLOW = 2;

export const canonicalOnboardingStep = (legacy: string): string | null =>
  LEGACY_ONBOARDING_STEPS.includes(legacy)
    ? (CANONICAL_ONBOARDING_STEPS[legacy] ?? null)
    : null;

/**
 * `browser-homepage.ts`'s `normalizeBrowserHomepage` for a non-blank value
 * (the test checks they agree): a bare host gains `https://`, anything but
 * http(s) is null (the default).
 */
export const normalizeBrowserHomepage = (value: string): string | null => {
  const trimmed = value.trim();
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Drops members zustand would not have (absent, so the default applies). */
const defined = (members: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(members).filter(([, value]) => value !== undefined)
  );

/**
 * A zustand `persist()` value, `{ state, version }`. `version` is what the
 * store declares; a stored version that differs, for a store without
 * `migrate`, is discarded by zustand, so it holds nothing.
 */
const zustandState = (
  raw: string,
  storeVersion: number | null
): Record<string, unknown> | "invalid" | "absent" => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return "invalid";
  // zustand compares `stored.version !== options.version`, so a missing
  // version is a mismatch too, and without `migrate` the value is dropped.
  if (storeVersion !== null && parsed.version !== storeVersion) return "absent";
  return parsed.state;
};

const fromZustand = (
  raw: string,
  fields: readonly PrefsField[],
  storeVersion: number | null,
  map: (state: Record<string, unknown>) => LegacyKeyMapping["values"]
): LegacyKeyMapping | null => {
  const state = zustandState(raw, storeVersion);
  if (state === "absent") return null;
  if (state === "invalid") return { values: {}, invalid: [...fields] };
  return { values: map(state), invalid: [] };
};

/** `local-code-ui-store` (code-store.ts, version 4 with `migrate`). */
const mapCodeStore = (
  state: Record<string, unknown>
): LegacyKeyMapping["values"] => {
  // code-store.ts's migrate only deletes fields (isRightPanelVisible,
  // activeRightTab below 3; workspaceSelectedModes below 4) that map to
  // nothing, so every version reads the same way. `codeSidebarTab` is dropped:
  // the new renderer has no equivalent.
  const values: LegacyKeyMapping["values"] = {
    sidebar: defined({ pinned: state.isSidebarVisible }),
    models: defined({
      selectedModelId: state.selectedModelId,
      favoriteModelIds: state.favoriteModelIds,
      perWorkspace: state.workspaceSelectedModelIds,
    }),
    pinned: defined({
      sessionIds: state.pinnedSessionIds,
      botIds: state.pinnedBotIds,
    }),
  };
  if (state.globalSelectedMode !== undefined)
    values.defaultMode = state.globalSelectedMode;
  if (state.workspaceAccordionExpanded !== undefined)
    values.workspaceExpanded = state.workspaceAccordionExpanded;
  if (state.lastPickedWorkspaceId !== undefined)
    values.lastPickedWorkspaceId = state.lastPickedWorkspaceId;
  return values;
};

/**
 * One legacy key's contribution, or null when the key maps to nothing (or
 * holds nothing the old renderer would read). Pure; never throws.
 */
export const mapLegacyKey = (
  key: string,
  raw: string
): LegacyKeyMapping | null => {
  const fields = LEGACY_PREFS_KEYS.get(key);
  if (fields === undefined) return null;
  switch (key) {
    case "theme":
      return raw === "light" || raw === "dark" || raw === "system"
        ? { values: { theme: raw }, invalid: [] }
        : { values: {}, invalid: ["theme"] };
    case "abacusai-bot-language": {
      // As i18n.ts's storedLanguage: an explicit supported code wins; anything
      // else (corrupt, unsupported) falls through to the OS languages, which
      // is the row's "system". The version is not checked there either.
      let code: unknown;
      try {
        const parsed = JSON.parse(raw) as unknown;
        code =
          isRecord(parsed) && isRecord(parsed.state)
            ? parsed.state.languageCode
            : undefined;
      } catch {
        code = undefined;
      }
      const supported = (SUPPORTED_LANGUAGES as readonly unknown[]).includes(
        code
      );
      return {
        values: { language: supported ? code : "system" },
        invalid: [],
      };
    }
    case "local-code-ui-store":
      return fromZustand(raw, fields, null, mapCodeStore);
    case "sidebar-accordion":
      return fromZustand(raw, fields, 0, (state) => ({
        sidebar: defined({ openSection: state.openSection }),
      }));
    case "abacus-credits":
      return fromZustand(raw, fields, 0, (state) =>
        state.exhaustedAt === undefined
          ? {}
          : { creditsExhaustedAt: state.exhaustedAt }
      );
    case "abacusai-bot-code-folder":
      // `currentFolder` is dropped: the URL owns location in the new renderer.
      return fromZustand(raw, fields, 0, (state) =>
        state.recentFolders === undefined
          ? {}
          : { recentFolders: state.recentFolders }
      );
    case "browser.homepage": {
      // As browser-homepage.ts's getBrowserHomepage: blank or not http(s)
      // shows the default (the row's null); anything else is normalised.
      const normalized =
        raw.trim() === "" ? null : normalizeBrowserHomepage(raw);
      return { values: { browserHomepage: normalized }, invalid: [] };
    }
    case "onboarding.step": {
      // As onboarding-flow.tsx: a step it does not know reads as none. A
      // known one is written in the new vocabulary, with its flow marker.
      const step = canonicalOnboardingStep(raw);
      return {
        values: {
          onboardingStep: step,
          onboardingFlow: step == null ? null : ONBOARDING_FLOW,
        },
        invalid: [],
      };
    }
    case "referral-card.dismissed-until": {
      const until = Number(raw);
      return Number.isFinite(until)
        ? { values: { dismissals: { referralCardUntil: until } }, invalid: [] }
        : { values: {}, invalid: ["dismissals"] };
    }
    case "local-code:upsell-dismissed":
      // Presence is the flag (credits-exhausted-card.tsx).
      return { values: { dismissals: { upsell: true } }, invalid: [] };
    default:
      return null;
  }
};

/** The legacy state composed into prefs fields. */
export interface LegacyPrefs {
  /** Fields with a usable legacy value, validated. */
  patch: PrefsPatch;
  /** Fields the old renderer holds nothing for (it shows their defaults). */
  absent: PrefsField[];
  /** Fields it holds something unusable for; left at their current value. */
  invalid: PrefsField[];
  /**
   * Member fields with some unusable keys and some usable ones: imported
   * from the usable ones (in `patch`), and counted as invalid.
   */
  invalidMembers: PrefsField[];
  /** The mapped keys present. */
  keys: string[];
}

const FIELD_SCHEMAS = PrefsPatchSchema.entries;

/**
 * What the old renderer shows for a member no key holds. Only one differs
 * from the prefs default: a fresh old sidebar opens Bots
 * (sidebar-accordion-store.ts), while the new row starts with none.
 */
const legacyBase = (field: PrefsField): unknown =>
  field === "sidebar"
    ? { ...PREFS_DEFAULTS.sidebar, openSection: "bots" }
    : PREFS_DEFAULTS[field];

/**
 * Composes `fields` from every legacy key `read` returns a value for. Keys
 * are applied in `LEGACY_PREFS_KEYS` order.
 */
export const composeLegacyPrefs = (
  read: (key: string) => string | undefined,
  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS
): LegacyPrefs => {
  const result: LegacyPrefs = {
    patch: {},
    absent: [],
    invalid: [],
    invalidMembers: [],
    keys: [],
  };
  const mappings: LegacyKeyMapping[] = [];
  for (const key of LEGACY_PREFS_KEYS.keys()) {
    const raw = read(key);
    if (raw === undefined) continue;
    const mapping = mapLegacyKey(key, raw);
    if (mapping == null) continue;
    result.keys.push(key);
    mappings.push(mapping);
  }
  for (const field of fields) {
    const contributing = mappings.filter(
      (mapping) => field in mapping.values || mapping.invalid.includes(field)
    );
    if (contributing.length === 0) {
      result.absent.push(field);
      continue;
    }
    const valid = contributing.filter(
      (mapping) => !mapping.invalid.includes(field)
    );
    // A scalar field with any unusable key, or a member field whose every
    // key is unusable, is left at its current value. A member field keeps
    // what its usable keys hold: the old renderer shows the base for the
    // members an unusable key would have held (zustand drops a corrupt
    // store; `Number("abc")` hides nothing).
    if (
      valid.length === 0 ||
      (!MEMBER_FIELDS.has(field) && valid.length < contributing.length)
    ) {
      result.invalid.push(field);
      continue;
    }
    if (valid.length < contributing.length) result.invalidMembers.push(field);
    let value: unknown = structuredClone(legacyBase(field));
    for (const mapping of valid) {
      const part = mapping.values[field];
      value =
        MEMBER_FIELDS.has(field) && isRecord(value) && isRecord(part)
          ? { ...value, ...part }
          : part;
    }
    if (!v.safeParse(FIELD_SCHEMAS[field], value).success) {
      result.invalid.push(field);
      continue;
    }
    (result.patch as Record<string, unknown>)[field] = value;
  }
  return result;
};

export interface LegacyImportStats {
  /** Mapped keys present in the legacy state. */
  keys: number;
  /** Fields that took a legacy value (changed or not). */
  imported: number;
  /** Fields left alone because the user set them in the new UI. */
  keptUser: number;
  /** Fields with an unusable legacy value, left at their current value. */
  invalid: number;
  /** Legacy-sourced fields reset to their defaults (their keys are gone). */
  reset: number;
}

/**
 * Brings `fields` of the prefs row in line with the legacy state, by
 * provenance: a `"user"` field is never touched; a field with a legacy value
 * takes it and becomes `"legacy"`; a `"legacy"` field whose keys are gone
 * goes back to its default.
 */
export const importLegacyPrefs = (
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  read: (key: string) => string | undefined,
  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS,
  retiredKeys: ReadonlySet<string> = new Set()
): LegacyImportStats => {
  const legacy = composeLegacyPrefs(read, fields);
  const provenance = prefs.provenance();
  const named = Object.keys(legacy.patch) as PrefsField[];
  // Provenance is per leaf; a field counts as kept when any leaf of it is
  // the user's (the import skips exactly those leaves).
  const keptUser = named.filter((field) =>
    Object.entries(provenance).some(
      ([leaf, mark]) =>
        mark === "user" && (leaf === field || leaf.startsWith(`${field}.`))
    )
  );
  const { invalid } = prefs.importLegacy(legacy.patch);
  const reset = prefs.resetLegacy(
    legacy.absent.filter(
      (field) =>
        !Array.from(LEGACY_PREFS_KEYS).some(
          ([key, mapped]) =>
            mapped.includes(field) &&
            read(key) === undefined &&
            retiredKeys.has(key)
        )
    )
  );
  return {
    keys: legacy.keys.length,
    imported: named.length - keptUser.length - invalid,
    keptUser: keptUser.length,
    invalid: legacy.invalid.length + legacy.invalidMembers.length + invalid,
    reset: reset.length,
  };
};

/**
 * The old renderer's sound opt-out lives in `config.json`
 * (`notificationSoundDisabled`, `settings.ts` `readNotificationSettings`),
 * not in its durable state (spec 05 §31.5 i). An opt-out is imported into
 * `sounds.enabled = false` as `"legacy"`; once it is lifted, a legacy-sourced
 * `false` goes back to the default. A `"user"` leaf is never touched.
 * Returns what happened.
 */
export const importLegacySoundOptOut = (
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  soundDisabled: unknown
): "imported" | "kept-user" | "reset" | "none" => {
  const mark = prefs.provenance()["sounds.enabled"];
  if (mark === "user") return soundDisabled === true ? "kept-user" : "none";
  if (soundDisabled === true) {
    prefs.importLegacy({ sounds: { enabled: false } });
    return "imported";
  }
  if (mark !== "legacy") return "none";
  // Only `sounds.enabled` is ever legacy-sourced, so resetting the group's
  // legacy leaves resets exactly it.
  prefs.resetLegacy(["sounds"]);
  return "reset";
};

/** Read-only startup import kept through release N, including after N+1. */
export const importLegacyPrefsAtStartup = (
  source: string,
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">
): LegacyImportStats => {
  const legacy = readRendererStateFile(source);
  const retired = readRetiredPrefs(
    path.join(path.dirname(source), RETIRED_PREFS_FILE)
  );
  return importLegacyPrefs(
    prefs,
    (key) => legacy.get(key),
    LEGACY_PREFS_FIELDS,
    new Set(Object.keys(retired?.keys ?? {}))
  );
};

exec
/bin/zsh -c 'find /Users/rajaniraiyn/.local/share/mise/installs/ripgrep -name rg -type f; find /Users/rajaniraiyn/.local/share/mise/installs/node -name node -type f; cat scripts/cutover/release-notes.mjs docs/rewrite/going-back.md; git diff 1b14bc91..75516d5f -- apps/desktop/src/main/index.ts scripts/build-provenance.mjs apps/desktop/package.json package.json apps/desktop/vitest.config.ts' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 5817ms:
/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg
/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node
/Users/rajaniraiyn/.local/share/mise/installs/node/22.19.0/bin/node
/Users/rajaniraiyn/.local/share/mise/installs/node/26.10.0/bin/node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSource, walk } from "./parsed-source.mjs";

export const visibleNotes = (files) =>
  files.flatMap((file) => {
    const rows = [];
    walk(parseSource(file).program, (node) => {
      if (node.type !== "ObjectExpression") return;
      const row = Object.fromEntries(
        node.properties
          .filter((p) => p.type === "Property" && p.value.type === "Literal")
          .map((p) => [p.key.name ?? p.key.value, p.value.value])
      );
      if (
        row.visible === true &&
        ["retired", "deferred"].includes(row.status)
      ) {
        if (!row.id || !row.reason)
          throw new Error(`Missing note metadata in ${file}`);
        rows.push(
          `- ${row.reason}${row.status === "deferred" ? " Not in this version." : ""}`
        );
      }
    });
    return rows;
  });
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = "apps/desktop/src/renderer/features";
  const files = fs
    .readdirSync(base)
    .map((area) => path.join(base, area, "parity.ts"))
    .filter((file) => fs.existsSync(file));
  const output =
    "# User-visible parity changes\n\n" + visibleNotes(files).join("\n") + "\n";
  fs.writeFileSync("docs/rewrite/reports/07-release-notes.md", output);
}
# Going back to the previous version

Quit AbacusAI Bot before installing the previous version.

After release N, the previous version opens the bots, sessions, routines and settings left before the update. Conversations and preference changes made in N do not appear in that version. N leaves the legacy files in place. Reinstalling N shows the new conversations again.

After release N+1, restore the legacy files before installing a legacy version. Run the installed N+1 or newer executable once with `--restore-legacy-files`:

- macOS: `"/Applications/AbacusAI-Bot.app/Contents/MacOS/AbacusAI-Bot" --restore-legacy-files`
- Windows PowerShell: `& "$env:LOCALAPPDATA\Programs\AbacusAI-Bot\AbacusAI-Bot.exe" --restore-legacy-files`
- Linux: `/path/to/abacusai-bot --restore-legacy-files`

Use the executable at your installed location if it differs. The command checks every profile, prints a report and exits. It verifies backups against their recorded digests and rebuilds a damaged restore index. Preferences in prefs.json stay authoritative. An existing file with different content stays in place; the restored copy is written beside it with `.restored-` in its name and listed in the report. Send skipped-file or collision reports to support before installing the legacy version. Backups are kept for 30 days.

If the command cannot start, contact support. Do not move backup files by hand. A second restore after another N+1 migration uses the newer cycle's backups.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-Hvu0upfI' (errno=Operation not permitted)
2026-10-01 15:22:26.981 xcodebuild[58702:4420823]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:22:27.202 xcodebuild[58702:4420822] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-8ofweVai' (errno=Operation not permitted)
2026-10-01 15:22:28.358 xcodebuild[58707:4420847]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:22:28.734 xcodebuild[58707:4420843] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
diff --git a/apps/desktop/package.json b/apps/desktop/package.json
index 2af901af..773ab297 100644
--- a/apps/desktop/package.json
+++ b/apps/desktop/package.json
@@ -1,6 +1,6 @@
 {
   "name": "@abacus-ai/desktop",
-  "version": "1.0.12",
+  "version": "1.0.13",
   "private": true,
   "description": "AbacusAI Bot: free, open-source personal agents for your messaging apps, tools and services.",
   "homepage": "https://github.com/abacusai/abacusai-bot",
@@ -31,13 +31,6 @@
       "./src/shared/*/index.ts",
       "./src/shared/*"
     ],
-    "#next/*": [
-      "./src/renderer-next/*.tsx",
-      "./src/renderer-next/*.ts",
-      "./src/renderer-next/*/index.tsx",
-      "./src/renderer-next/*/index.ts",
-      "./src/renderer-next/*"
-    ],
     "#locales/*": [
       "./src/renderer/locales/*"
     ]
@@ -45,29 +38,35 @@
   "scripts": {
     "build": "vite build",
     "check:i18n": "node scripts/check-jsx-i18n.js",
-    "check:legacy-diff": "node scripts/check-legacy-renderer-diff.mjs",
-    "check:locales": "node scripts/sync-locales.js --check",
+    "check:locales": "node scripts/sync-locales.js --check && node --test scripts/i18n-dynamic-keys.test.mjs",
     "check:react-compiler": "node scripts/check-react-compiler.mjs",
     "check:packaged": "node scripts/check-packaged-resources.js",
     "check:ui-registry": "node scripts/shadcn-registry-snapshot.mjs --check",
     "dev": "vite",
-    "dev:next": "ABACUSBOT_RENDERER_GENERATION=wco vite",
-    "dev:next:fixtures": "ABACUSBOT_RENDERER_GENERATION=wco VITE_NEXT_DB_FIXTURES=1 vite",
     "experience": "node scripts/build-experience.js",
     "package": "electron-builder --config electron-builder.yml",
     "package:dir": "electron-builder --config electron-builder.yml --dir",
     "package:linux": "electron-builder --config electron-builder.yml --linux",
     "package:mac": "electron-builder --config electron-builder.yml --mac",
     "package:win": "electron-builder --config electron-builder.yml --win",
-    "screenshots:next": "node scripts/screenshots-next.mjs",
     "start": "electron .",
     "sync:locales": "node scripts/sync-locales.js",
     "test": "vitest run",
     "test:coverage": "vitest run --coverage",
-    "test:unit": "vitest run --project shared --project main --project renderer --project renderer-next",
+    "test:unit": "vitest run --project shared --project main --project renderer",
     "test:watch": "vitest",
     "typecheck": "tsc -b",
-    "vendor": "node scripts/download-scrcpy.js && node scripts/download-wa-js.js && node scripts/download-llama-server.js"
+    "vendor": "node scripts/download-scrcpy.js && node scripts/download-wa-js.js && node scripts/download-llama-server.js",
+    "dev:fixtures": "VITE_NEXT_DB_FIXTURES=1 vite",
+    "screenshots": "node scripts/screenshots.mjs",
+    "check:release": "node scripts/check-release-build.mjs",
+    "generate:notices": "node scripts/generate-notices.js",
+    "generate:routes": "node scripts/generate-routes.mjs",
+    "check:chat-bundle": "node scripts/check-chat-bundle.mjs",
+    "measure:size": "node scripts/measure-release-size.mjs",
+    "smoke:rpc": "node scripts/rpc-ws-smoke.mjs",
+    "sync:chat-fixtures": "node scripts/sync-chat-fixtures.mjs",
+    "ui:add": "shadcn add"
   },
   "dependencies": {
     "@ff-labs/fff-node": "^0.9.6",
@@ -91,13 +90,10 @@
     "@abacus-ai/test-support": "workspace:*",
     "@abacus-ai/updater": "workspace:*",
     "@base-ui/react": "^1.8.0",
-    "@dicebear/core": "^10.7.0",
-    "@dicebear/styles": "^10.6.0",
     "@fontsource-variable/inter": "^5.3.0",
     "@fontsource-variable/jetbrains-mono": "^5.3.0",
     "@huggingface/transformers": "^4.3.0",
-    "@lobehub/icons-static-svg": "^1.94.0",
-    "@monaco-editor/react": "^4.7.0",
+    "@orpc/shared": "1.15.4",
     "@orpc/tanstack-query": "1.15.4",
     "@pierre/trees": "1.0.0-beta.6",
     "@shadcn/react": "^0.3.1",
@@ -107,6 +103,7 @@
     "@tanstack/ai-react": "0.29.3",
     "@tanstack/db": "0.9.2",
     "@tanstack/highlight": "0.0.10",
+    "@tanstack/hotkeys": "0.10.1",
     "@tanstack/markdown": "0.0.13",
     "@tanstack/react-db": "0.4.1",
     "@tanstack/react-devtools": "0.10.13",
@@ -120,12 +117,10 @@
     "@tanstack/react-router": "1.170.40",
     "@tanstack/react-router-devtools": "1.167.2",
     "@tanstack/react-store": "^0.11.2",
+    "@tanstack/router-generator": "1.167.39",
     "@tanstack/router-plugin": "1.168.41",
     "@testing-library/dom": "^10.4.1",
     "@testing-library/react": "^16.3.2",
-    "@tsparticles/engine": "^4.3.2",
-    "@tsparticles/react": "^4.3.2",
-    "@tsparticles/slim": "^4.3.2",
     "@types/node": "catalog:",
     "@types/qrcode": "^1.5.6",
     "@types/react": "catalog:",
@@ -135,38 +130,33 @@
     "@vitest/coverage-v8": "catalog:",
     "axe-core": "4.13.0",
     "class-variance-authority": "^0.7.1",
-    "clsx": "^2.1.1",
     "cmdk": "1.1.1",
     "cn": "0.4.0",
     "diff": "^8.0.3",
     "electron": "44.4.5",
     "electron-builder": "^26.15.3",
-    "framer-motion": "^12.29.0",
+    "es-module-lexer": "2.3.2",
     "ghostty-web": "0.4.0",
     "i18next": "^25.8.7",
     "jsdom": "^30.0.1",
-    "katex": "^0.16.45",
     "lucide-react": "^1.49.0",
-    "monaco-editor": "^0.55.1",
     "motion": "^13.4.6",
+    "onnxruntime-web": "1.31.0-dev.20260914-8d85527a0",
+    "oxc-parser": "0.150.0",
     "oxc-transform-react": "0.145.0",
     "react": "catalog:",
     "react-dom": "catalog:",
     "react-i18next": "^16.5.4",
     "react-resizable-panels": "4.14.1",
-    "react-tourlight": "^0.3.0",
+    "rolldown": "1.2.4",
     "shadcn": "4.21.0",
-    "sonner": "^2.0.7",
     "spdx-license-list": "^6.12.0",
-    "tailwind-merge": "^3.6.0",
     "tailwindcss": "^4.3.3",
     "temml": "0.13.5",
     "tw-animate-css": "^1.4.0",
     "typescript": "catalog:",
-    "uuid": "^13.0.2",
     "vite": "catalog:",
     "vite-plugin-electron": "^1.1.1",
-    "vitest": "catalog:",
-    "zustand": "^5.0.10"
+    "vitest": "catalog:"
   }
 }
diff --git a/apps/desktop/src/main/index.ts b/apps/desktop/src/main/index.ts
index 4c01f504..5ad201f7 100644
--- a/apps/desktop/src/main/index.ts
+++ b/apps/desktop/src/main/index.ts
@@ -23,7 +23,6 @@ import {
   Notification,
   powerMonitor,
   Menu,
-  clipboard,
   crashReporter,
   autoUpdater as nativeAutoUpdater,
   webContents as electronWebContents,
@@ -31,18 +30,13 @@ import {
 import type { WebContents } from "electron";
 import Store from "electron-store";
 
-import type {
-  AbacusAccountInfo,
-  OpenFilePathResult,
-  UsageSnapshot,
-} from "#shared/contracts";
+import type { AbacusAccountInfo, UsageSnapshot } from "#shared/contracts";
 
+import { restoreLegacyFiles } from "./migrations/restore-legacy";
 import { NotchController } from "./notch/controller";
 import { wireMainNotchEvents } from "./notch/main-events";
-import {
-  NOTCH_BANNER_SUPPRESSION,
-  NotchNotificationPolicy,
-} from "./notch/notifications";
+import { NotchNotificationPolicy } from "./notch/notifications";
+import { profileBaseDir } from "./profile-home";
 
 /**
  * Where Playwright's default `chrome` channel looks for Google Chrome (stable
@@ -80,29 +74,19 @@ export function hasGoogleChrome(
   });
 }
 import type { WindowChromeState, WindowState } from "#shared/contract";
-import { FOUNDATION_API } from "#shared/experience";
 import { funnelDetail, isFunnelStep } from "#shared/funnel";
 import { PROVIDER_ENV_VARS } from "#shared/settings";
-import type {
-  ImportLocalSkillsRequest,
-  InstallSkillRequest,
-  ListInstalledSkillsRequest,
-  OpenSkillFileRequest,
-  RemoveSkillRequest,
-  SearchMarketplaceSkillsRequest,
-} from "#shared/skills-types";
 
 import { markQuitting, isQuitting } from "./app-quit-state";
 import { setBringToFront, setMainWindow } from "./bring-to-front";
-import { readClipboardImage } from "./clipboard-image";
 import { installCrashGuard } from "./crash-guard";
 import { isSafeExternalUrl } from "./external-links";
 import {
   disposeLocalModels,
-  registerIpcHandlers,
+  wireHostEvents,
   type HostOperations,
 } from "./handler";
-import { followMainAgentBusy, registerKeepAwakeHandlers } from "./keep-awake";
+import { followMainAgentBusy } from "./keep-awake";
 import { decideLocalOpen } from "./local-open-guard";
 import {
   disposeMigrationProgress,
@@ -120,7 +104,6 @@ import {
   rendererEntry,
   type RendererBase,
 } from "./renderer-entry";
-import { RENDERER_GENERATION } from "./renderer-generation";
 import {
   RendererHost,
   RendererSwapScheduler,
@@ -141,21 +124,18 @@ import {
 } from "./rpc/transports/message-port";
 import { publishToWindowViews } from "./rpc/window-events";
 import { ServiceHost } from "./service-host";
-import { registerBrowserRuntimeIpcHandlers } from "./services/browser/browser-runtime-handler";
 import { ElectronBrowserRuntime } from "./services/browser/electron-browser-runtime";
 import type { BrowserRuntimeWindow } from "./services/browser/electron-browser-runtime";
-import { installLegacyPrefsSync } from "./services/config/legacy-prefs";
+import {
+  importLegacyPrefsAtStartup,
+  importLegacySoundOptOut,
+} from "./services/config/legacy-prefs";
 import { createLoginItem } from "./services/config/login-item";
 import { notificationSilent } from "./services/config/notification-policy";
 import { PrefsStore, prefsFile } from "./services/config/prefs-store";
-import {
-  registerRendererState,
-  type RendererStateStore,
-} from "./services/config/renderer-state";
 import {
   readNotificationSettings,
   readLegacySoundOptOut,
-  onNotificationSettingsWritten,
   readSettings,
 } from "./services/config/settings";
 import {
@@ -186,7 +166,6 @@ import {
 } from "./services/updates/experience/runtime";
 import type { ExperienceRuntime } from "./services/updates/experience/runtime";
 import { consumeRelaunchHidden } from "./services/updates/relaunch-hidden";
-import { registerUpdateHandlers } from "./services/updates/update-handler";
 import { UpdateService } from "./services/updates/update-service";
 import { openHostFile } from "./services/workspace/host-path";
 import { runSmoke } from "./smoke";
@@ -370,7 +349,6 @@ function revealMainWindow(): BaseWindow | null {
   if (win.isMinimized()) win.restore();
   win.show();
   win.focus();
-  backgroundTaskNotified = false;
   return win;
 }
 
@@ -378,40 +356,9 @@ setBringToFront(() => {
   revealMainWindow();
 });
 
-// One notification per background stint. Main-process strings stay in
-// English: i18n is renderer-only.
-let backgroundTaskNotified = false;
-function notifyTaskRunningInBackground(): void {
-  if (
-    backgroundTaskNotified ||
-    (RENDERER_GENERATION === "wco" &&
-      NOTCH_BANNER_SUPPRESSION &&
-      notchController?.hasSeen())
-  )
-    return;
-  const prefs = readNotificationSettings();
-  if (!prefs.enabled) return;
-  backgroundTaskNotified = true;
-  try {
-    const notification = new Notification({
-      title: "Task still running",
-      body: "We'll notify you when it finishes.",
-      silent: notificationSilent(RENDERER_GENERATION, prefs.sound),
-    });
-    notification.on("click", () => revealMainWindow());
-    notification.show();
-  } catch {
-    // Headless or unsupported environments; non-fatal.
-  }
-}
-
 const workspaceServiceHost = new ServiceHost();
 // A downloaded update restarts only when nothing user-visible is running.
-const legacySmokeReady = new Set<number>();
-if (process.env.ABACUSAI_BOT_SMOKE_TEST === "1")
-  ipcMain.on("renderer-ready", (event) =>
-    legacySmokeReady.add(event.sender.id)
-  );
+
 const updateService = new UpdateService({
   isSafeToRestart: () =>
     !workspaceServiceHost.hasActiveAgentTurn() &&
@@ -428,9 +375,6 @@ let reloadRendererContent: (() => void) | null = null;
 // while input is recent.
 const RENDERER_ACTIVITY_HOLD_MS = 15_000;
 let lastRendererActivity = 0;
-ipcMain.on("renderer-activity", () => {
-  appOperations.markRendererActivity();
-});
 
 /**
  * Swap to a newly activated renderer bundle at the first quiet moment. The
@@ -444,10 +388,7 @@ const rendererSwaps = new RendererSwapScheduler({
   // version has nothing to swap to (the newer one's schedule settles).
   target: (version) =>
     experienceRuntime?.store.version === version
-      ? experienceEntryUrl(
-          experienceRuntime.activeRendererUrl(),
-          RENDERER_GENERATION
-        )
+      ? experienceEntryUrl(experienceRuntime.activeRendererUrl())
       : null,
   host: () => rendererHost,
   busy: () =>
@@ -456,7 +397,7 @@ const rendererSwaps = new RendererSwapScheduler({
     Date.now() - lastRendererActivity < RENDERER_ACTIVITY_HOLD_MS,
   // The integrity check admits only experiences built for this shell's
   // FOUNDATION_API, so this is also the candidate's contract.
-  barrier: FOUNDATION_API >= 2 ? "subscriptions" : "first-commit",
+  barrier: "subscriptions",
   // Activation is transactional with readiness (spec 07 review r1 #9).
   onOutcome: (version, outcome, detail) => {
     const store = experienceRuntime?.store;
@@ -514,13 +455,10 @@ let chromeCapability: ChromeCapability = "native-frame";
 
 function currentChromeInput() {
   return {
-    mode: RENDERER_GENERATION,
     platform: process.platform,
     dark: nativeTheme.shouldUseDarkColors,
     reducedTransparency: nativeTheme.prefersReducedTransparency,
-    overlayHeight: toolbarHeight(
-      RENDERER_GENERATION === "wco" ? getTitlebarDensity() : "comfortable"
-    ),
+    overlayHeight: toolbarHeight(getTitlebarDensity()),
     linuxMode: activeLinuxChromeMode,
   };
 }
@@ -648,14 +586,11 @@ async function createWindow(restored?: RecreatedWindowState) {
   }
 
   activeLinuxChromeMode =
-    RENDERER_GENERATION === "wco" &&
-    process.platform === "linux" &&
-    useLinuxNativeFrame()
+    process.platform === "linux" && useLinuxNativeFrame()
       ? "native-frame"
       : linuxChromeMode(process.env);
   chromeCapability =
-    RENDERER_GENERATION === "legacy" ||
-    (process.platform === "linux" && activeLinuxChromeMode === "native-frame")
+    process.platform === "linux" && activeLinuxChromeMode === "native-frame"
       ? "native-frame"
       : "overlay-pending";
 
@@ -664,7 +599,6 @@ async function createWindow(restored?: RecreatedWindowState) {
   // scheme's (transparent only under vibrancy/mica). The legacy renderer
   // sets its own theme through `theme:set`; its options are unchanged.
   const windowOptions = mainWindowOptions({
-    generation: RENDERER_GENERATION,
     prefs: prefsStore,
     nativeTheme,
     chromeInput: currentChromeInput,
@@ -686,7 +620,7 @@ async function createWindow(restored?: RecreatedWindowState) {
   // The renderer lives in the RendererHost's view, so an update can replace it.
   const mainWindow = new BaseWindow(windowOptions);
   mainWindowRef = mainWindow;
-  if (RENDERER_GENERATION === "wco") {
+  {
     const unsubscribeChromeTheme = subscribeWindowChromeTheme(
       nativeTheme,
       refreshWindowChrome
@@ -703,10 +637,7 @@ async function createWindow(restored?: RecreatedWindowState) {
   setMainWindow(mainWindow);
   const publishFullScreenState = (): void => {
     if (mainWindow.isDestroyed()) return;
-    rendererWebContents()?.send(
-      "window:full-screen-changed",
-      mainWindow.isFullScreen()
-    );
+
     publishWindowState();
     publishChromeState();
   };
@@ -790,7 +721,6 @@ async function createWindow(restored?: RecreatedWindowState) {
 
     if (process.platform === "darwin") {
       event.preventDefault();
-      if (taskRunning) notifyTaskRunningInBackground();
       // Hiding a full-screen window leaves its Space behind as a black
       // screen; leave full screen first and hide after the transition.
       if (mainWindow.isFullScreen()) {
@@ -819,7 +749,6 @@ async function createWindow(restored?: RecreatedWindowState) {
     if (choice === 0) {
       event.preventDefault();
       mainWindow.hide();
-      notifyTaskRunningInBackground();
     }
   });
 
@@ -852,7 +781,7 @@ async function createWindow(restored?: RecreatedWindowState) {
         // A verified installed experience supersedes the asar baseline.
         console.log(`[experience] serving renderer from ${base.url.href}`);
       notchBase = base;
-      const entry = rendererEntry(base, RENDERER_GENERATION);
+      const entry = rendererEntry(base);
       void (
         entry.kind === "url"
           ? contents.loadURL(entry.url)
@@ -919,14 +848,10 @@ async function createWindow(restored?: RecreatedWindowState) {
       if (!isVisible) {
         mainWindow.center();
       }
-      if (RENDERER_GENERATION === "wco")
-        publishChromeCapability(chromeCapability);
+      publishChromeCapability(chromeCapability);
       // A silent update restart of a hidden window comes back hidden.
       if (!startHiddenAfterUpdate) mainWindow.show();
-      if (
-        RENDERER_GENERATION === "wco" &&
-        chromeCapability === "overlay-pending"
-      ) {
+      if (chromeCapability === "overlay-pending") {
         let retryTimer: ReturnType<typeof setTimeout> | undefined;
         mainWindow.once("closed", () => clearTimeout(retryTimer));
         const probeAfterShow = (): void => {
@@ -1140,8 +1065,8 @@ async function createWindow(restored?: RecreatedWindowState) {
       preload: join(import.meta.dirname, "../preload/index.cjs"),
       sandbox: false,
       backgroundThrottling: false,
-      webviewTag: true,
       spellcheck: true,
+      webviewTag: true,
     },
     window: mainWindow,
     wire: wireRendererContents,
@@ -1461,7 +1386,7 @@ const appOperations: AppOperations = {
         const notification = new Notification({
           title,
           body,
-          silent: notificationSilent(RENDERER_GENERATION, prefs.sound),
+          silent: notificationSilent(),
         });
         notification.on("click", () => {
           const win = revealMainWindow();
@@ -1639,12 +1564,12 @@ const appOperations: AppOperations = {
 
   async setTitlebarDensity(value) {
     const density = setTitlebarDensity(value);
-    if (RENDERER_GENERATION === "wco") {
+    {
       refreshWindowChrome();
       publishChromeState();
       if (process.platform === "darwin") await recreateMainWindow();
     }
-    return { density, appliesOnRestart: RENDERER_GENERATION === "legacy" };
+    return { density, appliesOnRestart: false };
   },
 
   loginItem: createLoginItem(app),
@@ -1675,9 +1600,6 @@ function publishChromeState(): void {
   if (contents == null) return;
   const chrome: WindowChromeState = chromeState();
   // The legacy renderer: the live view only, as before.
-  if (RENDERER_GENERATION === "wco")
-    contents.send("window:chrome-changed", chrome);
-  // Every view in the window, a swap candidate included.
   publishToWindowViews(
     emitBusChannel,
     rpcTransport?.registeredIds("main") ?? [],
@@ -1703,13 +1625,9 @@ function wireNotchContents(contents: WebContents): void {
   rpcTransport?.registerRendererContents(contents, "notch");
 }
 
-function installRpc(
-  host: HostOperations,
-  rendererState: RendererStateStore
-): void {
+function installRpc(host: HostOperations): void {
   notchController = new NotchController({
     platform: process.platform,
-    generation: RENDERER_GENERATION,
     packaged: app.isPackaged,
     preload: join(import.meta.dirname, "../preload/index.cjs"),
     prefs: () => prefsStore.get(),
@@ -1752,7 +1670,6 @@ function installRpc(
     app: appOperations,
     browserRuntime,
     update: updateService,
-    rendererState,
     windows: {
       mainRendererId: () => rendererWebContents()?.id ?? null,
       contents: (id) => {
@@ -1840,6 +1757,18 @@ app
       });
     }
 
+    if (process.argv.includes("--restore-legacy-files")) {
+      try {
+        const report = await restoreLegacyFiles(profileBaseDir());
+        console.log(JSON.stringify(report, null, 2));
+        app.exit(report.some((profile) => profile.skipped.length > 0) ? 1 : 0);
+      } catch (error) {
+        console.error("[restore-legacy-files]", error);
+        app.exit(1);
+      }
+      return;
+    }
+
     app.setAppUserModelId("ai.abacus.bot");
 
     // Serve the renderer CSP as a response header too (see renderer-csp.ts).
@@ -1874,7 +1803,6 @@ app
     if (sessionPrefs !== prefsFile())
       prefsStore = new PrefsStore({ file: sessionPrefs });
 
-    registerUpdateHandlers(updateService);
     workspaceServiceHost.initialize();
     // A profile relaunch lands here already signed in, so the sign-in handler
     // that normally restores the stash never ran.
@@ -1888,22 +1816,18 @@ app
         );
     });
     workspaceServiceHost.start();
-    const rendererState = registerRendererState();
-    // The old renderer is the shipped UI until the cut-over: its durable
-    // state keeps `prefs.json` current, by provenance (spec 00 C.4).
-    installLegacyPrefsSync(
-      rendererState,
-      prefsStore,
-      undefined,
-      {
-        read: readLegacySoundOptOut,
-        onWrite: onNotificationSettingsWritten,
-      },
-      path.join(app.getPath("userData"), "renderer-state.json")
-    );
-    const hostOperations = registerIpcHandlers(workspaceServiceHost);
+    try {
+      importLegacyPrefsAtStartup(
+        path.join(app.getPath("userData"), "renderer-state.json"),
+        prefsStore
+      );
+      importLegacySoundOptOut(prefsStore, readLegacySoundOptOut());
+    } catch (error) {
+      console.error("[legacy-prefs] startup import failed", error);
+    }
+    const hostOperations = wireHostEvents(workspaceServiceHost);
     // After the dispatcher: the router shares the handlers' operations.
-    installRpc(hostOperations, rendererState);
+    installRpc(hostOperations);
     // `prefs.theme` drives the native theme (spec 00 B.2), as `theme:set`
     // does for the legacy renderer.
     followPrefsTheme(prefsStore, nativeTheme, refreshWindowChrome);
@@ -1915,10 +1839,7 @@ app
         isPackaged: app.isPackaged,
       });
     }
-    registerBrowserRuntimeIpcHandlers(
-      browserRuntime,
-      () => rendererWebContents()?.id ?? null
-    );
+
     workspaceServiceHost.startCronScheduler();
 
     // Reap devices a previous run booted but never shut down (force quit and
@@ -1927,7 +1848,6 @@ app
       .shutdownDevicesBootedByUs()
       .catch(() => undefined);
 
-    registerKeepAwakeHandlers();
     // Keep-awake follows the relay's run state too, re-evaluated at every
     // AG-UI run start and terminal (spec 07 review r1 #10), starting from the
     // value it already has (the relay and the cron scheduler started above).
@@ -1972,19 +1892,6 @@ app
         /* cleanup is non-essential */
       }
     })();
-    ipcMain.handle("open-external", (_event, url: string) =>
-      appOperations.openExternal(url)
-    );
-
-    ipcMain.handle(
-      "open-file-path",
-      (_event, filePath: string): Promise<OpenFilePathResult> =>
-        appOperations.openFilePath(filePath)
-    );
-
-    ipcMain.handle("show-item-in-folder", (_event, filePath: string) => {
-      appOperations.showItemInFolder(filePath);
-    });
 
     app.setAboutPanelOptions({
       applicationName: APP_DISPLAY_NAME,
@@ -2019,63 +1926,17 @@ app
         ])
       );
     }
-    ipcMain.handle("get-app-version", () => appOperations.appVersion());
-    ipcMain.handle("window:show-about", () => appOperations.showAboutPanel());
-    ipcMain.handle(
-      "window:is-full-screen",
-      () => mainWindowRef?.isFullScreen() ?? false
-    );
 
     // Relaunch after adding skills so new agent processes load them at startup.
-    ipcMain.handle("restart-app", () => {
-      appOperations.restartApp();
-    });
-
-    ipcMain.handle("get-home-dir", () => appOperations.homeDir());
-
-    ipcMain.handle("has-google-chrome", () => appOperations.hasGoogleChrome());
-
-    ipcMain.handle(
-      "theme:set",
-      (_event, source: "system" | "light" | "dark") => {
-        if (source !== "system" && source !== "light" && source !== "dark") {
-          throw new Error("Invalid theme source");
-        }
-        nativeTheme.themeSource = source;
-
-        refreshWindowChrome();
-
-        return nativeTheme.shouldUseDarkColors;
-      }
-    );
 
     // The same state the oRPC renderer reads through `window.chrome`.
-    ipcMain.handle("window:chrome", () => chromeState());
-    if (RENDERER_GENERATION === "wco")
-      ipcMain.handle("window:recreate", () => recreateMainWindow());
-    ipcMain.handle("settings:set-titlebar-density", (_event, value: unknown) =>
-      appOperations.setTitlebarDensity(value)
-    );
 
     // `on`, not `handle`: the renderer must never wait on main to log a line.
-    ipcMain.on("append-logs", (_event, lines: unknown) => {
-      appOperations.appendLogs(lines);
-    });
-
-    ipcMain.handle("save-logs", (_event, rendererLogs: string) =>
-      appOperations.saveLogs(rendererLogs)
-    );
 
     // The local account; see shared/account.ts for why it is optional.
-    ipcMain.handle("account:get", () => appOperations.account.get());
-    ipcMain.handle("account:skip", () => appOperations.account.skip());
-    ipcMain.handle("account:sign-out", () => appOperations.account.signOut());
-    ipcMain.handle("account:forget", () => appOperations.account.forget());
 
     // First-run milestones; see services/debug-sync/funnel-beacon.ts.
-    ipcMain.on("funnel:step", (_event, step: unknown, detail: unknown) => {
-      appOperations.reportFunnelStep(step, detail);
-    });
+
     reportFunnelStep(
       "app_opened",
       (readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? "").trim().length >
@@ -2084,174 +1945,14 @@ app
         : "signed_out"
     );
 
-    ipcMain.handle("open-folder-dialog", () =>
-      appOperations.openFolderDialog()
-    );
-
-    ipcMain.handle(
-      "files:read-image-as-data-url",
-      (_event, args: { filePath?: string; hostRoot?: string }) =>
-        appOperations.readImageAsDataUrl(args)
-    );
-
-    ipcMain.handle(
-      "files:read-file-as-text",
-      (
-        _event,
-        args: { filePath?: string; hostRoot?: string; maxBytes?: number }
-      ) => appOperations.readFileAsText(args)
-    );
-
-    ipcMain.handle(
-      "files:read-pptx",
-      (_event, args: { filePath?: string; hostRoot?: string }) =>
-        appOperations.readPptx(args)
-    );
-
-    ipcMain.handle("open-files-dialog", (_event, kind?: "all" | "image") =>
-      appOperations.openFilesDialog(kind)
-    );
-
     // Backs the "Paste image" attach item, which has no paste event to read
     // because the click happens in a menu. Null when there is no image.
-    ipcMain.handle("read-clipboard-image", () =>
-      readClipboardImage({
-        read: () => clipboard.read(),
-        toPNG: (data) => nativeImage.createFromBuffer(data).toPNG(),
-        logError: (error) =>
-          console.error("[clipboard] failed to read image", error),
-      })
-    );
 
     // A user-directed fetch of a user-typed address for staging as an
     // attachment. http/https only, and capped so an endless body cannot wedge
     // the app.
-    ipcMain.handle("fetch-url-attachment", async (_event, rawUrl: string) => {
-      const MAX_BYTES = 25 * 1024 * 1024;
-      let url: URL;
-      try {
-        url = new URL(String(rawUrl ?? "").trim());
-      } catch {
-        return { success: false, error: "That is not a valid URL." };
-      }
-      if (url.protocol !== "http:" && url.protocol !== "https:") {
-        return {
-          success: false,
-          error: "Only http:// and https:// URLs can be attached.",
-        };
-      }
-
-      const controller = new AbortController();
-      const timeout = setTimeout(() => controller.abort(), 30_000);
-      try {
-        const response = await fetch(url, {
-          signal: controller.signal,
-          redirect: "follow",
-        });
-        if (!response.ok) {
-          return {
-            success: false,
-            error: `Request failed (${response.status} ${response.statusText}).`,
-          };
-        }
-        const declared = Number(response.headers.get("content-length") ?? "0");
-        if (Number.isFinite(declared) && declared > MAX_BYTES) {
-          return { success: false, error: "That file is larger than 25 MB." };
-        }
-        const buffer = Buffer.from(await response.arrayBuffer());
-        if (buffer.length > MAX_BYTES) {
-          return { success: false, error: "That file is larger than 25 MB." };
-        }
-
-        const mimeType = (
-          response.headers.get("content-type") ?? "application/octet-stream"
-        )
-          .split(";")[0]
-          .trim();
-        // Falls back to the host so a URL ending in "/" is still recognisable.
-        const base = path.basename(url.pathname).trim();
-        const hasExt = base.includes(".") && !base.endsWith(".");
-        const extFromMime =
-          mimeType === "text/html"
-            ? ".html"
-            : mimeType === "application/pdf"
-              ? ".pdf"
-              : mimeType.startsWith("image/")
-                ? `.${mimeType.slice("image/".length)}`
-                : mimeType.startsWith("text/")
-                  ? ".txt"
-                  : "";
-        const name =
-          base.length > 0 && hasExt
-            ? base
-            : `${(base.length > 0 ? base : url.hostname).replace(/[^\w.-]+/g, "-")}${extFromMime}`;
-
-        return { success: true, file: { name, data: buffer, mimeType } };
-      } catch (err) {
-        const aborted =
-          (err as { name?: string } | null)?.name === "AbortError";
-        return {
-          success: false,
-          error: aborted
-            ? "The request timed out."
-            : `Could not fetch that URL: ${err instanceof Error ? err.message : String(err)}`,
-        };
-      } finally {
-        clearTimeout(timeout);
-      }
-    });
-
-    ipcMain.handle(
-      "show-notification",
-      (
-        _event,
-        title: string,
-        body: string,
-        metadata?: { tab?: string; workspaceId?: string; sessionId?: string }
-      ) => {
-        appOperations.showNotification(title, body, metadata);
-      }
-    );
-
-    ipcMain.handle(
-      "save-pasted-temp-files",
-      (
-        _event,
-        baseFolder: string,
-        files: Array<{ name: string; data: Uint8Array }>
-      ) => appOperations.savePastedTempFiles(baseFolder, files)
-    );
 
     // Skills management and marketplace (api.skills.*).
-    ipcMain.handle(
-      "skills-list-installed",
-      (_event, request: ListInstalledSkillsRequest) => {
-        return workspaceServiceHost.skillsService.listInstalled(request ?? {});
-      }
-    );
-    ipcMain.handle(
-      "skills-search-marketplace",
-      (_event, request: SearchMarketplaceSkillsRequest) => {
-        return workspaceServiceHost.skillsService.searchMarketplace(request);
-      }
-    );
-    ipcMain.handle("skills-install", (_event, request: InstallSkillRequest) => {
-      return workspaceServiceHost.skillsService.install(request);
-    });
-    ipcMain.handle("skills-remove", (_event, request: RemoveSkillRequest) => {
-      return workspaceServiceHost.skillsService.remove(request);
-    });
-    ipcMain.handle(
-      "skills-open-file",
-      (_event, request: OpenSkillFileRequest) => {
-        return workspaceServiceHost.skillsService.openFile(request);
-      }
-    );
-    ipcMain.handle(
-      "skills-import-local",
-      (_event, request: ImportLocalSkillsRequest) =>
-        appOperations.importLocalSkills(request)
-    );
 
     // Global skills layout at startup, even if the Skills dialog never opens.
     try {
@@ -2298,24 +1999,15 @@ app
       const contents = rendererWebContents();
       const exit = await runSmoke({
         renderer: () =>
-          RENDERER_GENERATION === "wco"
-            ? contents == null
-              ? Promise.resolve("failed")
-              : rendererReadiness.wait(contents.id, 90_000)
-            : new Promise((resolve) => {
-                const poll = () => {
-                  if (contents && legacySmokeReady.has(contents.id))
-                    resolve("ready");
-                  else setTimeout(poll, 100);
-                };
-                poll();
-              }),
+          contents == null
+            ? Promise.resolve("failed")
+            : rendererReadiness.wait(contents.id, 90_000),
         rendererReason: () =>
           contents == null
             ? "no main renderer"
             : rendererReadiness.failureReason(contents.id),
         companion: () =>
-          process.platform === "linux" || RENDERER_GENERATION === "legacy"
+          process.platform === "linux" || false
             ? "n/a"
             : (notchController?.smokeOutcome() ?? "pending"),
         log: (line) => console.log(line),
@@ -2360,7 +2052,6 @@ app.on("before-quit", (event) => {
   notchNotifications.dispose();
   // The progress window refuses to close by itself; free it before the quit.
   disposeMigrationProgress();
-  workspaceServiceHost.threadStore.flush();
   logStore().flush();
   try {
     browserRuntime.disposeAll();
diff --git a/apps/desktop/vitest.config.ts b/apps/desktop/vitest.config.ts
index a1dbf0f0..f9cd0329 100644
--- a/apps/desktop/vitest.config.ts
+++ b/apps/desktop/vitest.config.ts
@@ -1,7 +1,11 @@
 import react from "@vitejs/plugin-react";
 import { defaultExclude, defineConfig } from "vitest/config";
 
-import { alias, NEXT_MODULES, NEXT_REGISTRY_SRC } from "./vite.shared.ts";
+import {
+  alias,
+  RENDERER_MODULES,
+  RENDERER_REGISTRY_SRC,
+} from "./vite.shared.ts";
 
 /**
  * Three surfaces, three environments. The renderer is browser code and needs a
@@ -44,8 +48,8 @@ const CONTENDS_FOR_THE_MACHINE = [
   // The one real-fs.watch test: FSEvents start-up latency stretches under the
   // parallel main project's load, so it runs here with the machine to itself.
   "src/main/rpc/tables/memories.fs.test.ts",
-  // Drives the built renderer-next in Electron (spec 01 R1-T11b).
-  "src/main/dev/renderer-next.electron.test.ts",
+  // Drives the built renderer in Electron (spec 01 R1-T11b).
+  "src/main/dev/renderer.electron.test.ts",
   "src/main/dev/chat-kit.electron.test.ts",
   "src/main/notch/notch.electron.test.ts",
   "src/main/dev/chat-real-session.electron.test.ts",
@@ -65,40 +69,29 @@ export default defineConfig({
         "**/dist/**",
         "**/*.config.ts",
         "src/renderer/locales/**",
-        "src/renderer-next/routeTree.gen.ts",
-        "src/renderer-next/ui/**",
+        "src/renderer/routeTree.gen.ts",
+        "src/renderer/ui/**",
       ],
     },
     projects: [
-      {
-        plugins: [react()],
-        resolve: { alias },
-        test: {
-          name: "renderer",
-          environment: "jsdom",
-          ...ciTimeouts,
-          include: ["src/renderer/**/*.test.{ts,tsx}"],
-          setupFiles: ["./src/renderer/test-support/setup.ts"],
-        },
-      },
       {
         // The rewrite's renderer (spec 01 §3.7): compiled as it ships.
         plugins: [
           react({
-            include: NEXT_MODULES,
-            exclude: NEXT_REGISTRY_SRC,
+            include: RENDERER_MODULES,
+            exclude: RENDERER_REGISTRY_SRC,
             compiler: true,
           }),
         ],
         resolve: { alias },
         test: {
-          name: "renderer-next",
+          name: "renderer",
           environment: "jsdom",
           // Tests read tokens.css as text (`?raw`); nothing is styled.
           css: { include: [/tokens\.css/] },
           ...ciTimeouts,
-          include: ["src/renderer-next/**/*.test.{ts,tsx}"],
-          setupFiles: ["./src/renderer-next/test-support/setup.ts"],
+          include: ["src/renderer/**/*.test.{ts,tsx}"],
+          setupFiles: ["./src/renderer/test-support/setup.ts"],
         },
       },
       {
diff --git a/package.json b/package.json
index cc9332b3..e3c08521 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "abacusai-bot",
-  "version": "1.0.12",
+  "version": "1.0.13",
   "private": true,
   "description": "AbacusAI Bot: free, open-source personal agents for your messaging apps, tools and services.",
   "homepage": "https://github.com/abacusai/abacusai-bot",
@@ -10,9 +10,8 @@
   "scripts": {
     "build": "turbo run build vendor",
     "changelog": "node scripts/sync-changelog.js",
-    "check": "turbo run format:check lint typecheck test check:i18n check:locales check:audit check:knip-next check:ui-registry check:legacy-diff --concurrency=1",
+    "check": "turbo run format:check lint typecheck test check:i18n check:locales check:audit check:knip check:ui-registry --concurrency=1",
     "check:audit": "node scripts/check-audit.js",
-    "check:knip-next": "knip --workspace apps/desktop --include files,exports,types,duplicates",
     "dev": "pnpm run dev:desktop",
     "dev:desktop": "turbo run dev --filter=@abacus-ai/desktop",
     "format": "oxfmt .",
@@ -25,7 +24,8 @@
     "test:coverage": "turbo run test:coverage",
     "test:unit": "turbo run test:unit",
     "typecheck": "turbo run typecheck",
-    "typecheck:tools": "tsc -p tsconfig.tools.json"
+    "typecheck:tools": "tsc -p tsconfig.tools.json",
+    "check:knip": "knip --workspace apps/desktop --include files,exports,types,duplicates,dependencies,unlisted"
   },
   "devDependencies": {
     "@abacus-ai/config": "workspace:*",
diff --git a/scripts/build-provenance.mjs b/scripts/build-provenance.mjs
index 65bd9f64..332651a6 100644
--- a/scripts/build-provenance.mjs
+++ b/scripts/build-provenance.mjs
@@ -6,17 +6,13 @@ const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
 const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
 export const buildConstants = () => {
   const experience = read("apps/desktop/src/shared/experience.ts");
-  const generation = read("apps/desktop/src/main/renderer-generation.ts");
   const foundationApi = Number(
     experience.match(/FOUNDATION_API\s*=\s*(\d+)/)?.[1]
   );
   const protocol = experience.match(/EXPERIENCE_PROTOCOL\s*=\s*"([^"]+)"/)?.[1];
-  const renderer = generation.match(
-    /DEFAULT_RENDERER_GENERATION[^=]*=\s*"(legacy|wco)"/
-  )?.[1];
-  if (!foundationApi || !protocol || !renderer)
+  if (!foundationApi || !protocol)
     throw new Error("Cannot read source build compatibility constants");
-  return { foundationApi, protocol, generation: renderer };
+  return { foundationApi, protocol, generation: "wco" };
 };
 export const buildProvenance = (env = process.env) => {
   const pinned = env.ABACUS_BUILD_COMMIT;

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'version|1.0.85|C5|C6|R7-T24|retire' scripts/release* apps/updater/src docs/rewrite/specs/07-cut-over.md | head -130; cat apps/desktop/scripts/i18n-dynamic-keys.test.mjs; cat apps/desktop/src/main/profile-home.ts; cat apps/desktop/src/shared/experience.ts" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
zsh:1: no matches found: scripts/release*
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { consumers, flatten, sourceFiles } from "./i18n-consumers.mjs";
test("consumer set includes literals, data keys, props, plural stems and template prefixes", () => {
  const keys = [
    "plain",
    "data.key",
    "prop.key",
    "items_one",
    "items_other",
    "family.a",
    "family.b",
    "unused",
  ];
  const source = `t('plain'); const row = {titleKey:'data.key'}; const el = <Trans i18nKey="prop.key"/>; t('items',{count:2}); t(\`family.\${value}\`);`;
  assert.deepEqual(
    [...consumers(keys, { "fixture.tsx": source })].sort(),
    keys.filter((k) => k !== "unused").sort()
  );
  assert.deepEqual(
    [
      ...consumers(keys, { "fixture.tsx": source }, [
        { prefix: "family.", values: ["a"] },
      ]),
    ].sort(),
    keys.filter((k) => k !== "unused" && k !== "family.b").sort()
  );
});
test("empty-prefix templates require finite declaration", () =>
  assert.throws(
    () => consumers(["unused"], { "fixture.ts": "t(`${key}`)" }),
    /Unbounded/
  ));
test("R7-T26 every remaining leaf belongs to the final consumer set", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const keys = flatten(
    JSON.parse(
      fs.readFileSync(path.join(root, "src/renderer/locales/en-US.json"))
    )
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/i18n-dynamic-keys.json"))
  );
  const used = consumers(
    keys,
    sourceFiles(path.join(root, "src/renderer")),
    manifest
  );
  assert.deepEqual(
    keys.filter((key) => !used.has(key)),
    []
  );
});
import fs from "fs";
import os from "os";
import path from "path";

/**
 * One home folder per Abacus.AI account. A registry at the base dir maps an
 * account key to a profile folder and this module points `ABACUSAI_BOT_HOME`
 * at the active one before anything reads a path. The first account adopts
 * the base itself; later ones get `profiles/<key>/`. Switching relaunches,
 * because stores are singletons opened at module load. Must stay import-light.
 */

interface ProfileRegistry {
  /** The account key whose profile this install is currently using. */
  active: string | null;
  /** Account key -> profile dir, relative to the base ("." = the base itself). */
  profiles: Record<string, string>;
}

/**
 * Anchored in its own env var: this module mutates ABACUSAI_BOT_HOME and
 * `app.relaunch()` hands the child that mutated environment, which would
 * nest the next profile under the last one (`profiles/A/profiles/B`).
 */
const BASE =
  process.env.ABACUSAI_BOT_BASE ||
  process.env.ABACUSAI_BOT_HOME ||
  path.join(os.homedir(), ".abacusai-bot");
const REGISTRY_FILE = "profiles.json";

/** The install-wide directory that owns the profile registry and every profile. */
export const profileBaseDir = (): string =>
  process.env.ABACUSAI_BOT_BASE || process.env.ABACUSAI_BOT_HOME || BASE;

const registryPath = (): string => path.join(BASE, REGISTRY_FILE);

const readRegistry = (): ProfileRegistry => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    const reg = parsed as Partial<ProfileRegistry>;

    const profiles: Record<string, string> = {};
    if (reg.profiles != null && typeof reg.profiles === "object") {
      for (const [key, value] of Object.entries(reg.profiles)) {
        if (typeof value !== "string") continue;
        const resolved = path.resolve(BASE, value);
        const relative = path.relative(BASE, resolved);
        // A registry must never point outside the directory the app owns.
        if (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) && relative !== "..")
        ) {
          profiles[key] = value;
        }
      }
    }
    const active =
      typeof reg.active === "string" && profiles[reg.active] != null
        ? reg.active
        : null;

    return { active, profiles };
  } catch {
    return { active: null, profiles: {} };
  }
};

const writeRegistry = (registry: ProfileRegistry): void => {
  fs.mkdirSync(BASE, { recursive: true });
  const target = registryPath();
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The rename already made the registry whole; a stray temp file is fine.
    }
  }
};

const profileDir = (registry: ProfileRegistry, key: string): string =>
  path.resolve(BASE, registry.profiles[key] ?? ".");

/** The home this process should use right now. */
const activeHome = (): string => {
  const registry = readRegistry();
  if (registry.active == null) return BASE;

  return profileDir(registry, registry.active);
};

/** Called before any module that reads `abacusBotHome()` loads. */
export const initProfileHome = (): void => {
  process.env.ABACUSAI_BOT_BASE = BASE;
  // Unconditional: a relaunch inherits the previous process's mutated value.
  process.env.ABACUSAI_BOT_HOME = activeHome();
};

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

/**
 * Null when the account cannot be identified, so the caller stays put instead
 * of filing an unknown account into the active user's directory.
 */
export const profileKeyFor = (account: {
  user_id?: string | null;
  organization_id?: string | null;
  email?: string | null;
  organization?: string | null;
}): string | null => {
  const userId = slug(account.user_id ?? "");
  const organizationId = slug(account.organization_id ?? "");
  const organization = slug(account.organization ?? "");
  if (userId.length > 0) {
    return (
      organizationId.length > 0
        ? `user-${userId}_org-${organizationId}`
        : organization.length > 0
          ? `user-${userId}_org-name-${organization}`
          : `user-${userId}`
    ).slice(0, 120);
  }

  const email = slug(account.email ?? "");
  if (email.length === 0) return null;

  return (organization.length > 0 ? `${email}_${organization}` : email).slice(
    0,
    120
  );
};

/** The email-based key used before stable platform ids were exposed. */
export const legacyProfileKeyFor = (account: {
  email?: string | null;
  organization?: string | null;
}): string | null => {
  const email = slug(account.email ?? "");
  if (email.length === 0) return null;
  const organization = slug(account.organization ?? "");

  return (organization.length > 0 ? `${email}_${organization}` : email).slice(
    0,
    120
  );
};

/**
 * Make `key` the active profile. Returns true when it lands in a different
 * folder than this process uses; the caller must relaunch then. In that case
 * `seedAbacusKey` is written into the target so the relaunch is signed in.
 */
export const activateProfile = (
  key: string,
  seedAbacusKey: string | null,
  aliases: readonly string[] = []
): boolean => {
  const registry = readRegistry();

  if (registry.profiles[key] == null) {
    const existingAlias = aliases.find(
      (alias) => registry.profiles[alias] != null
    );
    registry.profiles[key] =
      existingAlias != null
        ? registry.profiles[existingAlias]
        : Object.keys(registry.profiles).length === 0
          ? "."
          : path.join("profiles", key);
  }
  // Remember every identity supplied by this authenticated account response.
  // Older deployments can omit stable ids on the next sign-in, so merely
  // looking up aliases above only supports migration in one direction.
  // Backfill existing profiles too, but never repoint a previously owned alias:
  // both folders may contain data and must not be silently merged.
  for (const alias of aliases) {
    if (registry.profiles[alias] == null)
      registry.profiles[alias] = registry.profiles[key];
  }
  registry.active = key;
  writeRegistry(registry);

  const target = profileDir(registry, key);
  const current = process.env.ABACUSAI_BOT_HOME || BASE;
  if (path.resolve(current) === target) return false;

  fs.mkdirSync(target, { recursive: true });
  if (seedAbacusKey != null && seedAbacusKey.trim().length > 0)
    seedApiKey(target, seedAbacusKey.trim());

  return true;
};

/** Direct merge, not saveApiKey: that writes to the current (wrong) home. */
const seedApiKey = (targetDir: string, apiKey: string): void => {
  const file = path.join(targetDir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed != null && typeof parsed === "object")
      config = parsed as Record<string, unknown>;
  } catch {
    // A fresh profile has no config yet.
  }
  const apiKeys =
    config.apiKeys != null && typeof config.apiKeys === "object"
      ? (config.apiKeys as Record<string, string>)
      : {};
  config.apiKeys = { ...apiKeys, ABACUS_API_KEY: apiKey };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
};
/**
 * Compatibility gate between the foundation (the installed Electron shell and
 * native pieces) and the experience (the renderer and agent bundles, shipped
 * as a TUF archive without a relaunch). `PROTOCOL` names the wire/IPC/resource
 * contract, `FOUNDATION_API` the shell capability revision; the updater
 * refuses an experience built for a different value of either. Must stay in
 * step with `apps/updater/src/manifest.ts`.
 */
export const EXPERIENCE_PROTOCOL = "abacus.desktop/1";

export const FOUNDATION_API = 2;

codex
The report acknowledges failed release gates, including Electron timing, dependency audit, and performance budgets. I’m checking those separately from runtime defects, with particular attention to restore collisions and translation checks that may miss deleted keys.
exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'version|1.0.85|R7-T24|C6|C14' apps/updater/src docs/rewrite/specs/07-cut-over.md | head -150; /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n '\\bt\\(|i18nKey|labelKey' apps/desktop/src/renderer/ui; ls AGENTS.md docs/agents; cat apps/desktop/scripts/build-experience.js apps/updater/src/release.ts" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 exited 1 in 0ms:
docs/rewrite/specs/07-cut-over.md:41:| Releases | tags up to `v1.0.85` (an ancestor of this branch), `CHANGELOG.md`, `scripts/sync-changelog.js` |
docs/rewrite/specs/07-cut-over.md:51:| F3 *(r2)* | The FOUNDATION_API bump gates published experiences | The manifest is bound to the **exact foundation version** (`integrity.ts:51-55`) *and* to `FOUNDATION_API` (`:57`). There is one TUF target for every foundation (`experience-updater.ts:23`). The bump chooses the swap barrier (`index.ts:425`). `buildManifest` stamps the **builder's** API and the supplied version onto any tree it is given (`apps/updater/src/manifest.ts:73-108`), so neither number says when or from what the tree was built (review #14). | §6: the bump selects the barrier. Build-time provenance inside the artifacts (C4) is what catches a stale tree. |
docs/rewrite/specs/07-cut-over.md:58:| F10 | The experience verifier accepts the new renderer | `integrity.ts:196-200` refuses a tree without `renderer/index.html`. | C6 renames `index-next.html` to `index.html` in the same commit that deletes the legacy one. |
docs/rewrite/specs/07-cut-over.md:59:| F11 | Tests that read the old tree | `legacy-prefs.test.ts:215-235` reads two old-renderer files as oracles. R3-T9's legacy half runs through old shims (03:1036). `ToolResultData` lives in `renderer/conversation/agent-types.ts:273-322`. The C1 fix log moved the migrated normalisation to `expandToolResultData` (§14 request, item 5). | C6 freezes the oracles and moves any remaining type into `shared/` first. |
docs/rewrite/specs/07-cut-over.md:60:| F12 *(r2)* | `pnpm check` gates the cut-over (PLAN) | CI runs `format:check`, `lint`, `typecheck:tools`, `typecheck`, `check:i18n`, `check:locales` and `check:audit` separately (`ci.yml:65-96`). `check:knip-next`, `check:ui-registry` and `check:legacy-diff` are only in the root `check`. A Linux `screenshots-next` job exists (`ci.yml:223-254`). | C4 adds knip and the registry check to CI; C6 removes the legacy diff. |
docs/rewrite/specs/07-cut-over.md:71:| F23 *(r2)* | Freezing `stagingPercentage` halts a rollout | electron-updater admits every client whose persisted staging id falls below the percentage (`AppUpdater.isStagingMatch`), so clients that had not checked yet keep entering. A downloaded build installs on quit (`update-service.ts:233-236`). A shipped client (≥ `v1.0.85`) already drops a downloaded build the feed stops offering on two consecutive checks (`update-service.ts:153-175`, `notOfferedStrikes`), 10 minutes apart (`:46`). | §12.2: halting means percentage 0 or withdrawal. |
docs/rewrite/specs/07-cut-over.md:72:| F24 *(r3)* | `ts.preProcessFile` extracts module specifiers | The installed TypeScript is 7.0.2, whose package root exports only version information: `ts.preProcessFile is not a function` (review r2 #11). `oxc-parser` 0.150.0 is installed (`pnpm-lock.yaml`), and its `parseSync(...).module` exposes `staticImports`, `staticExports` (with `moduleRequest`) and `dynamicImports`. `rolldown/parseAst` exports `parseAst`. | §5.1 and §5.6 use `oxc-parser`, declared as a root devDependency at the installed version. `require()` is found by an AST visit. |
docs/rewrite/specs/07-cut-over.md:100:  - There is one immutable, versioned fixture per source layout: pre-rewrite and dormant, each with its own producer manifest and source-binary hash. A new release **adds** a fixture and never replaces one (review #21).
docs/rewrite/specs/07-cut-over.md:105:- **D10. Two Vite inputs after C6 (r2).** `main: index.html` and `notch: notch.html` (review #12).
docs/rewrite/specs/07-cut-over.md:140:   Shipped builds (≥ `v1.0.85`) already drop a pulled build (F23), so the rollout needs nothing more from them.
docs/rewrite/specs/07-cut-over.md:171:| 23 | The manual rollback procedure "documented in `PARITY.md`" | 00-transport:1022, :1332 | §12.4: generated from each home's removal index and recorded roots (D2 b); C14 publishes it |
docs/rewrite/specs/07-cut-over.md:182:| 34 | `matchSupportedLanguage`'s old copy stays until cut-over | 01:996 | C6 |
docs/rewrite/specs/07-cut-over.md:186:| 38 | `check:legacy-diff` and `legacy-renderer-allow.json` | PLAN:382; `scripts/check-legacy-renderer-diff.mjs` | C6 (deleted) |
docs/rewrite/specs/07-cut-over.md:187:| 39 | `components/browser/pptx-viewer.tsx` "untouched until cut-over" | 04:1256 | C6 |
docs/rewrite/specs/07-cut-over.md:189:| 41 | Old-renderer re-export shims into `shared/`: bot templates and check-in constants (03 §24.9), terminal keys/mouse wrappers, starters, `normalizeAddress` (04 §26.9), routine templates, credits URLs, homepage, changelog, `injected-text` (05 §31.7) | 03:1115; 04:1256; 05 §31.7 | C6 (shims deleted, `shared/` modules kept) |
docs/rewrite/specs/07-cut-over.md:190:| 42 | The legacy half of R3-T9 | 03:1036 | C6 |
docs/rewrite/specs/07-cut-over.md:197:| 49 | `ToolResultData` must be in `shared/` before deletion | 02:606 (`renderer/conversation/agent-types.ts:273-322`) | C6, first commit |
docs/rewrite/specs/07-cut-over.md:200:| 52 | Notch probe records and the haptics default (r1 said "inference constants", which spec 06 r4 removed) | 06:651-655, §10.7 | C14: R6-T31's recorded probe JSON is in `metrics.fixtures.json`, and the haptics default follows the 150 ms rule |
docs/rewrite/specs/07-cut-over.md:225:C6 delete old tree + entry rename ─┐
docs/rewrite/specs/07-cut-over.md:233:C14 packaging + release notes ─── cut release N
docs/rewrite/specs/07-cut-over.md:261:      version: 1;
docs/rewrite/specs/07-cut-over.md:290:  3. in the same commit, a `create` or `replace-user` of the **retirement record** `<userData>/renderer-state.retired.json`: `{ version: 1, attempt, at, keys: { <key>: <sha256 of the dropped raw value> } }` (review r2 #3).
docs/rewrite/specs/07-cut-over.md:314:- **Withdrawal-aware install** (review r2 #16). Before any install, whether auto-restart, "Relaunch to update" or install-on-quit, `UpdateService` runs a fresh feed check, and installs only if the feed still offers the downloaded version to this client (staging included).
docs/rewrite/specs/07-cut-over.md:333:  - **Draft part** (review r2 #13). Every `sessionStorage`-persisted store registers with `lib/continuity/registry.ts` under a versioned key, with a valibot schema:
docs/rewrite/specs/07-cut-over.md:397:- `renderer-generation.ts:7`: `DEFAULT_RENDERER_GENERATION = "wco"`. `resolveRendererGeneration` gains the reverse dev override: `ABACUSBOT_RENDERER_GENERATION=legacy` works only when unpackaged, and only until C6 deletes the tree it would load. After C6 the generation is always `wco`, and C9 removes the dead branches.
docs/rewrite/specs/07-cut-over.md:410:  - R7-T1 … R7-T8, **R7-T9a**, R7-T10 … R7-T13, R7-T16, R7-T18 (pre-deletion form), R7-T23 (report only), R7-T24, R7-T25, R7-T30 (review #19: R7-T9b belongs to C10);
docs/rewrite/specs/07-cut-over.md:416:### C6 — Delete the old renderer tree, rename the entry
docs/rewrite/specs/07-cut-over.md:431:  - the packaged app and the experience built after C6 both contain `renderer/index.html` and `renderer/notch.html` (R7-T18);
docs/rewrite/specs/07-cut-over.md:456:  - no behaviour change: the screenshot gate shows 0 changed pixels against C6, and every suite passes;
docs/rewrite/specs/07-cut-over.md:467:  - `open-external`, `show-item-in-folder`, `get-app-version`, `window:show-about`, `restart-app`, `get-home-dir`, `has-google-chrome`;
docs/rewrite/specs/07-cut-over.md:492:- Tests: R1-T17 is rewritten (entry and experience URL only, already single-entry since C6); R1-T19 is reduced to "`prefs.json` is authoritative; `renderer-state.json` is read by the migration only". The legacy halves of R3-T31, R4-T34 and R5-T36 are removed.
docs/rewrite/specs/07-cut-over.md:563:### C14 — Packaging and release notes (release N is cut here)
docs/rewrite/specs/07-cut-over.md:567:- `CHANGELOG.md` `## Unreleased` gets the user-facing notes (§12.1). The version bump is a foundation release.
docs/rewrite/specs/07-cut-over.md:569:- Support article: "Going back to the previous version", with the text of §12.3 (from N) and §12.4 (from N+1: the `--restore-legacy-files` command only, with no manual file-moving procedure).
docs/rewrite/specs/07-cut-over.md:570:- **Gate:** R7-T16 and R7-T18 on the final tree; R7-T17 on the signed RC in the private pipeline; R7-T24 re-run on the signed RC; the release manager's go.
docs/rewrite/specs/07-cut-over.md:594:### 5.1 The old renderer tree (C6)
docs/rewrite/specs/07-cut-over.md:650:| `index.ts:1795-2090` | `open-external`, `open-file-path`, `show-item-in-folder`, `get-app-version`, `window:show-about`, `window:is-full-screen`, `restart-app`, `get-home-dir`, `has-google-chrome`, `theme:set`, `show-notification`, `window:chrome`, `window:recreate`, `settings:set-titlebar-density`, `append-logs`, `save-logs`, `account:get`, `account:skip`, `account:sign-out`, `account:forget`, `funnel:step`, `open-folder-dialog`, `open-files-dialog`, `save-pasted-temp-files`, `read-clipboard-image`, `fetch-url-attachment`, `files:read-image-as-data-url`, `files:read-file-as-text`, `files:read-pptx`, `skills-list-installed`, `skills-search-marketplace`, `skills-install`, `skills-remove`, `skills-import-local`, `skills-open-file` |
docs/rewrite/specs/07-cut-over.md:788:  - `foundation` is the exact `package.json` version the bundle was built for.
docs/rewrite/specs/07-cut-over.md:804:1. **Admission.** A foundation at API 2 refuses every manifest with `foundationApi: 1`, and the reverse holds too. The exact-version check already enforces this between releases (F3).
docs/rewrite/specs/07-cut-over.md:821:| Release pipeline (private repo) | Builds the foundation and its first experience from the same pinned commit ≥ C14. It publishes `experience/latest.zip` for N only once N's installers are live at any rollout percentage. | Checklist item in §17 |
docs/rewrite/specs/07-cut-over.md:839:- **Entry.** `rendererEntry` loads `index-next.html` (`renderer-entry.ts:26-48`), which is `index.html` after C6. Experience swaps target the same entry (`experienceEntryUrl`, `:51-57`).
docs/rewrite/specs/07-cut-over.md:901:- An agent bundle comes from the foundation's `extraResources` or from an experience for the **same** foundation version, so main and agent change together release by release.
docs/rewrite/specs/07-cut-over.md:937:| v1 present, not cleared (marker rules) | the twin by fingerprint, or the repair (N only) or fallback conversion (P6) |
docs/rewrite/specs/07-cut-over.md:938:| v1 present, held by a clear marker (token, `v1Fingerprint`, `savedAfterClear`) | cleared; P6 applies the same test before any fallback conversion |
docs/rewrite/specs/07-cut-over.md:978:| `Info.plist` | `NSMicrophoneUsageDescription` covers notch dictation too (06 NT6). It is listed twice in `extendInfo` (`electron-builder.yml:145-146`). | Remove the duplicate (C14). |
docs/rewrite/specs/07-cut-over.md:990:  - **deferred**, naming an owner and the PLAN later-slice it belongs to; user-visible deferrals go into the release notes as "not in this version".
docs/rewrite/specs/07-cut-over.md:997:  - Through C6, the file must be under **`src/renderer-next/`**, or `src/main/` for main-only rows. A consumer under the legacy `src/renderer/` fails.
docs/rewrite/specs/07-cut-over.md:1023:### 12.1 Release notes (`CHANGELOG.md` `## Unreleased`, C14)
docs/rewrite/specs/07-cut-over.md:1043:> **The first launch** after updating may show "Updating your data" for a moment while your conversations are converted. Nothing is deleted: the previous version's files are left where they are.
docs/rewrite/specs/07-cut-over.md:1045:> **Going back.** If you install the previous version again, it opens your bots, sessions, routines and settings as you left them before this update. Conversations and preference changes made in this version do not appear there.
docs/rewrite/specs/07-cut-over.md:1071:  Clients that already **downloaded** N answer `update-not-available` on their next checks. Shipped clients (≥ `v1.0.85`) drop the downloaded build on the second consecutive such answer, and install-on-quit comes off with it (`update-service.ts:153-175,227-236`). Checks run every 10 minutes (`:46`).
docs/rewrite/specs/07-cut-over.md:1093:1. Quit the app. Reinstall the previous version from `https://downloads.abacus.ai/abacusai-bot/releases/<N−1>/`:
docs/rewrite/specs/07-cut-over.md:1121:**Back to a legacy build (N−1) needs the legacy files restored,** and there is **one** supported way: the `--restore-legacy-files` command (review r2 #7). The support article (C14) gives the command and nothing else. It does not publish a manual file-moving procedure, because moving files by hand bypasses the digest checks, collision handling, step filtering and metadata updates below.
docs/rewrite/specs/07-cut-over.md:1160:### 13.2 Fixtures: immutable, versioned, one per purpose (reviews #20, #21)
docs/rewrite/specs/07-cut-over.md:1164:| `legacy-home-pre-rewrite-v<ver>` | The last pre-rewrite release (`v1.0.85` or later), from `downloads.abacus.ai/abacusai-bot/releases/<ver>/` or CI's unsigned `package:dir` of that tag | Onboarding stopped at `models`; the migration content of §13.3 | R7-T10, R7-T12, R7-T13, R7-T32 |
docs/rewrite/specs/07-cut-over.md:1167:| `perf-home-v<ver>` | The pre-rewrite release | **Onboarding completed** through the source build, so both builds open straight into the shell | R7-T24 (M1–M5) |
docs/rewrite/specs/07-cut-over.md:1169:- Each fixture is committed under `apps/desktop/src/main/migrations/__fixtures__/<name>.tar.zst` with a `producer.json`: source version, the sha256 of the source binary, generator commit, OS, and a sha256 per file.
docs/rewrite/specs/07-cut-over.md:1170:- Fixtures are **immutable**. A new release adds a new versioned fixture and never replaces an old one, so both source layouts stay available for as long as upgrades from them are supported.
docs/rewrite/specs/07-cut-over.md:1188:   After the app quits, the generator adds an unparseable file and one with a `version` the steps do not know. They are the only files the app does not write itself, because `writeTranscript` always writes version 1 (`transcript-service.ts`).
docs/rewrite/specs/07-cut-over.md:1199:  - `migrations.json` records steps 1, 2 and 5 with the expected stats: every good transcript converted; the unparseable one `corrupt` and the unknown-version one `notV1`; the three over 64 MB `tooLarge` and kept; nothing quarantined.
docs/rewrite/specs/07-cut-over.md:1232:| Metric | Definition | Budget (gate at C5, re-checked on the signed RC at C14) |
docs/rewrite/specs/07-cut-over.md:1271:| R7-T1 | `src/main/renderer-generation.test.ts` (C5) → `renderer-entry.test.ts` (C6, C9) | main | At C5: the default is `wco`, a packaged build ignores the env var, and `legacy` is honoured only unpackaged. From C6: one entry, `index.html`, for the dev, experience and file bases, with `NOTCH_ENTRY` beside it. At C9: the generation module is gone. |
docs/rewrite/specs/07-cut-over.md:1290:| R7-T18 | `scripts/check-packaged-resources.js` (extended) + `packaged-asar.test.ts` | packaged | The asar holds `dist/renderer/{index,notch}.html` and `build.json`, and no `index-next.html` after C6 (review #12). The three CSP `<meta>` strings equal `RENDERER_CSP`. No `__abacusDev`, fixture DB, devtools, `monaco`, `katex` or `sonner` asset. The experience tree built from the same dist passes `verifyExperience`. |
docs/rewrite/specs/07-cut-over.md:1296:| R7-T24 | `scripts/cutover/perf-compare.mjs` | packaged, reference machines | §14.1 M1–M6 against the last shipped build; numbers in the C5 and C14 PRs. |
docs/rewrite/specs/07-cut-over.md:1297:| R7-T25 | `features/parity.test.ts` (aggregate) + `preload/parity.test.ts` before C8 | renderer, preload | The ids equal `parity-ids.json` exactly. Every consumer `file#symbol` resolves through `oxc-parser`: under `src/renderer-next/` (or `src/main/`) through C6, and under `src/renderer/` from C7 (review r2 #12). A legacy-tree consumer fails. No `todo`. Every `deferred` row names an owner and a PLAN anchor. Every `visible` retired or deferred row is in the release-note list. The `PARITY.md` rows equal the enumerated sets. |
docs/rewrite/specs/07-cut-over.md:1301:| R7-T29 | `src/main/window-chrome.electron.test.ts` (the 7 todos) | Electron, 3 OSes | 00-window-chrome §10's integration cases, run on the packaged RC once in C14. |
docs/rewrite/specs/07-cut-over.md:1332:**Release N (after C14):**
docs/rewrite/specs/07-cut-over.md:1344:- [ ] Performance: M1–M6 within budget on both reference machines; the phase budgets hold (R7-T24, §14.2).
docs/rewrite/specs/07-cut-over.md:1362:| R4 | First-launch migration on a very large home (many GB of transcripts) takes minutes. The runner blocks the main window while it runs. | R7-T32 reports the 50 MB, 200 MB and 1 GB points. If 1 GB exceeds 3 min, step 1 becomes incremental: convert on hydrate, and let the runner do only the index. That decision is made before C14. |
docs/rewrite/specs/07-cut-over.md:1369:| R11 | A user on a slow link is mid-download of the N−1 experience when N arrives. | Experiences are version-pinned; the N−1 bundle is refused on N and the N target replaces it. Nothing to do. |
docs/rewrite/specs/07-cut-over.md:1423:| 12 | Major | **Accepted** | D10; C6 keeps `main` and `notch` inputs; its gate and R7-T18 require both HTML files in the packaged app and the experience. |
docs/rewrite/specs/07-cut-over.md:1432:| 21 | Minor | **Accepted** | D7, §13.2: immutable, versioned fixtures per source layout (pre-rewrite, dormant, drift, perf), each with its producer manifest and source-binary hash; new releases add and never replace. |
docs/rewrite/specs/07-cut-over.md:1450:- #12: `src/renderer-next` consumers through C6;
docs/rewrite/specs/07-cut-over.md:1464:| 7 | Major | **Accepted** | The manual appendix is withdrawn. The command is the only supported procedure, and it runs before the runner and any window (§12.4, C14). |
docs/rewrite/specs/07-cut-over.md:1466:| 9 | Major | **Accepted, routed** | P6 applies the marker token, `v1Fingerprint` and `savedAfterClear` rules, with a streamed fingerprint, before any fallback conversion (§9.3). R7-T14 clears a retained oversized source whose deletion fails, then restarts. |
docs/rewrite/specs/07-cut-over.md:1469:| 12 | Major | **Accepted** | §11: consumers resolve under `src/renderer-next/` through C6. C7 rewrites them and regenerates `PARITY.md` before C8 freezes it. R7-T25. |
apps/updater/src/bootstrap.ts:4: * CI-only: write a repository's version-1 metadata from existing keys (see
apps/updater/src/bootstrap.ts:9:console.log("Bootstrapped version-1 repository metadata");
apps/updater/src/repository.test.ts:56:    assert.equal(timestampBefore.signed.version, 2);
apps/updater/src/repository.test.ts:64:    assert.equal(timestamp.signed.version, 3);
apps/updater/src/repository.test.ts:70:    assert.equal(snapshot.signed.version, 3);
apps/updater/src/repository.test.ts:71:    assert.equal(timestamp.signed.snapshotMeta.version, 3);
apps/updater/src/repository.test.ts:73:    // Targets are untouched: still version 2, and the refreshed snapshot
apps/updater/src/repository.test.ts:79:    assert.equal(targets.signed.version, 2);
apps/updater/src/repository.test.ts:82:    assert.equal(snapshot.signed.meta["targets.json"]?.version, 2);
apps/updater/src/repository.test.ts:88:void test("bootstrap from existing keys recreates version-1 metadata", async () => {
apps/updater/src/repository.ts:130:const metaFileFrom = (version: number, data: string): MetaFile =>
apps/updater/src/repository.ts:134:    version,
apps/updater/src/repository.ts:146:  const versions = entries
apps/updater/src/repository.ts:149:    .filter((version) => Number.isInteger(version));
apps/updater/src/repository.ts:150:  if (versions.length === 0) {
apps/updater/src/repository.ts:153:  return Math.max(...versions);
apps/updater/src/repository.ts:195:      version: 1,
apps/updater/src/repository.ts:209:      version: 1,
apps/updater/src/repository.ts:223:      version: 1,
apps/updater/src/repository.ts:267:    version: 1,
apps/updater/src/repository.ts:310:      version: 1,
apps/updater/src/repository.ts:321:      version: 1,
apps/updater/src/repository.ts:332:      version: 1,
apps/updater/src/repository.ts:375:      version: targetsMetadata.signed.version + 1,
apps/updater/src/repository.ts:384:    path.join(paths.metadata, `${bumpedTargets.signed.version}.targets.json`),
apps/updater/src/repository.ts:415:          bumpedTargets.signed.version,
apps/updater/src/repository.ts:420:      version: snapshotMetadata.signed.version + 1,
apps/updater/src/repository.ts:426:    path.join(paths.metadata, `${bumpedSnapshot.signed.version}.snapshot.json`),
apps/updater/src/repository.ts:440:      snapshotMeta: metaFileFrom(bumpedSnapshot.signed.version, snapshotBytes),
apps/updater/src/repository.ts:442:      version: timestampMetadata.signed.version + 1,
apps/updater/src/repository.ts:488:      version: snapshotMetadata.signed.version + 1,
apps/updater/src/repository.ts:494:    path.join(paths.metadata, `${freshSnapshot.signed.version}.snapshot.json`),
apps/updater/src/repository.ts:508:      snapshotMeta: metaFileFrom(freshSnapshot.signed.version, snapshotBytes),
apps/updater/src/repository.ts:510:      version: timestampMetadata.signed.version + 1,
apps/updater/src/experience.ts:82:      "Usage: experience --renderer <dir> --agent <dir> --output <dir> --foundation <version>"
ls: AGENTS.md: No such file or directory
ls: docs/agents: No such file or directory
/**
 * Build the deterministic experience artifact: the renderer bundle
 * (dist/renderer) and the agent bundle (packages/agent/dist, filtered the
 * same way electron-builder ships it: no source maps, declarations, or
 * build stamps) as one canonical tree plus a byte-reproducible zip at
 * dist/experience/experience.zip.
 *
 * Requires the workspace to be built (`turbo run build`); the experience
 * turbo task declares those dependencies.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.join(desktopRoot, "..", "..");
const rendererDist = path.join(desktopRoot, "dist", "renderer");
const agentDist = path.join(repoRoot, "packages", "agent", "dist");
const agentStaging = path.join(desktopRoot, "dist", "experience-agent");
const output = path.join(desktopRoot, "dist", "experience");

// The foundation release this bundle belongs to. build.sh sets this same
// field before packaging, so the stamp is what app.getVersion() will report.
execFileSync(
  process.execPath,
  [path.join(desktopRoot, "scripts", "check-release-build.mjs")],
  { stdio: "inherit" }
);
const foundation = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf-8")
).version;

for (const [name, dir] of [
  ["renderer", rendererDist],
  ["agent", agentDist],
]) {
  if (!fs.existsSync(path.join(dir))) {
    console.error(
      `The ${name} build is missing at ${dir}; run the build first.`
    );
    process.exit(1);
  }
}

// Same exclusions as electron-builder.yml's agent extraResources filter.
const excluded = (name) =>
  name.endsWith(".map") ||
  name.endsWith(".d.ts") ||
  name.endsWith(".tsbuildinfo") ||
  name === ".tsbuildinfo";

fs.rmSync(agentStaging, { force: true, recursive: true });
fs.cpSync(agentDist, agentStaging, {
  filter: (source) => {
    const stat = fs.statSync(source);

    return stat.isDirectory() ? true : !excluded(path.basename(source));
  },
  recursive: true,
});

execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "apps", "updater", "dist", "experience.mjs"),
    "--renderer",
    rendererDist,
    "--agent",
    agentStaging,
    "--output",
    output,
    "--foundation",
    foundation,
  ],
  { stdio: "inherit" }
);

const manifest = JSON.parse(
  fs.readFileSync(path.join(output, "current", "manifest.json"), "utf-8")
);

console.log(
  `Experience ${manifest.experienceVersion} for foundation ${manifest.foundation} (renderer ${manifest.rendererVersion.slice(0, 12)}, agent ${manifest.agentVersion.slice(0, 12)}) at ${output}`
);
cat: apps/updater/src/release.ts: No such file or directory

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --input-type=module -e 'import fs from \"node:fs\"; import {flatten,sourceFiles} from \"./apps/desktop/scripts/i18n-consumers.mjs\"; let keys=new Set(flatten(JSON.parse(fs.readFileSync(\"apps/desktop/src/renderer/locales/en-US.json\"))));let manifest=JSON.parse(fs.readFileSync(\"apps/desktop/scripts/i18n-dynamic-keys.json\"));for(let row of manifest)for(let val of row.values)if("'!keys.has(row.prefix+val))console.log("manifest missing",row.prefix+val);'"'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 448ms:
exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'update-available|autoDownload|isUpdateAvailable' node_modules/.pnpm/electron-updater*/node_modules/electron-updater/out/AppUpdater.js; cat apps/desktop/src/main/services/updates/update-service.test.ts | tail -240; cat apps/desktop/src/main/migrations/attempt-records.ts" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 502ms:
zsh:1: no matches found: node_modules/.pnpm/electron-updater*/node_modules/electron-updater/out/AppUpdater.js
cat: apps/desktop/src/main/services/updates/update-service.test.ts: No such file or directory
/** Retained commit evidence. The JSONL index is a rebuildable cache, never evidence. */
import { createHash } from "node:crypto";
import path from "node:path";

import * as v from "valibot";

import {
  backupsRoot,
  backupDirName,
  inside,
  isAbsentError,
  nodeIo,
  parseStamp,
  sha256File,
  writeFileAtomic,
  type MigrationIo,
} from "./backup";
import type { CommitJournal } from "./journal";

const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const relative = v.pipe(
  v.string(),
  v.check(
    (s) =>
      s !== "" &&
      !path.isAbsolute(s) &&
      s === path.normalize(s) &&
      s !== ".." &&
      !s.startsWith(`..${path.sep}`)
  )
);
const OperationSchema = v.strictObject({
  op: v.picklist(["remove", "replace", "create"]),
  root: v.picklist(["home", "userData"]),
  source: relative,
  backup: v.optional(relative),
  originalSha256: v.optional(digest),
  resultSha256: v.optional(digest),
});
const ManifestSchema = v.strictObject({
  version: v.literal(1),
  attempt: v.pipe(v.string(), v.regex(/^[a-f0-9]{16,64}$/)),
  step: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  stamp: v.pipe(
    v.string(),
    v.check((s) => parseStamp(s) !== null)
  ),
  roots: v.strictObject({ home: v.string(), userData: v.string() }),
  ops: v.array(OperationSchema),
});
const CompletionSchema = v.strictObject({
  attempt: v.string(),
  recordedAt: v.string(),
  partial: v.boolean(),
  manifestSha256: digest,
});
export type AttemptManifest = v.InferOutput<typeof ManifestSchema>;
export type AttemptOperation = v.InferOutput<typeof OperationSchema>;
export interface CompletedAttempt {
  directory: string;
  manifest: AttemptManifest;
  completed: v.InferOutput<typeof CompletionSchema>;
}
export interface RestoreIndexEntry extends AttemptOperation {
  attempt: string;
  step: number;
  stamp: string;
  directory: string;
  roots: AttemptManifest["roots"];
}
const hash = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

export const writeAttemptManifest = (
  journal: CommitJournal,
  roots: AttemptManifest["roots"],
  io: MigrationIo = nodeIo
): void => {
  const location = (
    file: string
  ): Pick<AttemptOperation, "root" | "source"> => {
    const home = inside(roots.home, file);
    if (home !== null) return { root: "home", source: home };
    const userData = inside(roots.userData, file);
    if (userData !== null) return { root: "userData", source: userData };
    throw new Error(`Attempt destination outside recorded roots: ${file}`);
  };
  const manifest: AttemptManifest = {
    version: 1,
    attempt: journal.attempt,
    step: journal.id,
    name: journal.name,
    stamp: journal.commit,
    roots,
    ops: [
      ...journal.writes.map((write): AttemptOperation => ({
        op: write.kind === "create" ? "create" : "replace",
        ...location(write.dest),
        ...(write.backup === null
          ? {}
          : {
              backup: path.relative(journal.backupDir, write.backup),
              originalSha256: write.originalHash ?? undefined,
            }),
        resultSha256: sha256File(write.staged, io),
      })),
      ...journal.removals.map((removal): AttemptOperation => ({
        op: "remove",
        ...location(removal.path),
        backup: path.relative(journal.backupDir, removal.backup),
        originalSha256: sha256File(removal.path, io),
      })),
    ],
  };
  v.parse(ManifestSchema, manifest);
  writeFileAtomic(
    path.join(journal.backupDir, "attempt.json"),
    JSON.stringify(manifest),
    io
  );
};

/** Written only once migrations.json proves this attempt committed. */
export const completeAttempt = (
  directory: string,
  attempt: string,
  partial: boolean,
  recordedAt: string,
  io: MigrationIo = nodeIo
): void => {
  const bytes = io.readFileSync(path.join(directory, "attempt.json"));
  const manifest = v.parse(ManifestSchema, JSON.parse(bytes.toString("utf8")));
  if (manifest.attempt !== attempt)
    throw new Error("Attempt identity mismatch");
  writeFileAtomic(
    path.join(directory, "completed.json"),
    JSON.stringify({
      attempt,
      recordedAt,
      partial,
      manifestSha256: hash(bytes),
    }),
    io
  );
};

export const completedAttempts = (
  home: string,
  io: MigrationIo = nodeIo,
  log: (message: string) => void = console.warn
): CompletedAttempt[] => {
  let names: string[];
  try {
    names = io.readdirSync(backupsRoot(home));
  } catch (error) {
    if (isAbsentError(error)) return [];
    throw error;
  }
  const attempts: CompletedAttempt[] = [];
  for (const name of names.sort()) {
    const directory = path.join(backupsRoot(home), name);
    if (!io.lstatSync(directory).isDirectory() || name.startsWith(".pruning-"))
      continue;
    try {
      const completed = v.parse(
        CompletionSchema,
        JSON.parse(
          io
            .readFileSync(path.join(directory, "completed.json"))
            .toString("utf8")
        )
      );
      const bytes = io.readFileSync(path.join(directory, "attempt.json"));
      if (hash(bytes) !== completed.manifestSha256)
        throw new Error("Manifest digest mismatch");
      const manifest = v.parse(
        ManifestSchema,
        JSON.parse(bytes.toString("utf8"))
      );
      if (
        manifest.attempt !== completed.attempt ||
        manifest.roots.home !== home ||
        name !==
          backupDirName(
            manifest.stamp,
            manifest.step,
            manifest.name,
            manifest.attempt
          )
      )
        throw new Error("Manifest roots or identity mismatch");
      if (!path.isAbsolute(manifest.roots.userData))
        throw new Error("Invalid userData root");
      for (const op of manifest.ops) {
        if (
          op.op === "remove" &&
          (op.backup === undefined || op.originalSha256 === undefined)
        )
          throw new Error("Removal without backup evidence");
        if (op.backup !== undefined && op.originalSha256 === undefined)
          throw new Error("Backup without digest");
      }
      attempts.push({ directory, manifest, completed });
    } catch (error) {
      if (!isAbsentError(error))
        log(`[migrations] excluded ${name}: ${String(error)}`);
    }
  }
  return attempts;
};

export const rebuildRestoreIndex = (
  home: string,
  io: MigrationIo = nodeIo,
  log?: (message: string) => void
): RestoreIndexEntry[] => {
  const entries = completedAttempts(home, io, log).flatMap(
    ({ directory, manifest }) =>
      manifest.ops.map((op) => ({
        ...op,
        directory: path.basename(directory),
        attempt: manifest.attempt,
        step: manifest.step,
        stamp: manifest.stamp,
        roots: manifest.roots,
      }))
  );
  const file = path.join(backupsRoot(home), "restore-index.jsonl");
  const text = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
  let previous: string | null = null;
  try {
    previous = io.readFileSync(file).toString("utf8");
  } catch (error) {
    if (!isAbsentError(error)) throw error;
  }
  if (previous !== text) writeFileAtomic(file, text, io);
  return entries;
};

exec
/bin/zsh -c "ls apps/desktop/node_modules/electron-updater/out; /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'update-available|autoDownload|isUpdateAvailable' apps/desktop/node_modules/electron-updater/out/AppUpdater.js; /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'UpdateService|checkFeed' apps/desktop/src --glob '*test*'; sed -n '1120,1155p' docs/rewrite/specs/07-cut-over.md; cat scripts/cutover/check-deletions.mjs scripts/cutover/check-removed-deps.mjs" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
ls: apps/desktop/node_modules/electron-updater/out: No such file or directory
rg: apps/desktop/node_modules/electron-updater/out/AppUpdater.js: IO error for operation on apps/desktop/node_modules/electron-updater/out/AppUpdater.js: No such file or directory (os error 2)
apps/desktop/src/main/services/updates/update-hidden-windows.test.ts:30:const { UpdateService } = await import("./update-service");
apps/desktop/src/main/services/updates/update-hidden-windows.test.ts:47:  const service = new UpdateService({ isSafeToRestart: () => true });
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:38:const { UpdateService, failedPhaseOf } = await import("./update-service");
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:54:const downloaded = (): InstanceType<typeof UpdateService> => {
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:55:  const service = new UpdateService();
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:63:    expect(new UpdateService().getStatus()).toMatchObject({
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:70:    const service = new UpdateService();
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:81:    const service = new UpdateService();
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:117:    const service = new UpdateService();
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:129:    const service = new UpdateService();
apps/desktop/src/main/services/updates/update-failed-phase.test.ts:153:    const service = new UpdateService();
apps/desktop/src/main/services/updates/update-supersede.test.ts:38:const { UpdateService } = await import("./update-service");
apps/desktop/src/main/services/updates/update-supersede.test.ts:41:const withDownloadedBuild = (): InstanceType<typeof UpdateService> => {
apps/desktop/src/main/services/updates/update-supersede.test.ts:42:  const service = new UpdateService();
apps/desktop/src/main/services/updates/update-supersede.test.ts:192:  const service = new UpdateService();
apps/desktop/src/main/services/updates/update-progress.test.ts:41:const { UpdateService } = await import("./update-service");
apps/desktop/src/main/services/updates/update-progress.test.ts:44:const downloading = (): InstanceType<typeof UpdateService> => {
apps/desktop/src/main/services/updates/update-progress.test.ts:45:  const service = new UpdateService();
apps/desktop/src/main/services/updates/update-dir.test.ts:30:const { UpdateService } = await import("./update-service");
apps/desktop/src/main/services/updates/update-dir.test.ts:42:  const service = new UpdateService();
apps/desktop/src/main/services/updates/update-dir.test.ts:70:  await expect(new UpdateService().checkForUpdates()).resolves.toEqual({
apps/desktop/src/main/services/updates/update-dir.test.ts:75:    "[UpdateService] Download did not complete: synthetic transfer failure"

**Back to a legacy build (N−1) needs the legacy files restored,** and there is **one** supported way: the `--restore-legacy-files` command (review r2 #7). The support article (C14) gives the command and nothing else. It does not publish a manual file-moving procedure, because moving files by hand bypasses the digest checks, collision handling, step filtering and metadata updates below.

The command can also be run on its own: it runs in main before the runner and before any window, so it works even when the UI cannot start. A home where main cannot start at all is a support escalation. The backups stay intact for 30 days (§9.4).

1. Quit the app.
2. Run the installed N+1 (or newer) once with `--restore-legacy-files`. It prints a report and exits. For each profile home listed in `profiles.json` (the base home included):
   1. **Load the evidence.** Rebuild `restore-index.jsonl` from the attempt records if it is missing or inconsistent (§9.4). Load `backups/migrations/restorations.jsonl`, the restoration generations.
   2. **Select, per destination** (review r2 #6). Take every op of steps 3 and 4 whose attempt is **newer than the latest restoration generation** that already consumed that destination. For each destination, choose the op from the **latest** completed attempt:
      - a `remove` op restores the v1 file (or twin or marker) it moved;
      - a `replace` op on `renderer-state.json` restores its original (review r2 #4).

      `prefs.json` is **never** restored. It is N's authoritative file, and step 3's backup of it is kept but not applied.
   3. **Restore with digest checks.** The destination is `<recorded root>/<source>`: `root` is `home` or `userData`, resolved for **that** profile (`userData` = `<home>/electron`, F18, F22). The backup's sha256 must equal the op's `originalSha256`, or the op is skipped and reported.
      - Destination absent: the backup is moved back.
      - Destination equal to the backup: nothing to do.
      - Destination equal to the op's `resultSha256`, the file step 3 left: it is replaced, because it is unchanged since the migration.
      - Anything else: the restored file is written beside it as `<name>.restored-<stamp><ext>`, and the report lists it for support.
   4. **Update the metadata.**
      - Drop the restored threads from `threads/.archive-index.json`.
      - Delete `renderer-state.retired.json` if `renderer-state.json` was restored.
      - Append a generation `{ generation, at, consumed: [attempt ids], destinations: [...] }` to `restorations.jsonl`.
      - Mark steps 3 and 4 `restoredAt` in `migrations.json`. A later launch of N+1 or newer treats them as not applied and runs them again, as a new attempt with new backups.
3. Install N−1.

**Two cycles.** Restore, then legacy edits, then N+1 again, then restore again: the second restore picks the second cycle's backups for every destination the second migration touched, because the first generation already consumed the first cycle's. It never places a stale first-cycle file at the canonical path.

R7-T15 runs the command **verbatim** against a two-profile home that N+1 migrated through two partial commits and a final one, with one interrupted recovery. It also runs:
- a conflicting destination case;
- a damaged derived index;
- the complete two-cycle sequence.

N−1 then shows every conversation and the preferences in both profiles, and the conflicting file is preserved beside the restored one.

## 13. Upgrade tests: real layouts, synthetic data (r2)

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { specifiers } from "./parsed-source.mjs";

export const gitBlob = (data) =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
export const resolveLocal = (specifier, importer, desktop) => {
  const clean = specifier.split("?")[0];
  const aliases = {
    "#main/": "main",
    "#shared/": "shared",
    "#preload/": "preload",
    "#renderer/": "renderer",
    "#locales/": "renderer/locales",
  };
  let target;
  for (const [alias, tree] of Object.entries(aliases))
    if (clean.startsWith(alias))
      target = path.join(desktop, "src", tree, clean.slice(alias.length));
  if (clean.startsWith("."))
    target = path.resolve(path.dirname(importer), clean);
  if (!target) return null;
  const found = [
    target,
    ...[".ts", ".tsx", ".js", ".mjs", ".d.ts", "/index.ts", "/index.tsx"].map(
      (suffix) => target + suffix
    ),
  ].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found)
    throw new Error(`Deleted or missing import ${specifier} in ${importer}`);
  return found;
};
export const checkDeletions = (repo) => {
  const desktop = path.join(repo, "apps/desktop");
  const inventory = JSON.parse(
    fs.readFileSync(
      path.join(repo, "scripts/cutover/legacy-renderer-inventory.json")
    )
  );
  const moved = JSON.parse(
    fs.readFileSync(
      path.join(repo, "scripts/cutover/renderer-move-inventory.json")
    )
  );
  for (const { path: file, blob } of inventory.files) {
    const target = path.join(repo, file);
    if (
      fs.existsSync(target) &&
      gitBlob(fs.readFileSync(target)) === blob &&
      !moved.files.some((entry) => entry.path === file && entry.blob === blob)
    )
      throw new Error(`Legacy blob remains: ${file}`);
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|tsx|js|mjs)$/.test(file))
        for (const value of specifiers(file))
          resolveLocal(value, file, desktop);
    }
  };
  visit(path.join(desktop, "src"));
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkDeletions(process.cwd());
  console.log("Legacy inventory and resolved imports pass.");
}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { specifiers } from "./parsed-source.mjs";
export const removed = [
  "zustand",
  "framer-motion",
  "react-tourlight",
  "@tsparticles/engine",
  "@tsparticles/react",
  "@tsparticles/slim",
  "uuid",
  "@dicebear/core",
  "@dicebear/styles",
  "@monaco-editor/react",
  "monaco-editor",
  "katex",
  "@lobehub/icons-static-svg",
  "sonner",
  "clsx",
  "tailwind-merge",
];
export const packageName = (specifier) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
export const cssSpecifiers = (source) =>
  [
    ...source.matchAll(
      /@(import|plugin|source)\s+(?:url\(\s*)?["']([^"']+)["']/g
    ),
  ].map((m) => m[2]);
export const checkSource = (file, source) => {
  const imports = file.endsWith(".css")
    ? cssSpecifiers(source)
    : specifiers(file, source);
  for (const name of imports.map(packageName))
    if (removed.includes(name))
      throw new Error(`Removed dependency ${name} in ${file}`);
};
export const checkRemovedDeps = (repo) => {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", "vendor", "release", ".build"].includes(
          entry.name
        )
      )
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(file))
        checkSource(file, fs.readFileSync(file, "utf8"));
      else if (entry.name === "package.json") {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const group of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ])
          for (const name of Object.keys(pkg[group] ?? {}))
            if (removed.includes(name))
              throw new Error(`Removed manifest dependency ${name} in ${file}`);
      }
    }
  };
  for (const dir of ["apps", "packages"]) visit(path.join(repo, dir));
  const workspace = fs.readFileSync(
    path.join(repo, "pnpm-workspace.yaml"),
    "utf8"
  );
  for (const name of removed)
    if (
      workspace
        .split("\n")
        .some(
          (line) =>
            line.includes(name) && !line.includes("framer-motion@13.4.6")
        )
    )
      throw new Error(`Removed workspace dependency ${name}`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkRemovedDeps(process.cwd());
  console.log("Removed dependency imports and manifests pass.");
}

exec
/bin/zsh -c "cat apps/desktop/src/main/services/updates/update-supersede.test.ts; cat apps/desktop/src/main/dev/renderer.electron.test.ts | head -90; /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'version|PACKAGE_VERSION' build.sh scripts --glob '*.sh' | head -90; cat apps/desktop/src/main/services/updates/experience/health-check.ts" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
/**
 * What happens to a downloaded build when the feed moves on.
 *
 * From the field: a window left open for twenty hours across twenty releases.
 * The first release downloaded, the pill went up, and the periodic check then
 * skipped itself for as long as `downloaded` was true, so clicking "Relaunch
 * to update" at hour twenty installed the build from hour zero, and the
 * relaunched app immediately put the pill up again for everything it missed.
 * Checks now run through the downloaded state, and these tests pin down what
 * each possible answer does to the build on disk.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkForUpdates = vi.fn(() => Promise.resolve(null));
const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;
autoUpdater.checkForUpdates = checkForUpdates;

vi.mock("electron-updater", () => ({
  default: { autoUpdater },
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.18", isPackaged: false, on: () => {} },
  BaseWindow: { getAllWindows: () => [] },
  powerMonitor: { on: () => {}, getSystemIdleTime: () => 0 },
}));
vi.mock("../../app-quit-state", () => ({
  markQuitting: () => {},
  clearQuitting: () => {},
}));
vi.mock("./relaunch-hidden", () => ({
  markRelaunchHidden: () => {},
  clearRelaunchHidden: () => {},
}));

const { UpdateService } = await import("./update-service");

/** A service with 1.0.19 fully downloaded. The pill is up. */
const withDownloadedBuild = (): InstanceType<typeof UpdateService> => {
  const service = new UpdateService();
  autoUpdater.emit("update-available", { version: "1.0.19" });
  autoUpdater.emit("download-progress", {
    percent: 100,
    bytesPerSecond: 0,
    total: 100,
    transferred: 100,
  });
  autoUpdater.emit("update-downloaded", { version: "1.0.19" });

  return service;
};

beforeEach(() => {
  autoUpdater.removeAllListeners();
  checkForUpdates.mockClear();
  // electron-updater's constructor defaults; the service toggles them.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a check that finds a newer build than the one on disk", () => {
  it("supersedes the stale build rather than offering to install it", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.20" });

    // The pill for 1.0.19 is down: installing it now would just relaunch into
    // another "Relaunch to update".
    expect(service.getStatus().downloaded).toBe(false);
    expect(service.getStatus().updateInfo?.version).toBe("1.0.20");
    // The finished transfer's 100% sample must not render as live progress.
    expect(service.getStatus().progress).toBeNull();
  });

  it("puts the pill back up once the replacement lands", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.20" });
    autoUpdater.emit("update-downloaded", { version: "1.0.20" });

    const status = service.getStatus();
    expect(status.downloaded).toBe(true);
    expect(status.updateInfo?.version).toBe("1.0.20");
  });
});

describe("a check that finds the same build again", () => {
  it("keeps the pill up, undisturbed", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.19" });

    expect(service.getStatus().downloaded).toBe(true);
    expect(service.getStatus().updateInfo?.version).toBe("1.0.19");
    // The build is already on disk. A cache re-check is not a new download.
    expect(service.getStatus().downloading).toBe(false);
  });
});

describe("a check the pill must survive", () => {
  it("does not blink the pill off while the check runs", async () => {
    const service = withDownloadedBuild();

    const pending = service.checkForUpdates();

    // Mid-check: the build on disk is still real and still installable.
    expect(service.getStatus().downloaded).toBe(true);
    expect(service.getStatus().available).toBe(true);
    await pending;
  });
});

describe("a feed that no longer offers the downloaded build", () => {
  it("forgives a single stale answer: one CDN edge can lag another", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-not-available", { version: "1.0.18" });

    expect(service.getStatus().downloaded).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("drops the pulled release on the second consecutive answer", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-not-available", { version: "1.0.18" });
    autoUpdater.emit("update-not-available", { version: "1.0.18" });

    expect(service.getStatus().downloaded).toBe(false);
    expect(service.getStatus().available).toBe(false);
    // Install-on-quit must not apply a build the feed retracted.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("does not let a lone stale answer between good ones accumulate", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-not-available", { version: "1.0.18" });
    autoUpdater.emit("update-available", { version: "1.0.19" });
    autoUpdater.emit("update-not-available", { version: "1.0.18" });

    expect(service.getStatus().downloaded).toBe(true);
  });
});

describe("electron-updater's switches, kept in step with the pending build", () => {
  it("stops auto-downloading once a build is on disk", () => {
    // Left on, every same-version re-check would re-hash the cached archive
    // and re-stage it. The check must be one YAML fetch.
    withDownloadedBuild();

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("resumes downloading, and parks install-on-quit, when superseded", () => {
    withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.20" });

    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

    autoUpdater.emit("update-downloaded", { version: "1.0.20" });

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});

it("R7-T33: an install rechecks admission; withdrawn and staging-excluded offers never reach quitAndInstall", async () => {
  const quit = vi.fn();
  autoUpdater.quitAndInstall = quit;
  const service = withDownloadedBuild();
  checkForUpdates.mockResolvedValueOnce({
    isUpdateAvailable: false,
    updateInfo: { version: "1.0.19" },
  } as never);
  expect((await service.installUpdate()).success).toBe(false);
  expect(quit).not.toHaveBeenCalled();
  expect(service.getStatus().downloaded).toBe(false);
  expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
});
it("R7-T33: halt during download cancels it and ignores a late completion", async () => {
  const token = { cancel: vi.fn() };
  const service = new UpdateService();
  autoUpdater.emit("update-available", { version: "1.0.19" });
  checkForUpdates.mockResolvedValueOnce({
    cancellationToken: token,
    downloadPromise: new Promise(() => {}),
  } as never);
  await service.checkForUpdates();
  autoUpdater.emit("update-not-available", { version: "1.0.18" });
  expect(token.cancel).toHaveBeenCalledOnce();
  autoUpdater.emit("update-downloaded", { version: "1.0.19" });
  expect(service.getStatus()).toMatchObject({
    downloading: false,
    downloaded: false,
    progress: null,
  });
});
it("R7-T33: the same fresh offer can install", async () => {
  vi.useFakeTimers();
  const quit = vi.fn();
  autoUpdater.quitAndInstall = quit;
  const service = withDownloadedBuild();
  checkForUpdates.mockResolvedValueOnce({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.19" },
  } as never);
  expect((await service.installUpdate()).success).toBe(true);
  expect(quit).toHaveBeenCalledOnce();
});
/**
 * The renderer acceptance suite in the real Electron app (spec 01 §12),
 * against main's real `db.*` tables, never the dev fixtures:
 *
 * - R1-T11b: route-level view transitions are the router's document
 *   transition. Each started transition is observed on its own: its types,
 *   and whether tokens.css animated the pane (`app-pane`) and the sidebar
 *   (`app-sidebar`) groups. Typed navigations (rail, Settings in/out,
 *   nav-forward into a bot, browser back, a loader slower than the pending
 *   threshold) start exactly one; untyped commits (masked pop-up, search
 *   change) start none; never two transitions at once.
 * - R1-T23 live data: a bot created through the dev mutation harness (the
 *   legacy service path) appears in the renderer's sidebar; a theme written
 *   from the renderer reaches main's nativeTheme.
 * - R1-T22: main drops the renderer's port: before any reconnection the
 *   renderer stops its collection syncs and shows the connection-lost
 *   notification, then reloads exactly once (counted from CDP navigations)
 *   and reconnects; a second loss within 10 s shows the error screen.
 *
 * Runs `dist/` built with `VITE_UI_GALLERY=1` (no fixtures; the suite builds
 * it when missing or when it finds a fixture build). Without a display or a
 * build it skips locally, and fails loudly where the suite is required
 * (`CI`, or `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { harnessAvailability } from "../services/browser/browser-snapshot-harness";

const DESKTOP = resolve(import.meta.dirname, "../../..");
const REPO = resolve(DESKTOP, "../..");
const PORT = 9393;
const FIXTURE_MARKER = "renderer fixture-db: dev fixture tables";
/** `shell.connectionLost` in the bundled English copy. */
const CONNECTION_LOST = (
  JSON.parse(
    readFileSync(join(DESKTOP, "src/renderer/locales/en-US.json"), "utf8")
  ) as { shell: { connectionLost: string } }
).shell.connectionLost;
const REQUIRED =
  process.env.ABACUSBOT_REQUIRE_ELECTRON_SUITES === "1" ||
  (process.env.CI != null && process.env.CI !== "" && process.env.CI !== "0");

const assets = (): string[] => {
  const dir = join(DESKTOP, "dist/renderer/assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
};

/** "ok", or why the current dist/ cannot serve the acceptance run. */
const buildState = (): string => {
  if (!existsSync(join(DESKTOP, "dist/renderer/index.html")))
    return "no renderer build";
  if (!existsSync(join(DESKTOP, "dist/main/index.js"))) return "no main build";
  const sources = assets();
  if (!sources.some((source) => source.includes("__abacusDev")))
    return "the build has no dev hooks (VITE_UI_GALLERY=1 missing)";
  if (sources.some((source) => source.includes(FIXTURE_MARKER)))
    return "a fixture build (VITE_NEXT_DB_FIXTURES=1)";
  return "ok";
};

const availability = harnessAvailability();
let state = buildState();
const buildable = REQUIRED && availability.usable;
const runnable = availability.usable && (state === "ok" || buildable);
const skipReason = !availability.usable
  ? `no display: ${availability.reason ?? "unavailable"}`
  : `dist/ unusable: ${state}`;

let child: ChildProcess | null = null;
let scratch = "";
let send: (method: string, params?: object) => Promise<any> = async () => null;
const output: string[] = [];
/** Top-frame document navigations (CDP `Page.frameNavigated`), in order. */
rg: build.sh: No such file or directory (os error 2)
/**
 * Pre-activation gate: spawn the candidate agent bundle exactly as sessions
 * are spawned (Electron's binary in pure-Node mode) and require the NDJSON
 * `ready` line. Native imports resolve at load through the candidate's linked
 * `node_modules`, so ready also proves this foundation satisfies its
 * dependencies. Runs against a throwaway ABACUSAI_BOT_HOME.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const READY_TIMEOUT = 120_000;

const HEALTH_ENV_NAMES = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
];

export const checkAgentBundle = async (
  candidateRoot: string
): Promise<void> => {
  const entry = path.join(candidateRoot, "agent", "main.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "abacus-health-"));
  const env: Record<string, string> = {
    ABACUSAI_BOT_CLIENT_KIND: "desktop_code_mode",
    ABACUSAI_BOT_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
    HOME: home,
  };

  for (const name of HEALTH_ENV_NAMES) {
    const value = process.env[name];

    if (value !== undefined) env[name] = value;
  }

  const args = [entry, "--thread-id", "health-check"];
  const child = spawn(process.execPath, args, {
    cwd: home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The candidate agent never reported ready"));
      }, READY_TIMEOUT);

      timer.unref();

      const lines = readline.createInterface({ input: child.stdout });

      lines.on("line", (line) => {
        try {
          const parsed: unknown = JSON.parse(line);

          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { type?: unknown }).type === "CUSTOM" &&
            (parsed as { name?: unknown }).name === "session.ready"
          ) {
            clearTimeout(timer);
            resolve();
          } else if (
            (parsed as { type?: unknown } | null)?.type === "RUN_ERROR"
          ) {
            clearTimeout(timer);
            reject(new Error("Candidate reported RUN_ERROR"));
          }
        } catch {
          // Not a protocol line; keep reading.
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`The candidate agent exited with ${code} before ready`)
        );
      });
    });
  } finally {
    child.removeAllListeners("exit");
    child.kill();
    await fs.rm(home, { force: true, recursive: true }).catch(() => undefined);
  }
};

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node -e 'try {console.log(require.resolve(\"electron-updater\",{paths:[\"apps/desktop\"]}))}catch(e){console.log(e.message)}'; /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'renderer-state|draft|retired' apps/desktop/src/renderer/lib/continuity apps/desktop/src/main/services/config/legacy-prefs.ts apps/desktop/src/main/migrations/steps/002*; git diff 1b14bc91..75516d5f -- docs/rewrite/PLAN.md; git log 1b14bc91..75516d5f --oneline" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 10255ms:
/Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover/node_modules/electron-updater/out/main.js
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:3: * (`userData/renderer-state.json`) into `~/.abacusai-bot/prefs.json`, by
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:10: * `renderer-state.json` is read only. The provenance-aware startup import
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:21:import { readRendererStateFile } from "../../services/config/renderer-state";
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:25:} from "../../services/config/retired-prefs";
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:29:export const RENDERER_STATE_FILE_NAME = "renderer-state.json";
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:63:  name: "prefs-from-renderer-state",
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:78:    const retired = readRetiredPrefs(
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.ts:85:      new Set(Object.keys(retired?.keys ?? {}))
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.test.ts:2: * C-T5: step 2 golden. `__fixtures__/renderer-state/*` (a real captured file,
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.test.ts:21:import { prefsFromRendererState } from "./002-prefs-from-renderer-state";
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.test.ts:23:const FIXTURES = path.join(__dirname, "__fixtures__", "renderer-state");
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.test.ts:39:  source = path.join(userData, "renderer-state.json");
apps/desktop/src/main/migrations/steps/002-prefs-from-renderer-state.test.ts:249:  it("runs with no renderer-state.json at all", async () => {
apps/desktop/src/main/services/config/legacy-prefs.ts:4: * The old renderer's durable state (`userData/renderer-state.json`) mapped
apps/desktop/src/main/services/config/legacy-prefs.ts:17: * `resetLegacy`, never by default-equality. `renderer-state.json` is only
apps/desktop/src/main/services/config/legacy-prefs.ts:30:import { readRendererStateFile } from "./renderer-state";
apps/desktop/src/main/services/config/legacy-prefs.ts:31:import { readRetiredPrefs, RETIRED_PREFS_FILE } from "./retired-prefs";
apps/desktop/src/main/services/config/legacy-prefs.ts:419:  retiredKeys: ReadonlySet<string> = new Set()
apps/desktop/src/main/services/config/legacy-prefs.ts:440:            retiredKeys.has(key)
apps/desktop/src/main/services/config/legacy-prefs.ts:484:  const retired = readRetiredPrefs(
apps/desktop/src/main/services/config/legacy-prefs.ts:491:    new Set(Object.keys(retired?.keys ?? {}))
apps/desktop/src/renderer/lib/continuity/registry.ts:85:  stage: v.picklist(["draft", "created", "checkout-ready", "handed-off"]),
apps/desktop/src/renderer/lib/continuity/registry.ts:138:  { key: "chat.drafts.v1", storage: "abacus.chat.drafts", schema: chat },
apps/desktop/src/renderer/lib/continuity/registry.ts:139:  { key: "bots.drafts.v1", storage: "renderer:bot-draft", schema: bot },
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-Nnp9PHYq' (errno=Operation not permitted)
2026-10-01 15:24:13.765 xcodebuild[59025:4423909]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:24:13.965 xcodebuild[59025:4423907] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-cEcTaiTT' (errno=Operation not permitted)
2026-10-01 15:24:15.068 xcodebuild[59029:4423929]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:24:15.290 xcodebuild[59029:4423927] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
diff --git a/docs/rewrite/PLAN.md b/docs/rewrite/PLAN.md
index 836d6bf5..a238322f 100644
--- a/docs/rewrite/PLAN.md
+++ b/docs/rewrite/PLAN.md
@@ -310,7 +310,7 @@ The `/__ui` gallery replays scripted conversations through `@shadcn/helpers/tans
 | `@shadcn/react` message-scroller, questionnaire + registry chat parts | Transcript skin, HITL forms | [use] React ≥19 |
 | `@shadcn/helpers/tanstack-ai` | Scripted fixtures | [verify] pins ai-client 0.20 vs 0.36 |
 | `temml` (351★) | Math | [use] MIT, active |
-| ~~`node-mac-notch`~~ | Exact notch metrics | [dropped] does not exist on npm; notch metrics come from a one-shot JXA probe of `NSScreen.safeAreaInsets` (spec 06 §10.2), no inference fallback |
+| ~~`JXA notch probe`~~ | Exact notch metrics | [dropped] does not exist on npm; notch metrics come from a one-shot JXA probe of `NSScreen.safeAreaInsets` (spec 06 §10.2), no inference fallback |
 | `@tanstack/react-hotkeys` | Typed shortcuts (⌘K, ⌘N, ⌘., ⌘⇧Space) | [use] |
 | `prompt-area` | @-mentions, / commands in the composer | [not used] registry `input-group` + `combobox` (spec 02 §8) |
 | `streamdown`, `boring-avatars` | — | [skip] TanStack Markdown and BotAvatar cover them |
@@ -354,7 +354,7 @@ All as routes; connector sheet masked; update states; account/credits; sounds an
 Onboarding routes, first-bot hatch, spotlight tour, notch entry with states, reactions, sounds and haptics; Windows capsule.Gate: fresh-install run-through recorded; notch tested on a notched Mac, an external display and Windows.
 7
 ### Cut-over
-Delete the old renderer, conversation layer, NDJSON host, `window.api`, zustand stores, unused patches; knip clean; size-limit set; PARITY.md all green; migration runs on real data from a backup.Gate: `pnpm check` green; release build smoke on macOS and Windows.
+Release N deletes the legacy renderer and the NDJSON-only host path, window.api, zustand stores and unused patches. The compat stream stays for main taps. Parity is green, retired or deferred with an owner. Upgrade checks use shipped layouts with synthetic data, plus optional local dogfood copies. Gate: full checks, packaged smoke on macOS, Windows and Linux, and signed RC acceptance in the private pipeline. Release N+1 registers steps 3 and 4 after N has been at 100% for at least 14 days with no rollback trigger or migrated-data P0/P1. The supported rollback uses --restore-legacy-files.
 
 ## Open questions
 
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-52A4F2we' (errno=Operation not permitted)
2026-10-01 15:24:18.006 xcodebuild[59050:4424049]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:24:18.244 xcodebuild[59050:4424047] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-G0LZvX2o' (errno=Operation not permitted)
2026-10-01 15:24:19.413 xcodebuild[59054:4424067]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-10-01 15:24:19.670 xcodebuild[59054:4424066] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
75516d5f cutover C14: ship profile restore tooling and release N notes
330d7ac7 cutover C13: prune locales against final renderer consumers
5d6e88cc cutover C12: remove legacy dependencies and enforce complete tooling scope
3f4217fd cutover C11: retire live legacy state and transcript writers
1a3249b0 cutover C10: make AG-UI unconditional and preserve compat oracles
3473aa84 cutover C9: collapse renderer generation and legacy chrome
0eef628b cutover C8: remove legacy preload and raw IPC
b28230c2 cutover C7: move renderer and widen source tooling scope
2e4c6e3a cutover C6: delete legacy renderer and ship one main entry
d8bccf17 cutover C5: freeze bridge enumeration and complete implementation parity metadata
9fd37868 cutover: measure packaged performance on private user-login copies

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'update-available|autoDownload|isUpdateAvailable' node_modules/electron-updater/out/AppUpdater.js; cat node_modules/electron-updater/out/AppUpdater.js | sed -n '370,430p'; nl -ba apps/desktop/src/main/services/config/legacy-prefs.ts | sed -n '410,505p'; nl -ba apps/desktop/src/main/services/updates/update-service.ts | sed -n '150,190p;338,365p'; /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n 'R18|archive index|damaged' docs/rewrite/specs/07-cut-over.md" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
109:        this.autoDownload = true;
182:         * For type safety you can use signals, e.g. `autoUpdater.signals.updateDownloaded(() => {})` instead of `autoUpdater.on('update-available', () => {})`
339:    async isUpdateAvailable(updateInfo) {
404:        if (!(await this.isUpdateAvailable(updateInfo))) {
408:                isUpdateAvailable: false,
418:            isUpdateAvailable: true,
422:            downloadPromise: this.autoDownload ? this.downloadUpdate(cancellationToken) : null,
429:        this.emit("update-available", updateInfo);
432:     * Start downloading update manually. You can use this method if `autoDownload` option is set to `false`.
                    this._logger.info(`Current OS version ${currentOSVersion} is less than the minimum OS version required ${minimumSystemVersion} for version ${currentOSVersion}`);
                    return false;
                }
            }
            catch (e) {
                this._logger.warn(`Failed to compare current OS version(${currentOSVersion}) with minimum OS version(${minimumSystemVersion}): ${(e.message || e).toString()}`);
            }
        }
        return true;
    }
    async getUpdateInfoAndProvider() {
        await this.app.whenReady();
        if (this.clientPromise == null) {
            this.clientPromise = this.configOnDisk.value.then(it => (0, providerFactory_1.createClient)(it, this, this.createProviderRuntimeOptions()));
        }
        const client = await this.clientPromise;
        const stagingUserId = await this.stagingUserIdPromise.value;
        client.setRequestHeaders(this.computeFinalHeaders({ "x-user-staging-id": stagingUserId }));
        return {
            info: await client.getLatestVersion(),
            provider: client,
        };
    }
    createProviderRuntimeOptions() {
        return {
            isUseMultipleRangeRequest: true,
            platform: this._testOnlyOptions == null ? process.platform : this._testOnlyOptions.platform,
            executor: this.httpExecutor,
        };
    }
    async doCheckForUpdates() {
        this.emit("checking-for-update");
        const result = await this.getUpdateInfoAndProvider();
        const updateInfo = result.info;
        if (!(await this.isUpdateAvailable(updateInfo))) {
            this._logger.info(`Update for version ${this.currentVersion.format()} is not available (latest version: ${updateInfo.version}, downgrade is ${this.allowDowngrade ? "allowed" : "disallowed"}).`);
            this.emit("update-not-available", updateInfo);
            return {
                isUpdateAvailable: false,
                versionInfo: updateInfo,
                updateInfo,
            };
        }
        this.updateInfoAndProvider = result;
        this.onUpdateAvailable(updateInfo);
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        //noinspection ES6MissingAwait
        return {
            isUpdateAvailable: true,
            versionInfo: updateInfo,
            updateInfo,
            cancellationToken,
            downloadPromise: this.autoDownload ? this.downloadUpdate(cancellationToken) : null,
        };
    }
    onUpdateAvailable(updateInfo) {
        this._logger.info(`Found version ${updateInfo.version} (url: ${(0, builder_util_runtime_1.asArray)(updateInfo.files)
            .map(it => it.url)
            .join(", ")})`);
        this.emit("update-available", updateInfo);
    }
   410	 * Brings `fields` of the prefs row in line with the legacy state, by
   411	 * provenance: a `"user"` field is never touched; a field with a legacy value
   412	 * takes it and becomes `"legacy"`; a `"legacy"` field whose keys are gone
   413	 * goes back to its default.
   414	 */
   415	export const importLegacyPrefs = (
   416	  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
   417	  read: (key: string) => string | undefined,
   418	  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS,
   419	  retiredKeys: ReadonlySet<string> = new Set()
   420	): LegacyImportStats => {
   421	  const legacy = composeLegacyPrefs(read, fields);
   422	  const provenance = prefs.provenance();
   423	  const named = Object.keys(legacy.patch) as PrefsField[];
   424	  // Provenance is per leaf; a field counts as kept when any leaf of it is
   425	  // the user's (the import skips exactly those leaves).
   426	  const keptUser = named.filter((field) =>
   427	    Object.entries(provenance).some(
   428	      ([leaf, mark]) =>
   429	        mark === "user" && (leaf === field || leaf.startsWith(`${field}.`))
   430	    )
   431	  );
   432	  const { invalid } = prefs.importLegacy(legacy.patch);
   433	  const reset = prefs.resetLegacy(
   434	    legacy.absent.filter(
   435	      (field) =>
   436	        !Array.from(LEGACY_PREFS_KEYS).some(
   437	          ([key, mapped]) =>
   438	            mapped.includes(field) &&
   439	            read(key) === undefined &&
   440	            retiredKeys.has(key)
   441	        )
   442	    )
   443	  );
   444	  return {
   445	    keys: legacy.keys.length,
   446	    imported: named.length - keptUser.length - invalid,
   447	    keptUser: keptUser.length,
   448	    invalid: legacy.invalid.length + legacy.invalidMembers.length + invalid,
   449	    reset: reset.length,
   450	  };
   451	};
   452	
   453	/**
   454	 * The old renderer's sound opt-out lives in `config.json`
   455	 * (`notificationSoundDisabled`, `settings.ts` `readNotificationSettings`),
   456	 * not in its durable state (spec 05 §31.5 i). An opt-out is imported into
   457	 * `sounds.enabled = false` as `"legacy"`; once it is lifted, a legacy-sourced
   458	 * `false` goes back to the default. A `"user"` leaf is never touched.
   459	 * Returns what happened.
   460	 */
   461	export const importLegacySoundOptOut = (
   462	  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
   463	  soundDisabled: unknown
   464	): "imported" | "kept-user" | "reset" | "none" => {
   465	  const mark = prefs.provenance()["sounds.enabled"];
   466	  if (mark === "user") return soundDisabled === true ? "kept-user" : "none";
   467	  if (soundDisabled === true) {
   468	    prefs.importLegacy({ sounds: { enabled: false } });
   469	    return "imported";
   470	  }
   471	  if (mark !== "legacy") return "none";
   472	  // Only `sounds.enabled` is ever legacy-sourced, so resetting the group's
   473	  // legacy leaves resets exactly it.
   474	  prefs.resetLegacy(["sounds"]);
   475	  return "reset";
   476	};
   477	
   478	/** Read-only startup import kept through release N, including after N+1. */
   479	export const importLegacyPrefsAtStartup = (
   480	  source: string,
   481	  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">
   482	): LegacyImportStats => {
   483	  const legacy = readRendererStateFile(source);
   484	  const retired = readRetiredPrefs(
   485	    path.join(path.dirname(source), RETIRED_PREFS_FILE)
   486	  );
   487	  return importLegacyPrefs(
   488	    prefs,
   489	    (key) => legacy.get(key),
   490	    LEGACY_PREFS_FIELDS,
   491	    new Set(Object.keys(retired?.keys ?? {}))
   492	  );
   493	};
   150	        `[UpdateService] ${info.version} available (running ${app.getVersion()}), downloading`
   151	      );
   152	      this.notOfferedStrikes = 0;
   153	      this.withdrawnDownloads.delete(info.version);
   154	      // Installing a superseded build would relaunch straight into another
   155	      // "Relaunch to update"; the pill comes down until the replacement lands.
   156	      if (
   157	        this.status.downloaded &&
   158	        this.downloadedVersion !== info.version &&
   159	        !this.status.installing
   160	      ) {
   161	        this.dropDownloadedBuild(
   162	          `${info.version} supersedes downloaded ${this.downloadedVersion ?? "build"}`
   163	        );
   164	      }
   165	
   166	      this.status.checking = false;
   167	      this.status.available = true;
   168	      // The flag also keeps the periodic check from disturbing the transfer.
   169	      if (!this.status.downloaded) this.status.downloading = true;
   170	      this.status.updateInfo = { version: info.version };
   171	      this.emitStatusUpdate();
   172	    });
   173	
   174	    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
   175	      console.log(
   176	        `[UpdateService] up to date on ${app.getVersion()} (feed offers ${info.version})`
   177	      );
   178	      this.status.checking = false;
   179	      this.status.available = false;
   180	
   181	      if (this.status.downloading) {
   182	        if (this.status.updateInfo != null)
   183	          this.withdrawnDownloads.add(this.status.updateInfo.version);
   184	        this.transferToken?.cancel();
   185	        this.transferToken = null;
   186	        this.status.downloading = false;
   187	        this.dropDownloadedBuild("feed withdrew the active download");
   188	      }
   189	      this.status.updateInfo = { version: info.version };
   190	      // A build the feed stops offering is a pulled release: drop it. On the
   338	      if (critical !== this.status.criticalUpdate) {
   339	        console.log(
   340	          `[UpdateService] criticalBelow=${String(criticalBelow)}, critical: ${critical}`
   341	        );
   342	        this.status.criticalUpdate = critical;
   343	        this.emitStatusUpdate();
   344	      }
   345	    } catch (err) {
   346	      console.warn(
   347	        `[UpdateService] release metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`
   348	      );
   349	    }
   350	  }
   351	
   352	  private async checkFeed(
   353	    metadataOnly = false
   354	  ): Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> {
   355	    // A concurrent older check cannot authorize an install; await it, then fetch again.
   356	    if (metadataOnly && this.checkingFeed != null) await this.checkingFeed;
   357	    if (this.checkingFeed != null) return this.checkingFeed;
   358	    const previous = autoUpdater.autoDownload;
   359	    if (metadataOnly || this.status.downloading || this.status.downloaded)
   360	      autoUpdater.autoDownload = false;
   361	    this.checkingFeed = autoUpdater.checkForUpdates();
   362	    try {
   363	      return await this.checkingFeed;
   364	    } finally {
   365	      this.checkingFeed = null;
532:- **Forward compatibility with N+1** comes from the archive index, the retirement record and the fallback reader, never from a step-4-applied switch. A home N+1 migrated only partly still reads correctly in N.
1149:- a damaged derived index;
1287:| R7-T15 | `rollback.packaged.test.ts` | packaged | The published `--restore-legacy-files` command, run verbatim, on a two-profile home that N+1 migrated through two partial commits and a final one, with one interrupted recovery: destinations from the recorded roots (F22); `renderer-state.json` restored from step 3's `replace` backup while `prefs.json` is untouched (review r2 #4); a conflicting destination kept, with `.restored-<stamp>`; a damaged derived index rebuilt; the complete two-cycle sequence restores the latest cycle's files (review r2 #6). N−1 then shows every conversation and the preferences in both profiles. N started without any restore shows every archived conversation. |
1374:| R18 | `.archive-index.json` becomes unreadable after N+1, and archived threads read as cleared. | Fail closed and log it. Nothing is lost: the v1 files are in the backups, and `--restore-legacy-files` or a later step-4 run rewrites the index. The support article covers it. |

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --input-type=module -e 'import fs from \"node:fs\";import vm from \"node:vm\";import{stripTypeScriptTypes}from\"node:module\";import{EventEmitter}from\"node:events\";let src=stripTypeScriptTypes(fs.readFileSync(\"apps/desktop/src/main/services/updates/update-service.ts\",\"utf8\")).replace(/"'^import .*?;'"\\n/gms, \"\").replace(/"'^const '"\\{ autoUpdater \\} = electronUpdater;"'$/m, "").replaceAll("export ", "")+"'"\\nglobalThis.Service=UpdateService\";let a=new EventEmitter();a.setFeedURL=()=>{};let offered=true, downloads=0;a.checkForUpdates=async()=>{a.emit(offered?\"update-available\":\"update-not-available\",{version:\"1.0.86\"});if(offered&&a.autoDownload)downloads++;return {isUpdateAvailable:offered,updateInfo:{version:\"1.0.86\"}}};let context={autoUpdater:a,app:{isPackaged:false,getVersion:()=>\"1.0.85\"},process:{env:{},platform:\"darwin\"},console,setInterval,clearInterval,setTimeout,fetch:async()=>({ok:false}),AbortSignal,BaseWindow:{getAllWindows:()=>[]},powerMonitor:{getSystemIdleTime:()=>0},emitBusChannel:()=>{}};vm.createContext(context);vm.runInContext(src,context);let s=new context.Service();await s.checkForUpdates();offered=false;await s.checkForUpdates();offered=true;await s.checkForUpdates();console.log(JSON.stringify({downloads,autoDownload:a.autoDownload,status:s.getStatus()}));'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 exited 1 in 93ms:
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

:119

  constructor(private readonly deps: UpdateServiceDeps = {}) {
                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    this.setupAutoUpdater();

SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
    at parseTypeScript (node:internal/modules/typescript:68:40)
    at processTypeScriptCode (node:internal/modules/typescript:146:42)
    at stripTypeScriptTypes (node:internal/modules/typescript:123:10)
    at file:///Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover/[eval1]:1:143
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
    at async node:internal/modules/esm/loader:223:26
    at async ModuleLoader.executeModuleJob (node:internal/modules/esm/loader:220:20)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
}

Node.js v24.21.0

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --input-type=module -e 'import fs from \"node:fs\";import vm from \"node:vm\";import{stripTypeScriptTypes}from\"node:module\";import{EventEmitter}from\"node:events\";let src=stripTypeScriptTypes(fs.readFileSync(\"apps/desktop/src/main/services/updates/update-service.ts\",\"utf8\"),{mode:\"transform\"}).replace(/"'^import .*?;'"\\n/gms, \"\").replace(/"'^const '"\\{ autoUpdater \\} = electronUpdater;"'$/m, "").replaceAll("export ", "")+"'"\\nglobalThis.Service=UpdateService\";let a=new EventEmitter();a.setFeedURL=()=>{};let offered=true, downloads=0;a.checkForUpdates=async()=>{a.emit(offered?\"update-available\":\"update-not-available\",{version:\"1.0.86\"});if(offered&&a.autoDownload)downloads++;return {isUpdateAvailable:offered,updateInfo:{version:\"1.0.86\"}}};let context={autoUpdater:a,app:{isPackaged:false,getVersion:()=>\"1.0.85\"},process:{env:{},platform:\"darwin\"},console,setInterval,clearInterval,setTimeout,fetch:async()=>({ok:false}),AbortSignal,BaseWindow:{getAllWindows:()=>[]},powerMonitor:{getSystemIdleTime:()=>0},emitBusChannel:()=>{}};vm.createContext(context);vm.runInContext(src,context);let s=new context.Service();await s.checkForUpdates();offered=false;await s.checkForUpdates();offered=true;await s.checkForUpdates();console.log(JSON.stringify({downloads,autoDownload:a.autoDownload,status:s.getStatus()}));'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
[UpdateService] 1.0.86 available (running 1.0.85), downloading
[UpdateService] up to date on 1.0.85 (feed offers 1.0.86)
[UpdateService] feed withdrew the active download
[UpdateService] 1.0.86 available (running 1.0.85), downloading
{"downloads":0,"status":{"checking":false,"available":true,"downloading":true,"downloaded":false,"installing":false,"error":null,"progress":null,"updateInfo":{"version":"1.0.86"},"installStalled":false,"criticalUpdate":false,"failedPhase":null}}
(node:59335) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --input-type=module -e 'import fs from \"node:fs\";import vm from \"node:vm\";import{stripTypeScriptTypes}from\"node:module\";import{EventEmitter}from\"node:events\";let src=stripTypeScriptTypes(fs.readFileSync(\"apps/desktop/src/main/services/updates/update-service.ts\",\"utf8\"),{mode:\"transform\"}).replace(/"'^import .*?;'"\\n/gms, \"\").replace(/"'^const '"\\{ autoUpdater \\} = electronUpdater;"'$/m, "").replaceAll("export ", "")+"'"\\nglobalThis.Service=UpdateService\";let a=new EventEmitter();a.autoDownload=true;a.setFeedURL=()=>{};let offered=true,downloads=0;a.checkForUpdates=async()=>{a.emit(offered?\"update-available\":\"update-not-available\",{version:\"1.0.86\"});if(offered&&a.autoDownload)downloads++;return {isUpdateAvailable:offered,updateInfo:{version:\"1.0.86\"}}};let context={autoUpdater:a,app:{isPackaged:false,getVersion:()=>\"1.0.85\"},process:{env:{},platform:\"darwin\"},console,setInterval,clearInterval,setTimeout,fetch:async()=>({ok:false}),AbortSignal,BaseWindow:{getAllWindows:()=>[]},powerMonitor:{getSystemIdleTime:()=>0},emitBusChannel:()=>{}};vm.createContext(context);vm.runInContext(src,context);let s=new context.Service();await s.checkForUpdates();offered=false;await s.checkForUpdates();offered=true;await s.checkForUpdates();console.log(JSON.stringify({downloads,autoDownload:a.autoDownload,status:s.getStatus()}));'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 72ms:
[UpdateService] 1.0.86 available (running 1.0.85), downloading
[UpdateService] up to date on 1.0.85 (feed offers 1.0.86)
[UpdateService] feed withdrew the active download
[UpdateService] 1.0.86 available (running 1.0.85), downloading
{"downloads":1,"autoDownload":false,"status":{"checking":false,"available":true,"downloading":true,"downloaded":false,"installing":false,"error":null,"progress":null,"updateInfo":{"version":"1.0.86"},"installStalled":false,"criticalUpdate":false,"failedPhase":null}}
(node:59349) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

exec
/bin/zsh -c 'nl -ba scripts/cutover/knip-canaries.test.mjs | head -100; nl -ba apps/desktop/src/renderer/features/chat/composer/draft-store.ts | head -90; nl -ba apps/desktop/src/main/migrations/restore-legacy.test.ts | tail -120; nl -ba docs/rewrite/reports/07-cutover.md | tail -80' in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
     1	import assert from "node:assert/strict";
     2	import { spawnSync } from "node:child_process";
     3	import fs from "node:fs";
     4	import path from "node:path";
     5	import { test } from "node:test";
     6	test(
     7	  "R7-T22 knip reports unused files in all five project areas",
     8	  { timeout: 60000 },
     9	  () => {
    10	    const files = [
    11	      "src/main",
    12	      "src/shared",
    13	      "src/preload",
    14	      "src/renderer",
    15	      "scripts/lib",
    16	    ].map(
    17	      (area) =>
    18	        `apps/desktop/${area}/__cutover_knip_canary/unused.${area.startsWith("scripts") ? "mjs" : "ts"}`
    19	    );
    20	    const configFile = "cutover-knip-canaries.json";
    21	    try {
    22	      const config = JSON.parse(fs.readFileSync("knip.json", "utf8"));
    23	      const workspace = config.workspaces["apps/desktop"];
    24	      // Check the production project globs without test readers and entry scripts
    25	      // that inspect all source files. Production mode excludes these untagged globs.
    26	      workspace.entry = [];
    27	      workspace.node = false;
    28	      workspace.vitest = false;
    29	      workspace.vite = false;
    30	      workspace.typescript = false;
    31	      workspace.oxlint = false;
    32	      workspace.oxfmt = false;
    33	      config.workspaces["."] = {
    34	        entry: [],
    35	        project: [],
    36	        node: false,
    37	        vitest: false,
    38	        typescript: false,
    39	        vite: false,
    40	        "github-actions": false,
    41	        pnpm: false,
    42	        turbo: false,
    43	        oxlint: false,
    44	        oxfmt: false,
    45	      };
    46	      fs.writeFileSync(configFile, JSON.stringify(config));
    47	      for (const file of files) {
    48	        fs.mkdirSync(path.dirname(file), { recursive: true });
    49	        fs.writeFileSync(file, "export const cutoverCanary = true;\n");
    50	      }
    51	      const result = spawnSync(
    52	        "pnpm",
    53	        [
    54	          "--pm-on-fail=ignore",
    55	          "exec",
    56	          "knip",
    57	          "--config",
    58	          configFile,
    59	          "--workspace",
    60	          "apps/desktop",
    61	          "--include",
    62	          "files",
    63	          "--no-gitignore",
    64	          "--reporter",
    65	          "json",
    66	        ],
    67	        { encoding: "utf8", timeout: 55000 }
    68	      );
    69	      assert.equal(result.error, undefined);
    70	      assert.ok(result.stdout.trim(), result.stderr);
    71	      const output = JSON.parse(result.stdout);
    72	      for (const file of files)
    73	        assert.ok(
    74	          JSON.stringify(output).includes(file),
    75	          `${file} absent from knip results`
    76	        );
    77	    } finally {
    78	      fs.rmSync(configFile, { force: true });
    79	      for (const file of files)
    80	        fs.rmSync(path.dirname(file), { force: true, recursive: true });
    81	    }
    82	  }
    83	);
     1	/**
     2	 * Drafts per thread (spec 02 §8.7): text, attachments and the pre-start
     3	 * mode/model, persisted to `sessionStorage` per document (kept across HMR
     4	 * and route switches, lost on quit). Attachments in flight are not
     5	 * persisted.
     6	 */
     7	import { Store } from "@tanstack/react-store";
     8	
     9	import { bindContinuityStore } from "#renderer/lib/continuity/registry";
    10	import type { AgentMode } from "#shared/agent-types";
    11	
    12	export interface DraftAttachment {
    13	  id: string;
    14	  name: string;
    15	  path: string | null;
    16	  state: "uploading" | "done" | "error";
    17	  size?: number;
    18	  mimeType?: string;
    19	  error?: string;
    20	  /** Object URL of a pasted image, revoked on removal. */
    21	  preview?: string;
    22	}
    23	
    24	import type { SubmissionEnvelope } from "../runtime/admission";
    25	
    26	export interface Draft {
    27	  pendingSubmit?: SubmissionEnvelope;
    28	  text: string;
    29	  attachments: DraftAttachment[];
    30	  mode?: AgentMode;
    31	  model?: string | null;
    32	}
    33	
    34	const KEY = "abacus.chat.drafts";
    35	
    36	const load = (): Record<string, Draft> => {
    37	  try {
    38	    const raw = globalThis.sessionStorage?.getItem(KEY);
    39	    return raw == null ? {} : (JSON.parse(raw) as Record<string, Draft>);
    40	  } catch {
    41	    return {};
    42	  }
    43	};
    44	
    45	export const draftStore = new Store<Record<string, Draft>>(load());
    46	
    47	draftStore.subscribe((state) => {
    48	  try {
    49	    const persisted = Object.fromEntries(
    50	      Object.entries(state).map(([id, draft]) => [
    51	        id,
    52	        {
    53	          ...draft,
    54	          attachments: draft.attachments
    55	            .filter((a) => a.state === "done")
    56	            .map(({ preview: _preview, ...rest }) => rest),
    57	        },
    58	      ])
    59	    );
    60	    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(persisted));
    61	  } catch {
    62	    // Storage full or unavailable: the draft lives in memory only.
    63	  }
    64	});
    65	
    66	export const EMPTY_DRAFT: Draft = { text: "", attachments: [] };
    67	
    68	// Kept independently of draft identity and content, including across clears.
    69	const revisions = new Map<string, number>();
    70	export const draftRevision = (threadId: string): number =>
    71	  revisions.get(threadId) ?? 0;
    72	const advance = (threadId: string): void => {
    73	  revisions.set(threadId, draftRevision(threadId) + 1);
    74	};
    75	
    76	export const updateDraft = (
    77	  threadId: string,
    78	  update: (draft: Draft) => Draft
    79	): void => {
    80	  advance(threadId);
    81	  draftStore.setState((state) => ({
    82	    ...state,
    83	    [threadId]: update(state[threadId] ?? EMPTY_DRAFT),
    84	  }));
    85	};
    86	
    87	export const clearDraft = (
    88	  threadId: string,
    89	  keep: Partial<Draft> = {}
    90	): void => {
   109	      "new preference"
   110	    );
   111	    expect(
   112	      fs.existsSync(path.join(home, "electron/renderer-state.retired.json"))
   113	    ).toBe(false);
   114	    expect(readRecord(home).applied.every((e) => e.restoredAt)).toBe(true);
   115	    const index = JSON.parse(
   116	      fs.readFileSync(path.join(home, "threads/.archive-index.json"), "utf8")
   117	    );
   118	    expect(index.archived.s1).toBeUndefined();
   119	    expect(index.archived.untouched).toBeDefined();
   120	    expect((await restoreLegacyHome(home)).restored).toEqual([]);
   121	    seed(home, "cycle two");
   122	    expect((await migrate(home)).applied).toEqual([3, 4]);
   123	  }
   124	  await restoreLegacyFiles(base);
   125	  for (const home of [base, secondary]) {
   126	    expect(
   127	      fs.readFileSync(path.join(home, "transcripts/s1.json"), "utf8")
   128	    ).toBe("cycle two");
   129	    expect(
   130	      fs.readFileSync(path.join(home, "electron/renderer-state.json"), "utf8")
   131	    ).toBe("cycle two");
   132	    expect(
   133	      fs
   134	        .readFileSync(
   135	          path.join(backupsRoot(home), "restorations.jsonl"),
   136	          "utf8"
   137	        )
   138	        .trim()
   139	        .split("\n")
   140	    ).toHaveLength(2);
   141	  }
   142	});
   143	it("preserves conflicting destinations and reports their restored sibling", async () => {
   144	  seed(base);
   145	  await migrate(base);
   146	  write(path.join(base, "transcripts/s1.json"), "legacy edit");
   147	  const result = await restoreLegacyHome(base);
   148	  expect(result.collisions).toHaveLength(1);
   149	  expect(fs.readFileSync(result.collisions[0]!, "utf8")).toBe("original");
   150	  expect(fs.readFileSync(path.join(base, "transcripts/s1.json"), "utf8")).toBe(
   151	    "legacy edit"
   152	  );
   153	});
   154	it("skips damaged backups without consuming their destination", async () => {
   155	  seed(base);
   156	  await migrate(base);
   157	  const attempt = completedAttempts(base).find((a) => a.manifest.step === 4)!;
   158	  write(
   159	    path.join(attempt.directory, attempt.manifest.ops[0]!.backup!),
   160	    "damaged"
   161	  );
   162	  const result = await restoreLegacyHome(base);
   163	  expect(result.skipped).toHaveLength(1);
   164	  expect(fs.existsSync(path.join(base, "transcripts/s1.json"))).toBe(false);
   165	});
   166	it("settles an interrupted completion before restoring", async () => {
   167	  seed(base);
   168	  const failed = await migrate(base, {
   169	    ...nodeIo,
   170	    renameSync: (from, to) => {
   171	      if (to.endsWith("completed.json")) throw new Error("interrupted");
   172	      nodeIo.renameSync(from, to);
   173	    },
   174	  });
   175	  expect(failed.unresolved).toHaveLength(1);
   176	  const result = await restoreLegacyHome(base);
   177	  expect(result.restored).toContain(
   178	    path.join(base, "electron/renderer-state.json")
   179	  );
   180	});
   181	it("rejects profile traversal and corrupt restoration generations", async () => {
   182	  write(
   183	    path.join(base, "profiles.json"),
   184	    JSON.stringify({ profiles: { bad: "../other" } })
   185	  );
   186	  expect(() => profileHomes(base)).toThrow(/outside/);
   187	  seed(base);
   188	  await migrate(base);
   189	  write(path.join(backupsRoot(base), "restorations.jsonl"), "{torn");
   190	  await expect(restoreLegacyHome(base)).rejects.toThrow();
   191	});
   192	it("latest completed partial attempt wins per destination", async () => {
   193	  seed(base);
   194	  let cycle = 0;
   195	  const partial: MigrationStep = {
   196	    id: 3,
   197	    name: "partial-state-test",
   198	    plan: async (ctx) => {
   199	      const staged = path.join(ctx.staging, "state");
   200	      write(staged, "stripped " + ++cycle);
   201	      return {
   202	        writes: [
   203	          {
   204	            dest: path.join(base, "electron/renderer-state.json"),
   205	            staged,
   206	            kind: "replace-user",
   207	          },
   208	        ],
   209	        removals: [],
   210	        stats: {},
   211	        pending: 3 - cycle,
   212	      };
   213	    },
   214	  };
   215	  for (let i = 0; i < 3; i++)
   216	    await runMigrations({
   217	      home: base,
   218	      userData: path.join(base, "electron"),
   219	      appVersion: "test",
   220	      steps: [partial],
   221	      log: () => {},
   222	    });
   223	  const result = await restoreLegacyHome(base);
   224	  expect(result.restored).toHaveLength(1);
   225	  expect(
   226	    fs.readFileSync(path.join(base, "electron/renderer-state.json"), "utf8")
   227	  ).toBe("stripped 2");
   228	});
   178	## User-login performance follow-up, 1 October 2026
   179	
   180	The user authorized the logged-in shipped v1.0.85 home for M1–M5. The original home was copied into a private temporary directory outside the repository before any app launch or API write. No file from that home, app log, private producer manifest or credential-file hash is committed. `.build/` was already ignored; `git check-ignore .build/cutover/probe` confirmed it, and the initial `git status --short` was clean.
   181	
   182	The private producer records `"user-login, shipped v1.0.85, not source-generated"`, `provenance: "user-login"` and `sourceGenerated: false`. The original home had no bots or sessions. The shipped build's `window.api` created 12 bots, 40 sessions and 2,000 synthetic histories on the scratch copy. The target session has 1,000 messages; the other histories contain two short messages. This is the authorized performance workload, not the oversized synthetic migration fixture in §13.3. Source shell admission uses the user's login. Neither the synthetic account stub nor main-debugger fetch instrumentation was used. macOS outbound network access is blocked during the runs.
   183	
   184	The candidate production build and unsigned arm64 directory package were rebuilt from application source at `1b14bc91`. A separate candidate scratch copy ran the packaged migrations before timing. Step 1 converted all 2,000 histories; steps 2 and 5 completed. Both private file manifests are hash-checked before each run. The driver creates a new private home for each launch and removes it after stopping the owned process. Incidental Chromium state, logs and runtime files are excluded from the measured copies.
   185	
   186	The comparison alternates seven old/new pairs on this machine, discards pair 1, and reports the median and nearest-rank p90 of the six remaining samples. M3 is sampled 60 seconds after M1; M4 follows explicit heap-profiling enablement and garbage collection. The common readiness probe requires a visible fixture bot in the sidebar and a composer that can take focus. The shipped shell opens a short regular session and reopens Bots; the candidate opens the fixture bot. That route difference limits M1 comparability. M5 opens the same 1,000-message session in both builds and times the session click until its last message is visible.
   187	
   188	CDP now selects the main `index.html` or `index-next.html` document, records resources separately for each page, and excludes the notch document. The additional resource-tracking connection closes after first paint before idle/heap sampling. Earlier setup attempts produced no complete comparison. One attempt stopped after its discarded pair when the next old-build GC request timed out. It contributes no samples to the final medians or p90 values.
   189	
   190	The existing M6 static proxy above is unchanged. Wrong-theme screencast classification, separate companion RSS attribution, Windows reference hardware, Linux Xvfb reporting, signed RC checks and the packaged phase budgets remain open. This work supplies local numerical evidence and does not complete R7-T24 or C5.
   191	
   192	
   193	All 432 original-home file hashes are unchanged after the comparison. [Reviewed numerical samples and build hashes](07-user-login-perf.json) retain all 14 runs, per-process RSS, per-resource gzip bytes and unrounded summaries. Private paths, process command lines, the credential manifest and fixture content are omitted. The machine is an Apple M3 with 16 GiB RAM, macOS arm64.
   194	
   195	| Metric | Old median / p90 | New median / p90 | New median budget | Numeric result |
   196	| --- | --- | --- | --- | --- |
   197	| M1 interactive, ms | 1,803.050 / 2,741.600 | 6,478.800 / 7,282.500 | ≤ 1,983.355 | Fail |
   198	| M2 first paint, ms | 1,680.900 / 2,137.600 | 1,637.650 / 1,664.300 | ≤ 1,848.990 | Pass for timing; theme check open |
   199	| M3 total process-tree RSS, bytes | 659,496,960 / 669,057,024 | 914,038,784 / 983,891,968 | ≤ 725,446,656 | Fail; companion included |
   200	| M4 renderer JS heap, bytes | 19,180,194 / 19,262,056 | 20,159,910 / 20,167,356 | ≤ 21,098,213.4 | Pass |
   201	| M5 long session, ms | 721.500 / 725.200 | 163.050 / 313.100 | ≤ 793.650 and < 600 | Pass |
   202	| M6 observed initial gzip, bytes | 1,001,567 / 1,001,567 | 1,256,227 / 1,256,227 | ≤ 1,001,567 | Fail |
   203	
   204	
   205	Milliseconds in this table are displayed to three decimals. Decisions use the unrounded JSON values; no rounding changes a failure into a pass. M3 includes the companion in the total, so it cannot establish the main-window tree or the separate 150 MB cap. M2's timing passes, but its complete gate still needs the wrong-theme frame check. Local M4 and M5 meet their numeric budgets. M1, M3 and M6 fail numerically. R7-T24 remains open; this does not authorize C6 or a release.
   206	
   207	The prior static M6 proxy remains 1,001,567 bytes old versus 1,253,383 bytes candidate, +25.14%, failing its 1,001,567-byte budget. The new observed CDP result is 1,001,567 versus 1,256,227 bytes, +25.43%, and also fails.
   208	
   209	No additional user login or fetch-instrumentation approval is needed for these local measurements. Windows 11 x64 reference measurements, Linux Xvfb reporting, signed RC and physical platform acceptance still need hardware or the release pipeline. Theme-frame and companion-RSS checks need implementation. Spec §19's unresolved release-policy and cap decisions remain separate user/coordinator work.
   210	
   211	## Implementation continuation
   212	
   213	| PR | Implementation checks | Release evidence |
   214	| --- | --- | --- |
   215	| C5 completion (`d8bccf17`) | Bridge consumers resolve to implementing main routers; exact bridge enumerations frozen; final feature metadata and visible-note generator. Focused: 11 tests. | Hardware, signed, comparative and packaged acceptance gaps above remain open. Green rows record implementation checks only; partial acceptance is deferred. |
   216	| C6 (`2e4c6e3a`) | Deleted legacy renderer except locales, froze preference/starter oracles, single main entry plus notch, moved shared tool result types, removed legacy build/test/lint project. Focused: 49 tests. | Build and packaged/screenshot evidence deferred to final gates; hardware gaps remain. |
   217	| C7 (`b28230c2`) | Moved renderer and executable scripts, rewrote consumers/aliases/configuration, regenerated bridge report, widened knip and checked five planted canaries. Focused: 16 tests pass. The initial canary failure was resolved in final validation by isolating project scope from test readers; all five areas pass. | Unused exports/dependencies found by widened knip are queued for C12. Screenshot/hardware acceptance remains open. |
   218	| C8 (`0eef628b`) | Removed window.api, bridge/types/generator, raw legacy IPC/channels and legacy event sends; bus-only host events and subscription-only two-stage swaps. Focused: 64 tests. | Packaged handshake/smoke and hardware acceptance remain open. |
   219	| C9 (`3473aa84`) | Collapsed generation/chrome/startup theme and notification policy; removed generation modules, legacy metrics and raw update sends. Focused: 43 tests. | Linux native-frame CI retained. The spec’s conditional webview removal cannot yet run: the new FilePreview still consumes it, so its main security guard stays. Three-OS geometry/hardware acceptance remains open. |
   220	| C10 (`1a3249b0`) | Unconditional AG-UI spawn/health check, removed NDJSON-only host/wire selection, structured exit-64 refusal, AG-UI/compat/stdin recording, six fragmented frozen-scenario manager cases. Focused: 56 tests; all 24 NDJSON files byte-identical. | Dist-dependent spawned/recorder/golden suites deferred until dependency builds after C14. Three-OS spawned evidence remains open. |
   221	| C11 (`3f4217fd`) | Removed live legacy preferences sync, durable-state contract and the v1 transcript/dual writer. Kept read-only startup drift import, retirement protection, repair/fallback and dual removal; old-build saves are test-only fixtures. Focused: 64 tests. | Real-build downgrade and multi-platform acceptance remain open. |
   222	| C12 (`5d6e88cc`) | Removed unused legacy dependencies/patch, widened knip dependencies and unlisted checks, resolved unused exports, declared transitive imports, fixed five-area canary, set C5 +5% bundle limits and CI gate, removed v1Archived. Focused: 29 tests. | CSP narrowing and peak heap require final packaged evidence; licensed ConnectorMark paths remain. |
   223	| C13 (`330d7ac7`) | Applied the keymap to all 11 locales, then pruned 3022 to 2082 leaves using parsed literal/data/prop keys, plural stems and finite dynamic families. Restored indirect data/template catalogues discovered during final validation; removed keymap/retired transition lists and their tests. Focused: 25 tests; locale and JSX i18n checks pass. | Language screenshots and platform acceptance remain open. |
   224	| C14 (`this commit`) | Digest-checked restore command before migrations/windows, rebuilt per-profile index, generations/latest attempts, collision handling and two-cycle tests; release notes generated from visible parity metadata, support article, PLAN/PROGRESS, duplicate microphone key removed, foundation version 1.0.13. Focused: 24 tests. | Recorded notch probes/150ms haptics decision, signed RC, three-OS smoke, reference performance and release-manager go remain gaps. |
   225	
   226	
   227	### Final implementation gates
   228	
   229	All C5–C14 commits preceded dependency builds and production validation. Connectors, agent and updater were built before dist-dependent tests. The full unit and required Electron gates ran once; only affected files were rerun after repairs. No package or comparative probe was run in this implementation continuation. The checks below supersede earlier implementation checkpoints, without changing historical acceptance evidence.
   230	
   231	| Gate | Result |
   232	| --- | --- |
   233	| `tsc -b` | Pass after stale-reference repairs. |
   234	| Desktop unit projects, `--maxWorkers=2` | Initial full run: 4213 pass, 101 fail in 488 files. Affected main tests: 43 pass; affected renderer/shared tests: 123 pass after repairs (one obsolete legacy-dialog test removed). Additional import guards: 18 pass. Full suite was not repeated. |
   235	| Agent / updater / connectors unit projects | 1733 pass, two skips / 14 pass / 14 pass. |
   236	| Dist-dependent AG-UI / compatibility | 28 spawned/golden tests and five recorder tests pass. All 24 NDJSON golden files remain byte-identical to `c92812e7`. |
   237	| Cutover Node tooling | 25 tests pass after the focused canary repair; locale consumer tooling adds three passing tests. |
   238	| Required Electron `main-serial`, `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1` | **Not green.** Initial full run: 274 pass, five fail, 25 skipped. Affected five-file rerun: 214 pass, three fail. Startup, notch and browser functional failures are repaired. Remaining timing failures: streaming busy p95 60.404 ms, history expansion 60.9 ms, 3000-tool expansion 50.5 ms; each requires <50 ms. Thresholds were preserved. |
   239	| oxlint / oxfmt | Pass. |
   240	| UI registry / deletion inventory | Pass. `check:legacy-diff` was retired with the legacy renderer; parsed-import and deletion inventory guards replace it. |
   241	| Complete knip / five-area canaries | Pass. `check:knip` replaces the retired `check:knip-next`; includes files, exports, types, duplicates, dependencies and unlisted imports. |
   242	| React Compiler / production release checker | Pass; zero compiler diagnostics. Production output is an unsigned implementation build from the working tree, not signed RC acceptance. |
   243	| Locale / JSX i18n | Pass; all 11 locales have 2082 leaves and dynamic consumer families are covered. |
   244	| C5 +5% gzip size limits | Pass: main 1.2 MB, companion 600.35 kB, largest lazy chunk 162.07 kB, math 59.71 kB. [Measured bundle inventory](07-size-current.json) records this local build, not old/new reference performance. |
   245	| Additional C12 dependency audit | **Not green.** High advisories: undici GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3, GHSA-vp8m-p9jh-q5pm; brace-expansion GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. No acceptance exemption was added. Dependency remediation remains release-blocking. |
   246	
   247	Final validation repairs are included in C14: stale source aliases and transport mocks, real spawned default/refusal cases, restored indirect locale consumers, AG-UI input recording, source provenance, tooling canaries and CI size enforcement. The user-visible notes are in the actual Unreleased changelog section. `.build/` remains ignored and no account-home files are staged or committed.
   248	
   249	### Still-open §19 decisions and evidence gaps
   250	
   251	1. Whether to ship a dormant release before the flip, and thus obtain field-proven steps 1–2 and dormant fixtures.
   252	2. Whether to set absolute cold-start and memory caps after the first C5 measurement.
   253	3. Confirmation of the proposed 150 MB companion RSS cap after R6-T27 measurement.
   254	4. Release-manager rollout stages and the proposed N+1 soak of at least 14 days at 100%.
   255	5. Design ownership of the 512 MB fallback ceiling and the “too large” notice.
   256	
   257	Signed/notarized macOS, signed Windows upgrade/scaling/taskbar/uninstall, Linux packaged/native-frame checks, physical notch/external-display geometry, microphone/TCC and recorded R6-T31 haptics (<150 ms) remain gaps. Packaged fresh-install and feature demonstrations, complete immutable shipped-source migration fixtures, Windows reference and Linux performance evidence, wrong-theme frames and separate companion RSS remain gaps. The historical M1/M3/M6 numeric failures are unchanged. CSP narrowing and heap-limit reduction still need packaged evidence; webview removal remains conditional on replacing FilePreview's active consumer. The Electron timing and dependency-audit failures above prevent a green release gate. Release-manager go is still required.

codex
I confirmed an updater failure with an in-memory execution of the current service: after withdrawal cancels a download, a later offer leaves it marked “downloading” while automatic downloading stays disabled. Restore review also found cases where collision metadata can reset preferences or damaged evidence can produce an empty success report.
exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg -n '\\bt\\(["'^"`'"\\x27]|labelKey.*\\+|i18nKey' apps/desktop/src/renderer --glob '*ts*' --glob '"'!*.test.*'"' | head -150; cat apps/desktop/src/renderer/lib/i18n/dynamic-keys.ts | head -80; cat CHANGELOG.md | head -50; nl -ba apps/desktop/scripts/measure-release-size.mjs | head -65; cat docs/rewrite/reports/07-size-current.json | tail -30" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
apps/desktop/src/renderer/main.tsx:67:    return i18n.isInitialized ? i18n.t(key) : key;
apps/desktop/src/renderer/features/shell/top-bar.tsx:105:        label={t(settings ? "settings.backToApp" : "shell.topBar.back")}
apps/desktop/src/renderer/components/keymap-editor/index.tsx:210:                t(action.labelKey) +
apps/desktop/src/renderer/features/routines/form.tsx:244:              {t(routineId ? "phase5.editRoutine" : "phase5.createRoutine")}
apps/desktop/src/renderer/features/routines/form.tsx:526:                    label={t(routineId ? "phase5.save" : "phase5.create")}
apps/desktop/src/renderer/features/settings/account-usage.tsx:79:            {t(pending ? "phase5.waitingSignIn" : "phase5.signIn")}
apps/desktop/src/renderer/features/routines/row.tsx:98:      label: t(row.enabled ? "phase5.pause" : "phase5.resume"),
apps/desktop/src/renderer/features/settings/updates.tsx:322:      {t(label, { percent: Math.round(status.progress?.percent ?? 0) })}
apps/desktop/src/renderer/features/settings/updates.tsx:350:          label: t(label, {
apps/desktop/src/renderer/features/settings/environment.tsx:94:                  {t(status?.ready ? "phase5.use" : "phase5.unavailable")}
apps/desktop/src/renderer/features/settings/environment.tsx:398:              {t(query.data?.[key] ? "phase5.detected" : "phase5.notDetected")}
apps/desktop/src/renderer/features/artifacts/index.tsx:120:            title={`${t(type ? `phase5.artifactTypes.${type}` : "artifacts.sidebar.all")} (${found.filter((a) => !type || a.kind === type).length})`}
apps/desktop/src/renderer/features/artifacts/index.tsx:209:        label: t(a.kind === "link" ? "phase5.openBrowser" : "phase5.openFile"),
apps/desktop/src/renderer/features/chat/kit/permissions/permission-card.tsx:248:            {t(MODE_LABEL_KEYS[mode] ?? "chat.mode.DEFAULT")}
apps/desktop/src/renderer/features/chat/kit/permissions/permission-card.tsx:359:          {t(problem)}
apps/desktop/src/renderer/features/chat/kit/permissions/permission-card.tsx:517:          {t(problem)}
apps/desktop/src/renderer/features/chat/kit/queue-slot.tsx:98:          {t(problem)}
apps/desktop/src/renderer/features/chat/kit/queue-slot.tsx:102:          {t(HINT_KEYS[entry.waitingFor])}
apps/desktop/src/renderer/features/chat/kit/subagents/subagent-card.tsx:81:    description ?? t(KIND_KEYS[subagent.name] ?? "chat.subagent.kind.generic");
apps/desktop/src/renderer/features/bots/chat/feedback.tsx:90:                aria-label={t(label)}
apps/desktop/src/renderer/features/bots/panel/bot-side-panel.tsx:233:          {t(pinned ? "bots.sidebar.unpin" : "bots.sidebar.pin")}
apps/desktop/src/renderer/features/bots/chat/identity.tsx:25:      <h1>{t(chat ? "bots.gone.chat" : "bots.gone.bot")}</h1>
apps/desktop/src/renderer/features/library/skills-tools.tsx:131:              {t(source === "project" ? "phase5.workspace" : "phase5.global")}
apps/desktop/src/renderer/features/library/skills-tools.tsx:324:              t(`capabilities.toolsets.${s.labelKey}`) +
apps/desktop/src/renderer/features/library/skills-tools.tsx:343:                {t(s.alwaysOn ? "phase5.alwaysOn" : "phase5.planned")}
apps/desktop/src/renderer/features/settings/models.tsx:474:            {t(field.connect ? "phase5.connectProvider" : "phase5.getKey", {
apps/desktop/src/renderer/features/settings/models.tsx:483:              {t(pending ? "phase5.waitingSignIn" : "phase5.connect")}
apps/desktop/src/renderer/features/chat/kit/tools/tool-line.tsx:472:        {t(STATUS_KEY[tool.status])}
apps/desktop/src/renderer/features/library/connectors.tsx:128:            {t(group ? "phase5.connected" : "phase5.available")}
apps/desktop/src/renderer/features/library/connectors.tsx:142:                    {t(group ? "phase5.connected" : "phase5.available")}
apps/desktop/src/renderer/features/library/connectors.tsx:157:                    {t(group ? "phase5.manage" : "phase5.add")}
apps/desktop/src/renderer/features/settings/search-index.ts:165:      `${row.label ?? t(row.labelKey)} ${t(`settings.pages.${row.page}`)}`
apps/desktop/src/renderer/features/bots/form/bot-form.tsx:297:                    label={t(label)}
apps/desktop/src/renderer/features/bots/form/bot-form.tsx:346:            label={t(bot ? "bots.form.save" : "bots.form.create")}
apps/desktop/src/renderer/features/settings/index.tsx:112:              title={entry.label ?? t(entry.labelKey)}
apps/desktop/src/renderer/features/settings/index.tsx:121:          <NavList.Group key={group.label} label={t(group.label)}>
apps/desktop/src/renderer/features/bots/sidebar/bot-row.tsx:112:        {t(MENU_LABEL_KEYS[item.id])}
apps/desktop/src/renderer/features/library/messaging.tsx:125:              title={t(key)}
apps/desktop/src/renderer/features/library/messaging.tsx:375:                  {t(u.status === "paused" ? "phase5.resume" : "phase5.pause")}
apps/desktop/src/renderer/features/bots/sidebar/bot-menu.tsx:85:  const fail = (key: string) => toast.add({ title: t(key), type: "error" });
apps/desktop/src/renderer/features/chat/composer/chips.tsx:113:        {t(MODE_LABEL_KEYS[shown] ?? "chat.mode.DEFAULT")}
apps/desktop/src/renderer/features/chat/composer/chips.tsx:136:              {t(MODE_LABEL_KEYS[mode]!)}
apps/desktop/src/renderer/features/chat/composer/chips.tsx:139:              {t(MODE_DESCRIPTION_KEYS[mode]!)}
cat: apps/desktop/src/renderer/lib/i18n/dynamic-keys.ts: No such file or directory
# Changelog

<!-- One section per version: `## 1.0.62 (2026-09-09)`. Write freely under
     it: prose, ### headings, bullets. Notes for the next release go under
     `## Unreleased
`. Sections here are kept as written; a release nobody
     wrote up says "Bug fixes, improvements in quality and speed." -->

## Unreleased

The app has a new rail for Bots, Sessions, Routines, Artifacts and Library. Library brings together connectors, messaging, MCP servers, skills and tools. Settings has separate pages and search. The system draws the title bar, and your light, dark or system theme applies before the window appears.

A companion around the Mac notch, or by the Windows clock, shows bot activity and requests your attention. You can turn it off in General settings. Sounds have per-bot levels and quiet hours; system notifications are silent. Bots keep their looks in the new avatar style, math renders as replies arrive, and the tour can be replayed from Settings.

The built-in code editor is replaced by Open in editor. Sessions are grouped by folder, and update notices appear in the title bar.

On first launch, Updating your data may appear while conversations are converted. Release N leaves legacy files in place. Going back to the previous version shows the data left before the update; new conversations and preference changes do not appear there. See the Going back support article before downgrading after release N+1.

- Artifacts refresh automatically; the Refresh button is removed.
- The rail opens the Bots sidebar directly.
- Start a bot chat from its bot page; the start page no longer has a composer.
- Each rail item has its own sidebar.
- Legacy ?view=capabilities and ?view=messaging links are retired.
- The companion shows ongoing work; the background Task still running notification is removed.
- Finishing setup opens the saved destination without switching a workspace.
- Setup no longer resets an open tour.
- Opening a routine run keeps your current workspace.
- Legacy /settings/jobs and /routines/chat links are retired; open Routines from the rail.


A smaller download and install: the package no longer carries a second copy
of the interface libraries that are already built into the app.

The app reports which first-run setup steps it reached, so a setup that stops
partway can be found and fixed. It follows the same setting as the log sync.

Pasting a model provider's API key is the same dialog everywhere: from
onboarding, from the Models page, and from Connect Gemini in the model picker,
which now opens it in place instead of sending you to Settings. It names the
errand, carries the link to the provider's console, and says when a key is
already saved.

A reply that drifts into another language is caught even when it is full of
English technical terms. A Chinese answer to an English question, with
GitHub, account names and token scopes in it, read as "no clear language" and
was never asked to answer again; now any script the user did not write in is
drift once it is more than a stray name.

X search now runs on your Abacus.AI account, reading X's own index; the xAI
Live Search key and switch are gone, since xAI retired that service.
     1	import fs from "node:fs";
     2	import path from "node:path";
     3	import { fileURLToPath } from "node:url";
     4	import { gzipSync } from "node:zlib";
     5	const desktop = path.resolve(
     6	  path.dirname(fileURLToPath(import.meta.url)),
     7	  ".."
     8	);
     9	const root = path.resolve(desktop, "../..");
    10	const dist = path.join(desktop, "dist/renderer");
    11	const files = fs
    12	  .readdirSync(path.join(dist, "assets"))
    13	  .filter((f) => f.endsWith(".js"));
    14	const gzip = (file) => gzipSync(fs.readFileSync(path.join(dist, file))).length;
    15	const initial = (html) =>
    16	  [
    17	    ...fs
    18	      .readFileSync(path.join(dist, html), "utf8")
    19	      .matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g),
    20	  ].map((m) => m[1].replace(/^\//, ""));
    21	const mainHtml = "index.html";
    22	const entryResources = new Set(
    23	  [mainHtml, "notch.html"]
    24	    .flatMap((file) => initial(file))
    25	    .map((file) => file.replace(/^\.\//, ""))
    26	);
    27	const largest = files
    28	  .filter(
    29	    (file) =>
    30	      !/worker|ort-wasm/.test(file) && !entryResources.has(`assets/${file}`)
    31	  )
    32	  .toSorted((a, b) => gzip(`assets/${b}`) - gzip(`assets/${a}`))[0];
    33	if (!largest) throw new Error("No lazy JavaScript chunk was emitted");
    34	const entries = [
    35	  {
    36	    name: "Main initial",
    37	    path: initial("index.html"),
    38	  },
    39	  { name: "Notch initial", path: initial("notch.html") },
    40	  { name: "Largest lazy chunk", path: [`assets/${largest}`] },
    41	  {
    42	    name: "Math lazy chunk",
    43	    path: files.filter((f) => f.startsWith("temml-")).map((f) => `assets/${f}`),
    44	  },
    45	].map((e) => ({ ...e, gzipBytes: e.path.reduce((n, f) => n + gzip(f), 0) }));
    46	const report = {
    47	  commit: JSON.parse(fs.readFileSync(path.join(dist, "build.json"))).commit,
    48	  measuredAt: new Date().toISOString(),
    49	  entries,
    50	};
    51	const target =
    52	  process.argv[2] ??
    53	  path.join(root, "docs/rewrite/reports/07-size-current.json");
    54	fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
    55	fs.writeFileSync(
    56	  path.join(root, ".size-limit.json"),
    57	  JSON.stringify(
    58	    entries.map((e) => ({
    59	      name: e.name,
    60	      gzip: true,
    61	      limit: JSON.parse(
    62	        fs.readFileSync(path.join(root, ".size-limit.json"))
    63	      ).find((limit) => limit.name === e.name)?.limit,
    64	      path: e.path.map((f) =>
    65	        path.relative(root, path.join(dist, f)).replaceAll("\\", "/")
        "./assets/useNavigate-D5KOICuw.js",
        "./assets/fileRoute-Bk5pnR5L.js",
        "./assets/empty-state-BUK85Zdy.js",
        "./assets/dropdown-menu-0FDckRBw.js",
        "./assets/turns-CO8eSM_q.js",
        "./assets/chat-D9DWX5i0.js",
        "./assets/useStore-Jt_fedF3.js",
        "./assets/runtime-D1c6OXEy.js",
        "./assets/bot-avatar-K2XYybxl.js",
        "./assets/cues-BWDDQkLq.js",
        "./assets/shared-element-CcviPcKT.js",
        "./assets/transition-types-B8Ger0ke.css",
        "./assets/chat-DId50OC-.css",
        "./assets/bot-avatar-tazUtPIO.css",
        "./assets/notch-DNnXb795.css"
      ],
      "gzipBytes": 601415
    },
    {
      "name": "Largest lazy chunk",
      "path": ["assets/transformers.web-CRbLS8vX.js"],
      "gzipBytes": 162406
    },
    {
      "name": "Math lazy chunk",
      "path": ["assets/temml-CiP_lRsR.js"],
      "gzipBytes": 59838
    }
  ]
}

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --input-type=module -e 'import fs from \"node:fs\";import{execFileSync}from\"node:child_process\";import{parseSync}from\"oxc-parser\";import{flatten,sourceFiles}from\"./apps/desktop/scripts/i18n-consumers.mjs\";let old=new Set(flatten(JSON.parse(execFileSync(\"git\",[\"show\",\"1b14bc91:apps/desktop/src/renderer/locales/en-US.json\"],{encoding:\"utf8\",stdio:[\"ignore\",\"pipe\",\"ignore\"]}))));let keys=new Set(flatten(JSON.parse(fs.readFileSync(\"apps/desktop/src/renderer/locales/en-US.json\"))));let walk=(n,f)=>{if("'!n||typeof n!=="object")return;f(n);for(let v of Object.values(n)){if(Array.isArray(v))v.forEach(x=>walk(x,f));else if(v&&typeof v==="object")walk(v,f)}};for(let[file,source]of Object.entries(sourceFiles("apps/desktop/src")))walk(parseSync(file,source).program,n=>{if(n.type==="Literal"&&typeof n.value==="string"&&old.has(n.value)&&!keys.has(n.value))console.log(file,n.value)});'"'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 4335ms:
apps/desktop/src/main/dev/mutation-harness.ts bots.create
apps/desktop/src/main/dev/mutation-harness.ts bots.delete

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg --files | /Users/rajaniraiyn/.local/share/mise/installs/ripgrep/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin/rg 'build\\.sh|release|AGENTS'; nl -ba node_modules/electron-updater/out/AppUpdater.js | sed -n '339,370p'; nl -ba apps/desktop/src/main/migrations/attempt-records.ts | tail -55; nl -ba apps/desktop/src/main/migrations/restore-legacy.ts | sed -n '140,240p'; nl -ba apps/desktop/src/main/services/updates/update-service.ts | sed -n '355,375p'; cat apps/desktop/src/renderer/features/parity.test.ts | head -50" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 0ms:
scripts/cutover/release-notes.test.mjs
scripts/cutover/release-notes.mjs
docs/rewrite/reports/07-release-notes.md
apps/desktop/scripts/measure-release-size.mjs
apps/desktop/scripts/release-build-plugin.mjs
apps/desktop/scripts/check-release-build.mjs
apps/desktop/scripts/release-build-plugin.d.mts
   339	    async isUpdateAvailable(updateInfo) {
   340	        const latestVersion = (0, semver_1.parse)(updateInfo.version);
   341	        if (latestVersion == null) {
   342	            throw (0, builder_util_runtime_1.newError)(`This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: "${updateInfo.version}"`, "ERR_UPDATER_INVALID_VERSION");
   343	        }
   344	        const currentVersion = this.currentVersion;
   345	        if ((0, semver_1.eq)(latestVersion, currentVersion)) {
   346	            return false;
   347	        }
   348	        if (!(await Promise.resolve(this.isUpdateSupported(updateInfo)))) {
   349	            return false;
   350	        }
   351	        const isUserWithinRollout = await Promise.resolve(this.isUserWithinRollout(updateInfo));
   352	        if (!isUserWithinRollout) {
   353	            return false;
   354	        }
   355	        // https://github.com/electron-userland/electron-builder/pull/3111#issuecomment-405033227
   356	        // https://github.com/electron-userland/electron-builder/pull/3111#issuecomment-405030797
   357	        const isLatestVersionNewer = (0, semver_1.gt)(latestVersion, currentVersion);
   358	        const isLatestVersionOlder = (0, semver_1.lt)(latestVersion, currentVersion);
   359	        if (isLatestVersionNewer) {
   360	            return true;
   361	        }
   362	        return this.allowDowngrade && isLatestVersionOlder;
   363	    }
   364	    checkIfUpdateSupported(updateInfo) {
   365	        const minimumSystemVersion = updateInfo === null || updateInfo === void 0 ? void 0 : updateInfo.minimumSystemVersion;
   366	        const currentOSVersion = (0, os_1.release)();
   367	        if (minimumSystemVersion) {
   368	            try {
   369	                if ((0, semver_1.lt)(currentOSVersion, minimumSystemVersion)) {
   370	                    this._logger.info(`Current OS version ${currentOSVersion} is less than the minimum OS version required ${minimumSystemVersion} for version ${currentOSVersion}`);
   185	          backupDirName(
   186	            manifest.stamp,
   187	            manifest.step,
   188	            manifest.name,
   189	            manifest.attempt
   190	          )
   191	      )
   192	        throw new Error("Manifest roots or identity mismatch");
   193	      if (!path.isAbsolute(manifest.roots.userData))
   194	        throw new Error("Invalid userData root");
   195	      for (const op of manifest.ops) {
   196	        if (
   197	          op.op === "remove" &&
   198	          (op.backup === undefined || op.originalSha256 === undefined)
   199	        )
   200	          throw new Error("Removal without backup evidence");
   201	        if (op.backup !== undefined && op.originalSha256 === undefined)
   202	          throw new Error("Backup without digest");
   203	      }
   204	      attempts.push({ directory, manifest, completed });
   205	    } catch (error) {
   206	      if (!isAbsentError(error))
   207	        log(`[migrations] excluded ${name}: ${String(error)}`);
   208	    }
   209	  }
   210	  return attempts;
   211	};
   212	
   213	export const rebuildRestoreIndex = (
   214	  home: string,
   215	  io: MigrationIo = nodeIo,
   216	  log?: (message: string) => void
   217	): RestoreIndexEntry[] => {
   218	  const entries = completedAttempts(home, io, log).flatMap(
   219	    ({ directory, manifest }) =>
   220	      manifest.ops.map((op) => ({
   221	        ...op,
   222	        directory: path.basename(directory),
   223	        attempt: manifest.attempt,
   224	        step: manifest.step,
   225	        stamp: manifest.stamp,
   226	        roots: manifest.roots,
   227	      }))
   228	  );
   229	  const file = path.join(backupsRoot(home), "restore-index.jsonl");
   230	  const text = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
   231	  let previous: string | null = null;
   232	  try {
   233	    previous = io.readFileSync(file).toString("utf8");
   234	  } catch (error) {
   235	    if (!isAbsentError(error)) throw error;
   236	  }
   237	  if (previous !== text) writeFileAtomic(file, text, io);
   238	  return entries;
   239	};
   140	    collisions: [],
   141	    skipped: [],
   142	  };
   143	  const consumed = new Set<string>();
   144	  const destinations: string[] = [];
   145	  const index = readArchiveIndexStrict(path.join(home, "threads"));
   146	  for (const [destination, entry] of latest) {
   147	    const backup = safePath(
   148	      path.join(backupsRoot(home), entry.directory),
   149	      entry.backup!
   150	    );
   151	    try {
   152	      if (sha256File(backup, nodeIo) !== entry.originalSha256) {
   153	        result.skipped.push(`${destination}: backup digest mismatch`);
   154	        continue;
   155	      }
   156	    } catch (error) {
   157	      result.skipped.push(`${destination}: ${String(error)}`);
   158	      continue;
   159	    }
   160	    // Reject symlinks along either path. No restore may follow a profile link outside its home.
   161	    for (const file of [destination, backup]) {
   162	      let current = file;
   163	      while (inside(home, current) !== null) {
   164	        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
   165	          throw new Error(`Symlink in restore path: ${current}`);
   166	        current = path.dirname(current);
   167	      }
   168	    }
   169	    const current = fs.existsSync(destination)
   170	      ? sha256File(destination, nodeIo)
   171	      : null;
   172	    let target = destination;
   173	    if (
   174	      current !== null &&
   175	      current !== entry.originalSha256 &&
   176	      current !== entry.resultSha256
   177	    ) {
   178	      const parsed = path.parse(destination);
   179	      target = path.join(
   180	        parsed.dir,
   181	        `${parsed.name}.restored-${formatStamp(now)}-${entry.attempt}${parsed.ext}`
   182	      );
   183	      if (
   184	        fs.existsSync(target) &&
   185	        sha256File(target, nodeIo) !== entry.originalSha256
   186	      )
   187	        throw new Error(`Restore collision already exists: ${target}`);
   188	      result.collisions.push(target);
   189	    }
   190	    if (current !== entry.originalSha256 || target !== destination) {
   191	      fs.mkdirSync(path.dirname(target), { recursive: true });
   192	      writeFileAtomic(target, fs.readFileSync(backup), nodeIo);
   193	    }
   194	    // Keep backup evidence for the rollback window and retry after interrupted metadata writes.
   195	    result.restored.push(destination);
   196	    destinations.push(destination);
   197	    for (const op of allByDestination.get(destination) ?? [])
   198	      consumed.add(op.attempt);
   199	    if (
   200	      destination.startsWith(path.join(home, "transcripts") + path.sep) ||
   201	      destination.startsWith(path.join(home, "threads") + path.sep)
   202	    )
   203	      delete index.archived[
   204	        path.basename(destination).replace(/\.(json|cleared)$/, "")
   205	      ];
   206	    if (destination === path.join(userData, "renderer-state.json"))
   207	      fs.rmSync(path.join(userData, "renderer-state.retired.json"), {
   208	        force: true,
   209	      });
   210	  }
   211	  if (destinations.length) {
   212	    writeFileAtomic(
   213	      path.join(home, "threads", ARCHIVE_INDEX_NAME),
   214	      JSON.stringify(index),
   215	      nodeIo
   216	    );
   217	    const record = recordState.record;
   218	    record.applied = record.applied.map((entry) =>
   219	      [3, 4].includes(entry.id)
   220	        ? { ...entry, restoredAt: now.toISOString() }
   221	        : entry
   222	    );
   223	    record.partial = record.partial?.filter(
   224	      (entry) => ![3, 4].includes(entry.id)
   225	    );
   226	    writeRecord(home, record);
   227	    const generation: Generation = {
   228	      generation: randomUUID(),
   229	      at: now.toISOString(),
   230	      consumed: [...consumed],
   231	      destinations,
   232	    };
   233	    writeFileAtomic(
   234	      journal,
   235	      generations.map((g) => JSON.stringify(g) + "\n").join("") +
   236	        JSON.stringify(generation) +
   237	        "\n",
   238	      nodeIo
   239	    );
   240	  }
   355	    // A concurrent older check cannot authorize an install; await it, then fetch again.
   356	    if (metadataOnly && this.checkingFeed != null) await this.checkingFeed;
   357	    if (this.checkingFeed != null) return this.checkingFeed;
   358	    const previous = autoUpdater.autoDownload;
   359	    if (metadataOnly || this.status.downloading || this.status.downloaded)
   360	      autoUpdater.autoDownload = false;
   361	    this.checkingFeed = autoUpdater.checkForUpdates();
   362	    try {
   363	      return await this.checkingFeed;
   364	    } finally {
   365	      this.checkingFeed = null;
   366	      autoUpdater.autoDownload =
   367	        previous && !this.status.downloaded && !this.status.downloading;
   368	    }
   369	  }
   370	
   371	  async checkForUpdates(): Promise<{ success: boolean; error?: string }> {
   372	    if (
   373	      app.isPackaged &&
   374	      !existsSync(join(process.resourcesPath, "app-update.yml"))
   375	    ) {
import fs from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { expect, it } from "vitest";

import { PHASE5_PARITY as artifacts } from "./artifacts/parity";
import { BOT_PARITY } from "./bots/parity";
import { PHASE5_PARITY as library } from "./library/parity";
import { PHASE6_NOTCH_PARITY } from "./notch/parity";
import { PHASE6_ONBOARDING_PARITY } from "./onboarding/parity";
import { PHASE5_PARITY as routines } from "./routines/parity";
import { SESSION_PARITY } from "./sessions/parity";
import { PHASE5_PARITY as settings } from "./settings/parity";
const desktop = path.resolve(import.meta.dirname, "../../..");
const ids = JSON.parse(
  fs.readFileSync(
    path.join(desktop, "../../scripts/cutover/parity-ids.json"),
    "utf8"
  )
) as Record<string, string[]>;
const rows = [
  ...BOT_PARITY,
  ...SESSION_PARITY,
  ...routines,
  ...artifacts,
  ...library,
  ...settings,
  ...PHASE6_ONBOARDING_PARITY,
  ...PHASE6_NOTCH_PARITY,
];
const resolves = (consumer: string) => {
  if (consumer.startsWith("retired: "))
    return /[.!?]$/.test(consumer.slice(9).trim());
  const [file, symbol] = consumer.split("#");
  if (!file?.startsWith("src/renderer/") && !file?.startsWith("src/main/"))
    return false;
  if (
    !symbol ||
    file.includes("..") ||
    !fs.existsSync(path.join(desktop, file))
  )
    return false;
  const result = parseSync(
    file,
    fs.readFileSync(path.join(desktop, file), "utf8")
  );
  if (result.errors.length) return false;
  let found = false;
  const walk = (value: unknown): void => {

exec
/bin/zsh -c "/Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --test apps/desktop/scripts/i18n-dynamic-keys.test.mjs; /Users/rajaniraiyn/.local/share/mise/installs/node/24.21.0/bin/node --input-type=module -e 'import{consumers}from\"./apps/desktop/scripts/i18n-consumers.mjs\";console.log([...consumers([\"family.a\"],{\"x.ts\":\"t("'`family.${value}`)"},[{prefix:"family.",values:["a","deleted"]}])])'"'; nl -ba apps/desktop/src/main/services/session/cli-manager-taps.test.ts | sed -n '224,279p'; nl -ba .github/workflows/ci.yml | sed -n '188,206p'; nl -ba apps/desktop/scripts/i18n-consumers.mjs | sed -n '40,60p'" in /Users/rajaniraiyn/work/abacusai-bot/.claude/worktrees/codex-cutover
 succeeded in 436ms:
✔ consumer set includes literals, data keys, props, plural stems and template prefixes (2.750958ms)
✔ empty-prefix templates require finite declaration (0.321ms)
✔ R7-T26 every remaining leaf belongs to the final consumer set (330.310042ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 417.068541
[ 'family.a' ]
   224	    const cut = bytes("🙂").subarray(0, 2);
   225	    expect(splitter.push(cut)).toEqual([]);
   226	    expect(splitter.end()).toEqual(["two�"]);
   227	  });
   228	});
   229	
   230	for (const scenario of ["plain-text", "tool-bash", "permission-accept"]) {
   231	  for (const mode of ["fd", "inline"] as const) {
   232	    it(`R7-T7 ${scenario} frozen bytes survive fragmented ${mode} manager input`, async () => {
   233	      const expected = fs.readFileSync(
   234	        path.resolve(
   235	          "../../packages/agent/src/agui/__fixtures__",
   236	          `${scenario}.ndjson`
   237	        ),
   238	        "utf8"
   239	      );
   240	      const hello = JSON.stringify({
   241	        type: "CUSTOM",
   242	        name: "wire.hello",
   243	        value: {
   244	          protocol: 1,
   245	          wire: "agui",
   246	          compat: mode,
   247	          incarnation: "inc-1",
   248	        },
   249	      });
   250	      const compat =
   251	        mode === "fd"
   252	          ? JSON.stringify({ type: "compat.hello" }) + "\n" + expected
   253	          : expected;
   254	      const bytes =
   255	        mode === "fd"
   256	          ? compat
   257	          : compat
   258	              .split("\n")
   259	              .filter(Boolean)
   260	              .map((line) => "\u001e" + line + "\n")
   261	              .join("");
   262	      const script = `const fs=require('fs');fs.writeSync(1,${JSON.stringify(hello + "\n")});const data=Buffer.from(${JSON.stringify(bytes)});let at=0;function write(){if(at===data.length){fs.writeSync(1,JSON.stringify({type:'CUSTOM',name:'session.ready',value:{}})+'\\n');setTimeout(()=>process.exit(0),40);return;}const next=Math.min(data.length,at+7);fs.writeSync(${mode === "fd" ? 3 : 1},data.subarray(at,next));at=next;setImmediate(write);}write();`;
   263	      const { service, ndjson, agui } = manager(script);
   264	      try {
   265	        await service.startSession({
   266	          workspaceId: "w",
   267	          sessionId: "session-1",
   268	          startupTimeoutMs: 10000,
   269	        });
   270	        await vi.waitFor(() => expect(agui.at(-1)).toEqual({ type: "exit" }), {
   271	          timeout: 10000,
   272	        });
   273	        expect(
   274	          ndjson.map((event) => JSON.stringify(event) + "\n").join("")
   275	        ).toBe(expected);
   276	      } finally {
   277	        await service.dispose();
   278	      }
   279	    }, 15000);
   188	          await expect("printf 'b\\na\\n' | sort | head -1", "a");
   189	          await expect("cat <<'EOF'\nquotes ' and \" and $HOME\nEOF", "quotes ' and \" and $HOME");
   190	          await expect("false && echo wrong; false || printf recovered", "recovered");
   191	          await expect("mkdir -p 'dir with space' && printf x > 'dir with space/f.txt' && grep -c x 'dir with space/f.txt'", "1");
   192	          await expect("exit 7", "", 7);
   193	          await expect("node -e \"console.log(process.argv[1])\" 'C:/Users/Some One'", "C:/Users/Some One");
   194	          await expect("printf '%s' \"$BB_OVERRIDE_APPLETS\" | cut -c1-1", ";");
   195	          JS
   196	
   197	      # The desktop app spawns the agent and speaks NDJSON to it. This asserts
   198	      # the host still answers on stdout in the protocol, whatever it has to
   199	      # say: a stack trace on stderr and silence on stdout is a dead app.
   200	      - name: The agent speaks AG-UI with a compat stream
   201	        shell: bash
   202	        run: |
   203	          cd packages/agent
   204	          ../../node_modules/.bin/vitest run --project e2e src/agui/agui-spawn.e2e.test.ts --testNamePattern 'same bytes on fd 3'
   205	
   206	  # renderer's screenshot gate (spec 01 §10.2) in the real Electron
    40	        throw new Error(`Unbounded translation template in ${file}`);
    41	    });
    42	  for (const key of keys)
    43	    if (
    44	      literals.has(key) ||
    45	      plurals.some(
    46	        (s) => key.endsWith(s) && literals.has(key.slice(0, -s.length))
    47	      )
    48	    )
    49	      used.add(key);
    50	  for (const row of dynamic)
    51	    for (const value of row.values)
    52	      if (keys.includes(row.prefix + value)) used.add(row.prefix + value);
    53	  for (const prefix of templates)
    54	    if (!dynamic.some((row) => row.prefix === prefix))
    55	      for (const key of keys) if (key.startsWith(prefix)) used.add(key);
    56	  return used;
    57	};
    58	export const sourceFiles = (dir) => {
    59	  const sources = {};
    60	  const visit = (directory) => {

codex
1. blocker — `docs/rewrite/reports/07-cutover.md:238`: Release N has not met its required gates. The report records failing Electron timing tests and a failing dependency audit; line 257 lists missing packaged, signed, platform and migration acceptance. M1/M3/M6 also remain failed at lines 197–202. Prove by comparing these results with spec §17 and C14’s gate. Fix the failures and obtain final-tree acceptance evidence before releasing; focused reruns and unsigned builds do not satisfy these requirements.

2. major — `apps/desktop/src/main/migrations/restore-legacy.ts:206`: A conflicting `renderer-state.json` goes to a `.restored-` sibling, but restore still deletes its retirement marker and consumes the canonical destination. Subsequent N startup resets absent legacy-provenance preferences even though their saved values were never restored canonically. Reproduce by running step 3, changing an unrelated retained state key, restoring, then calling `importLegacyPrefsAtStartup`. Fix by retaining retirement evidence and leaving the destination unresolved until canonical restoration succeeds.

3. major — `apps/desktop/src/main/migrations/restore-legacy.ts:145`: Restore requires a valid archive index before restoring any verified backup. It therefore cannot recover histories after index corruption, despite spec risk R18 explicitly naming this command as recovery. Reproduce by completing step 4, replacing `threads/.archive-index.json` with `{`, then running `--restore-legacy-files`. Fix by preserving the damaged index and reconstructing archive evidence from completed attempts before restoring.

4. major — `apps/desktop/src/main/migrations/attempt-records.ts:205`: Invalid or missing attempt evidence is excluded without becoming a restore failure. The command can print empty `restored` and `skipped` arrays and exit 0 while archived transcripts remain absent. Reproduce by completing step 4, then corrupting `attempt.json` or deleting `completed.json` before restore. Fix by reporting excluded record-referenced attempts as skipped failures or aborting recovery; do not replace the derived index with an apparently complete subset.

5. major — `apps/desktop/src/main/services/updates/update-service.ts:366`: C2’s download cancellation leaves `autoDownload` permanently false. `checkFeed` restores it using the previous value, overriding cancellation’s attempt to re-enable it. A later offer sets `downloading=true` but starts no transfer. An in-memory execution of the current service reproduced one initial download followed by withdrawal and re-offer, with no second download. Fix by deriving download admission from current state and setting `downloading` only when a transfer actually starts; test the complete withdrawal/re-offer sequence.

6. major — `apps/desktop/src/renderer/features/chat/composer/draft-store.ts:38`: Upgrade silently abandons v1.0.85’s persisted `composer.draft:<key>` text. The deleted reader used durable storage; the replacement reads only `abacus.chat.drafts` from sessionStorage. Spec 00 permits omitting draft migration only with release-note disclosure, which C14’s notes omit. Reproduce by saving unsent text in v1.0.85 and reopening its composer after upgrade. Fix by importing saved text once, or providing the required advance disclosure and recovery instructions.

7. major — `apps/desktop/package.json:3`: C14’s default foundation version is `1.0.13`, below shipped `1.0.85`. Normally packaged artifacts will be rejected as downgrades by electron-updater, so they cannot deliver the intended upgrade. Prove by offering a normally built `1.0.13` artifact to `1.0.85` with downgrade admission disabled. Fix by assigning a release version above the latest shipped version and validating that the installer, feed and experience manifest carry the same version, including any private-pipeline override.

8. major — `scripts/cutover/knip-canaries.test.mjs:26`: The canary test empties production entries and disables discovery plugins before checking unused files. This cannot establish that the actual `check:knip` configuration detects those files, despite the passing claim at report line 241. Prove by comparing its generated configuration with `knip.json`; production entry-discovery mistakes cannot affect this test. Fix by running planted canaries against the unchanged production configuration and repairing any rules that conceal unused files.

9. major — `apps/desktop/src/main/services/session/cli-manager-taps.test.ts:262`: The new R7-T7 cases embed expected golden bytes in a fake child and compare their decoded output with those same bytes. They exercise framing, but neither agent scenario production nor the production tap consumers required by spec §8.3. Prove by disabling a production tap in `service-host.ts`; these tests remain green. Fix by asserting artifact, messaging, routine, waiter, browser, host-service and watchdog effects through the real spawned-agent path, covering both fd and inline transport.

10. minor — `apps/desktop/scripts/i18n-consumers.mjs:52`: Locale validation silently ignores declared dynamic keys missing from the locale. The accompanying test checks only that remaining leaves are used, so deleting a referenced dynamic leaf can pass. Prove with a manifest declaring `family.a` and `family.deleted`, a dynamic translation call, and locale keys containing only `family.a`; `consumers` returns successfully. Fix by validating every declared dynamic key and plural family against the locale, independently of unused-key detection. The current three passing tests do not establish that pruning preserved every consumer.

11. minor — `.github/workflows/ci.yml:204`: The explicit AG-UI smoke filters for `same bytes on fd 3`, but the matching test was renamed to `the default wire is AG-UI and fd 3 preserves frozen compat bytes`. This step can succeed with all tests skipped. Prove by comparing the filter with the test names or running that command. Fix the filter or run the entire file and require executed tests. Earlier full-suite coverage limits the impact.

verdict: Changes requested; release N is not ready to ship.
