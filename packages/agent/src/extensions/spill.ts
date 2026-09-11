import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Spill: oversized tool output (any tool, not just bash) goes to a file; the
 * model gets head + tail plus an id, and `read_output` reads any window back.
 * Files live in `<home>/spill/<pid>/`, removed at exit: a within-session
 * recovery path, not history. Written 0600 in a 0700 directory, since a
 * command's output may hold `env` or a token.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { abacusBotDir } from "../config.js";

/** Text longer than this is spilled. Roughly 7-8k tokens. */
const MAX_INLINE_CHARS = 30_000;
const HEAD_CHARS = 18_000;
const TAIL_CHARS = 6_000;

/** Cap on one read_output response, so retrieval can't undo the spill. */
const MAX_RETRIEVAL_CHARS = 20_000;
const DEFAULT_LINE_LIMIT = 200;

/**
 * How much of a line the model's grep pattern is tested against. A pattern
 * with nested quantifiers backtracks exponentially in the subject length, and
 * nothing can kill an in-process call, so bounding the subject bounds the hang.
 */
const MAX_GREP_SUBJECT_CHARS = 2_000;

/** Directory and file modes: owner-only. Tool output is not public. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface SpillRecord {
  file: string;
  toolName: string;
  totalChars: number;
  totalLines: number;
}

function spillDir(): string {
  return path.join(abacusBotDir(), "spill", String(process.pid));
}

/**
 * Module scope: the spill directory is per-process, and every sub-agent loads
 * its own copy of the extensions, so a per-instance flag adds a listener per
 * sub-agent. The sweep is deliberately not gated on this: it collects
 * directories other processes left behind, and those appear over time.
 */
let exitHookRegistered = false;

/**
 * Also module scope, so an id is one id for the whole process: a parent that
 * hands "out-1" to a sub-agent must find the sub-agent can read it. Kept per
 * instance, the sub-agent's map was empty and the id was dead on arrival.
 */
const records = new Map<string, SpillRecord>();
let counter = 0;

/** For tests: forget every saved output. */
export const resetSpillRecords = (): void => {
  records.clear();
  counter = 0;
};

