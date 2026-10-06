/**
 * `memory`: the phone loop's one tool for everything it keeps, following the
 * bot loop's single memory tool. One schema in every prompt instead of five,
 * and one obvious place for a cheap model to reach for. Each action's fields
 * are checked here, with an error that names what is missing.
 */
import {
  aboutYouEntries,
  FACT_MAX_CHARS,
  forgetFact,
  readNote,
  rememberFact,
  resolveLoop,
  slugify,
  sortedOpenLoops,
  trackLoop,
  writeTopicNote,
} from "./phone-memory.js";
import { formatHit, searchPhoneMemory } from "./phone-recall.js";
import {
  type PhoneToolDefinition,
  stringParam,
  toolText,
} from "./phone-tool.js";

export const PHONE_MEMORY_TOOL_NAME = "memory";

const ACTIONS = [
  "remember",
  "forget",
  "note",
  "track",
  "resolve",
  "recall",
] as const;

const RECALL_HITS = 12;
const RECALL_CHARS = 5_000;
const RECALL_HIT_CHARS = 600;

const needs = (action: string, field: string) =>
  toolText(`"${action}" needs "${field}".`, true);

const openList = (dir: string): string => {
  const open = sortedOpenLoops(dir);

  return open.length === 0
    ? "No open loops."
    : `Open loops:\n${open
        .map(
          (loop) =>
            `- [${loop.id}] ${loop.text}${loop.due != null ? ` (due ${loop.due})` : ""}`
        )
        .join("\n")}`;
};

function recall(dir: string, params: Record<string, unknown>) {
  const topic = stringParam(params.topic).trim();

  if (topic.length > 0) {
    const note = readNote(dir, slugify(topic));

    return note == null
      ? toolText(`No topic note is called "${topic}".`, true)
      : toolText(`# ${note.title}\n\n${note.body}`);
  }

  const query = stringParam(params.query).trim();

  if (query.length === 0) return needs("recall", "query");

  const hits = searchPhoneMemory(dir, query, new Date(), {
    olderLogsOnly: false,
    limit: RECALL_HITS,
  });

  if (hits.length === 0)
    return toolText(`Nothing in memory matches "${query}".`);

  const lines: string[] = [];
  let used = 0;

  for (const hit of hits) {
    const line = formatHit(hit, RECALL_HIT_CHARS);

    if (used + line.length > RECALL_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return toolText(lines.join("\n"));
}

export function buildPhoneMemoryTool(dir: string): PhoneToolDefinition {
  return {
    name: PHONE_MEMORY_TOOL_NAME,
    label: PHONE_MEMORY_TOOL_NAME,
    description: [
      "Your lasting memory; older messages get summarized away. Actions:",
      `  remember: a lasting fact about the user (fact, at most ${FACT_MAX_CHARS} chars;`,
      '            user_asked when they said "remember"; replaces: part of an outdated fact)',
      "  forget:   delete a fact (fragment)",
      "  note:     knowledge on a subject, one bullet per call (topic, text;",
      "            rewrite: true replaces the whole note)",
      "  track:    something to follow up: a promise, reminder, open question",
      "            (text; due: ISO date). Returns an id like L4",
      "  resolve:  close a loop once done (id)",
      "  recall:   search notes, logs and recent messages (query),",
      "            or read one note whole (topic)",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        fact: { type: "string" },
        user_asked: { type: "boolean" },
        replaces: { type: "string" },
        fragment: { type: "string" },
        topic: { type: "string", description: 'e.g. "Lisbon trip"' },
        text: { type: "string" },
        rewrite: { type: "boolean" },
        due: {
          type: "string",
          description: '"2026-03-14" or "2026-03-14T09:00"',
        },
        id: { type: "string", description: 'e.g. "L4"' },
        query: { type: "string", description: "A few key words" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const action = stringParam(params.action);
      const field = (name: string): string => stringParam(params[name]).trim();

      switch (action) {
        case "remember": {
          if (field("fact").length === 0) return needs(action, "fact");

          const result = await rememberFact(field("fact"), {
            userAsked: params.user_asked === true,
            replaces: field("replaces"),
          });

          return result.ok
            ? toolText(
                `${result.message}\n\nAbout you now:\n${aboutYouEntries()
                  .map((entry) => `- ${entry}`)
                  .join("\n")}`
              )
            : toolText(result.message, true);
        }

        case "forget": {
          if (field("fragment").length === 0) return needs(action, "fragment");

          const result = await forgetFact(field("fragment"));

          return toolText(result.message, !result.ok);
        }

        case "note": {
          if (field("topic").length === 0) return needs(action, "topic");
          if (field("text").length === 0) return needs(action, "text");

          const result = writeTopicNote(dir, {
            topic: field("topic"),
            text: stringParam(params.text),
            rewrite: params.rewrite === true,
          });

          return toolText(result.message, !result.ok);
        }

        case "track": {
          if (field("text").length === 0) return needs(action, "text");

          const result = trackLoop(
            dir,
            {
              text: field("text"),
              ...(field("due").length > 0 ? { due: field("due") } : {}),
            },
            new Date()
          );

          return result.ok
            ? toolText(`${result.message}\n\n${openList(dir)}`)
            : toolText(result.message, true);
        }

        case "resolve": {
          if (field("id").length === 0) return needs(action, "id");

          const result = resolveLoop(dir, field("id"), new Date());

          return toolText(`${result.message}\n\n${openList(dir)}`, !result.ok);
        }

        case "recall":
          return recall(dir, params);

        default:
          return toolText(
            `action must be one of: ${ACTIONS.join(", ")}.`,
            true
          );
      }
    },
  };
}
