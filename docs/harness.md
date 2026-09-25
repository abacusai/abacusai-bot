# Agent harness

AbacusAI Bot uses pi for model streaming, tool dispatch, and session state. The
project adds deterministic checks around that loop.

| Layer | Behavior |
| --- | --- |
| Guardrails | Require a read before an edit, protect selected paths, and reject dangerous write patterns. |
| Spill | Store large tool output on disk and give the model bounded excerpts. |
| Tool deadlines | Stop a tool call from waiting forever. |
| Compaction pruning | Remove bulky old output before conversation summarization. |
| Batch tools | Read several files or apply several edits within one tool budget. |
| Edit recovery | Match small whitespace drift but reject an over-broad match. |
| Syntax checks | Parse supported files after an edit and report the failing line. |
| Output repair | Recover malformed or fenced tool calls when the intent is unambiguous. |
| Verification | Run configured checks again after code changes settle. |
| Run budgets | Limit model and tool use for one run. |

These checks reduce common agent failures. They do not prove that a change is
correct or make Bypass mode safe. Review diffs and keep project tests specific
enough to catch the failures that matter.

Set `ABACUSAI_BOT_NO_EXTENSIONS=1` when debugging the harness. The agent will
keep the permission gate and skip the other extensions for that process.