export default function (pi: ExtensionAPI) {
  /** Once per extension instance — so a sub-agent session sweeps too. */
  let swept = false;

  /**
   * Remove spill directories of processes that are gone: a crash or SIGKILL
   * skips the exit hook, and the contents are the sensitive part.
   */
  const sweepAbandoned = () => {
    const root = path.join(abacusBotDir(), "spill");
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return; // Nothing spilled yet.
    }
    for (const entry of entries) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        // Signal 0 tests for existence without delivering anything.
        process.kill(pid, 0);
        continue; // Alive — another session owns it.
      } catch (error) {
        // EPERM means the pid exists but belongs to another user; leave it.
        if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
      }
      try {
        fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      } catch {
        // Best effort: a directory we cannot remove is not a reason to fail.
      }
    }
  };

  /** Best-effort: a leftover spill directory wastes disk, it does not break a run. */
  const registerCleanup = () => {
    if (!exitHookRegistered) {
      exitHookRegistered = true;
      process.once("exit", () => {
        try {
          fs.rmSync(spillDir(), { recursive: true, force: true });
        } catch {
          // Exiting anyway.
        }
      });
    }
  };

  /**
   * Write `text` to disk and return its id, or undefined if the write failed,
   * in which case the caller falls back to a lossy trim rather than failing
   * the tool call over a full disk.
   */
  const spill = (toolName: string, text: string): string | undefined => {
    const id = `out-${++counter}`;
    const dir = spillDir();
    const file = path.join(dir, `${id}.txt`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      // mkdirSync leaves an existing directory's mode alone; umask clears bits.
      fs.chmodSync(dir, DIR_MODE);
      fs.writeFileSync(file, text, { encoding: "utf8", mode: FILE_MODE });
    } catch {
      return undefined;
    }
    registerCleanup();
    if (!swept) {
      swept = true;
      sweepAbandoned();
    }
    records.set(id, {
      file,
      toolName,
      totalChars: text.length,
      totalLines: text.split("\n").length,
    });
    return id;
  };

  pi.on("tool_result", async (event) => {
    // read_output's own result is already bounded; spilling it would nest.
    if (event.toolName === "read_output") return;

    let changed = false;
    const content = event.content.map((block) => {
      if (block.type !== "text" || block.text.length <= MAX_INLINE_CHARS)
        return block;
      changed = true;

      const head = block.text.slice(0, HEAD_CHARS);
      const tail = block.text.slice(-TAIL_CHARS);
      const dropped = block.text.length - HEAD_CHARS - TAIL_CHARS;
      const id = spill(event.toolName, block.text);

      // The path is given outright. "Saved as out-1" read as a file name, and
      // a model that had just been told its working directory went looking
      // for out-1 there — and sent a sub-agent to look for it there too.
      const notice = id
        ? `… [${dropped} chars omitted. Full output saved to ${records.get(id)?.file} ` +
          `(${records.get(id)?.totalLines ?? 0} lines). Read the omitted middle with read_output ` +
          `id "${id}" plus an offset/grep, or read that file by its path with the file tools. ` +
          `"${id}" is an id, not a file in your working directory; give a sub-agent the path, ` +
          `not the id. Do NOT re-run the command.] …`
        : `… [${dropped} chars omitted and could not be saved to disk; ` +
          `re-run with a narrower filter (grep/head/tail) if you need the middle] …`;

      return { ...block, text: `${head}\n\n${notice}\n\n${tail}` };
    });

    if (changed) return { content };
  });

  pi.registerTool({
    name: "read_output",
    label: "Read Saved Output",
    description:
      "Read back a window of tool output that was too large to inline and was saved to disk. " +
      "The id comes from the omission notice in a trimmed result. Prefer grep to find the " +
      "interesting lines, then offset/limit to read around them. This is always cheaper than " +
      "re-running the command that produced the output.",
    parameters: Type.Object({
      id: Type.String({ description: 'Saved output id, e.g. "out-1"' }),
      grep: Type.Optional(
        Type.String({
          description: "Only return lines matching this regular expression",
        })
      ),
      offset: Type.Optional(
        Type.Number({ description: "1-based first line to return (default 1)" })
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Max lines to return (default ${DEFAULT_LINE_LIMIT})`,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const record = records.get(params.id);
      if (!record) {
        const known = [...records.keys()];
        return {
          content: [
            {
              type: "text",
              text:
                `No saved output with id "${params.id}". Ids come from the omission notice ` +
                `in a trimmed tool result, which also gives the file's path; if you were ` +
                `handed an id by someone else, ask for that path and read the file instead.` +
                (known.length
                  ? ` Known ids: ${known.join(", ")}.`
                  : " Nothing has been saved in this process."),
            },
          ],
          isError: true,
          details: { id: params.id, matched: 0, returned: 0 },
        };
      }

      let text: string;
      try {
        text = fs.readFileSync(record.file, "utf8");
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Saved output "${params.id}" is no longer on disk. Re-run the command that produced it.`,
            },
          ],
          isError: true,
          details: { id: params.id, matched: 0, returned: 0 },
        };
      }

      const lines = text.split("\n");
      let selected: Array<{ line: number; text: string }> = lines.map(
        (value, index) => ({
          line: index + 1,
          text: value,
        })
      );

      if (params.grep !== undefined && params.grep !== "") {
        let re: RegExp;
        try {
          re = new RegExp(params.grep);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
            details: { id: params.id, matched: 0, returned: 0 },
          };
        }
        selected = selected.filter((entry) =>
          re.test(
            entry.text.length > MAX_GREP_SUBJECT_CHARS
              ? entry.text.slice(0, MAX_GREP_SUBJECT_CHARS)
              : entry.text
          )
        );
      }

      const matched = selected.length;
      const offset = Math.max(1, params.offset ?? 1);
      const limit = Math.max(1, params.limit ?? DEFAULT_LINE_LIMIT);
      // grep narrows first; offset is a position in the result set.
      const window = selected.slice(offset - 1, offset - 1 + limit);

      let body = window
        .map((entry) => `${entry.line}\t${entry.text}`)
        .join("\n");
      let truncated = false;
      if (body.length > MAX_RETRIEVAL_CHARS) {
        body = body.slice(0, MAX_RETRIEVAL_CHARS);
        truncated = true;
      }

      const header =
        `${params.id} (${record.toolName}, ${record.totalLines} lines total)` +
        (params.grep ? ` · ${matched} lines match /${params.grep}/` : "") +
        ` · showing ${window.length} from offset ${offset}`;
      const footer = truncated
        ? "\n\n[response capped; narrow with grep or a smaller limit]"
        : offset - 1 + window.length < matched
          ? `\n\n[${matched - (offset - 1 + window.length)} more; continue at offset ${offset + window.length}]`
          : "";

      return {
        content: [{ type: "text", text: `${header}\n\n${body}${footer}` }],
        details: { id: params.id, matched, returned: window.length },
        isError: false,
      };
    },
  });
}
