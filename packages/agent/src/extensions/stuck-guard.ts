/**
 * Stuck guard: what a model needs when a fix keeps not working.
 *
 * Across turns, the user saying the last change did not work (after a turn that
 * changed something) is one more attempt at the same problem:
 * - 2nd attempt: step back before editing (re-read what actually runs, list
 *   what was tried, causes, one check that tells them apart);
 * - 3rd: no edit until a check has run this turn;
 * - 4th: edits are off for the turn and the reply is an honest account.
 * Within a turn, the same error three times or one file changed six times gets
 * the step-back note once each. A change that would drop many existing lines
 * the user never asked to remove is refused once; sending it again goes through.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { abacusV1BaseUrl } from "../abacus-endpoint.js";
import { TURN_END_JUDGE_MODEL } from "../promised-work.js";
import { ownWords } from "../user-text.js";

export const STUCK_GUARD_TYPE = "abacusai-bot-stuck-guard";

const EDIT_TOOLS = new Set(["edit", "batch_edit", "write", "ast_edit"]);
const CHECK_TOOLS = new Set([
  "read",
  "batch_file_read",
  "bash",
  "grep",
  "glob",
  "ls",
  "code_map",
]);

const DELETE_LINES_FLOOR = 40;
const DELETE_SHARE_FLOOR = 0.3;
const SAME_ERROR_LIMIT = 3;
const SAME_FILE_EDIT_LIMIT = 6;
const JUDGE_TIMEOUT_MS = 3_000;
const JUDGE_ASK_CHARS = 600;
const JUDGE_REPLY_CHARS = 600;

/** The user asked to remove or rewrite something: a big deletion is the task. */
const ASKED_TO_REMOVE =
  /(remove|delete|drop|strip|rewrite|replace (all|everything)|start over|from scratch|clean ?up|tira|retira|apaga|remov|elimin|borra|quita|\bsil|kaldır|entfern|lösch|supprim|usuń|smaž|odstraň|удал|видал)/iu;

export const STEP_BACK_NOTE = [
  "This message comes from the app, not the user. The user says your last change did not fix it, so do not make the same kind of change again. Before you edit anything:",
  "1. Re-read the files you changed and the code path that actually runs for what the user sees (the entry point, build output, cache, the other copy of the file).",
  "2. In one line each: what you changed so far, and why it did not work.",
  "3. Name 2-3 different causes, including 'my change never reaches what runs'.",
  "4. Run one check that tells them apart (print, log, run the user's command). Then make the smallest change for the cause it points to.",
  "Do not say it is fixed unless you ran it and saw it work. Otherwise say what you changed and what the user should look for.",
].join("\n");

export const CHECK_FIRST_NOTE = [
  "Third attempt at the same problem: edits are refused until you have run a check this turn that shows the cause (read what actually runs, run a command, add a log line).",
  STEP_BACK_NOTE,
].join("\n");

export const STOP_NOTE = [
  "This message comes from the app, not the user. Several attempts at this problem have not worked, so edits are off for this reply.",
  "Answer the user in their language, plainly and briefly:",
  "- what you tried, one line per attempt, and what each showed;",
  "- what you now think the cause is, and how sure you are;",
  "- what you still do not know, and one thing they can check or send (a screenshot, a log, the exact steps);",
  "- that you can try a different approach next if they want.",
  "Do not claim anything is fixed. Do not apologise at length.",
].join("\n");

const nonEmptyLines = (text: string): string[] =>
  text.split(/\r?\n/).filter((line) => line.trim().length > 0);

/** Lines of `before` missing from `after`, matched by content so moves do not count. */
export const droppedLines = (before: string, after: string): string[] => {
  const left = new Map<string, number>();
  for (const line of nonEmptyLines(after))
    left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1);
  const dropped: string[] = [];
  for (const line of nonEmptyLines(before)) {
    const count = left.get(line.trim()) ?? 0;
    if (count > 0) left.set(line.trim(), count - 1);
    else dropped.push(line);
  }
  return dropped;
};

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((part) => (part as { text?: unknown }).text)
        .filter((text): text is string => typeof text === "string")
        .join("\n")
    : String(content ?? "");

/** The error's last two lines, numbers masked: the same failure with another line number matches. */
export const errorFingerprint = (content: unknown): string =>
  textOf(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-2)
    .join(" | ")
    .replace(/\d+/g, "#")
    .slice(0, 200);

export type StuckStage = "none" | "step_back" | "check_first" | "stop";

export const stageFor = (attempts: number): StuckStage =>
  attempts >= 4
    ? "stop"
    : attempts === 3
      ? "check_first"
      : attempts === 2
        ? "step_back"
        : "none";

const noteFor = (stage: StuckStage): string | null =>
  stage === "stop"
    ? STOP_NOTE
    : stage === "check_first"
      ? CHECK_FIRST_NOTE
      : stage === "step_back"
        ? STEP_BACK_NOTE
        : null;

const judgePrompt = (ask: string, reply: string): string =>
  [
    "An assistant just changed files or ran commands for the user. Its last message ended:",
    "<<<",
    reply.replace(/<<<|>>>/g, "").slice(-JUDGE_REPLY_CHARS),
    ">>>",
    "The user then wrote:",
    "<<<",
    ask.replace(/<<<|>>>/g, "").slice(0, JUDGE_ASK_CHARS),
    ">>>",
    "Answer A if the user says it did not work, nothing changed, it got worse, or something broke or disappeared. Answer B for anything else (a new request, a question, more changes, thanks, continue). One letter only.",
  ].join("\n");

/** One-letter call: does this message say the last change did not work? Fails to "no". */
export async function judgeComplaint(
  ask: string,
  reply: string,
  apiKey: string = (process.env.ABACUS_API_KEY ?? "").trim(),
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (apiKey.length === 0 || ask.trim().length === 0) return false;
  try {
    const response = await fetchImpl(`${abacusV1BaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TURN_END_JUDGE_MODEL,
        messages: [{ role: "user", content: judgePrompt(ask, reply) }],
        max_tokens: 3,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const answer = body.choices?.[0]?.message?.content;
    return typeof answer === "string" && /^\W*A\W*$/i.test(answer);
  } catch {
    return false;
  }
}

const lastAssistantText = (messages: unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const text = textOf(message.content).trim();
    if (text.length > 0) return text;
  }
  return "";
};

export function createStuckGuard(
  judge: typeof judgeComplaint = judgeComplaint
) {
  return function stuckGuard(pi: ExtensionAPI) {
    // Across turns.
    let attempts = 0;
    let lastRanWork = false;
    let lastReply = "";
    // This run.
    let stage: StuckStage = "none";
    let pending: Promise<void> | null = null;
    let running = false;
    let ask = "";
    let ranWork = false;
    let checked = false;
    const errors = new Map<string, number>();
    const editsByFile = new Map<string, number>();
    const noted = new Set<string>();
    const created = new Set<string>();
    const confirmedDeletes = new Set<string>();

    const enter = (next: number): StuckStage => {
      attempts = next;
      stage = stageFor(attempts);
      return stage;
    };

    pi.on("before_agent_start", async (event) => {
      ask = ownWords(event.prompt ?? "");
      running = true;
      ranWork = false;
      checked = false;
      stage = "none";
      errors.clear();
      editsByFile.clear();
      noted.clear();

      if (ask.length === 0) return;
      if (!lastRanWork) {
        attempts = 0;
        return;
      }

      const judged = judge(ask, lastReply).then((complaint) => {
        enter(complaint ? Math.max(attempts, 1) + 1 : 1);
      });
      // Early in an episode the note can land a moment later as a steer; from
      // the 2nd attempt on, the edit gates need the stage before the first call.
      if (attempts < 2) {
        pending = judged.then(() => {
          const note = noteFor(stage);
          // A reply that already ended needs no note; a late one would land in the next turn.
          if (note != null && running)
            pi.sendMessage(
              {
                customType: STUCK_GUARD_TYPE,
                content: note,
                display: false,
                details: { stage, attempts },
              },
              { deliverAs: "steer" }
            );
        });
        return;
      }
      await judged;
      const note = noteFor(stage);
      if (note == null) return;
      return {
        message: {
          customType: STUCK_GUARD_TYPE,
          content: note,
          display: false,
          details: { stage, attempts },
        },
      };
    });

    pi.on("tool_call", async (event, ctx) => {
      const name = event.toolName;
      if (!EDIT_TOOLS.has(name)) {
        if (CHECK_TOOLS.has(name)) checked = true;
        return;
      }
      if (pending != null) {
        await pending;
        pending = null;
      }
      if (stage === "stop")
        return {
          block: true,
          reason:
            "Edits are off for this reply: several attempts at this have not worked. Give the user the honest account asked for above.",
        };
      if (stage === "check_first" && !checked)
        return {
          block: true,
          reason:
            "Run a check that shows the cause first (read what actually runs, run the command, add a log line). Then edit.",
        };

      const input = event.input as Record<string, unknown>;
      const file = String(input.path ?? "");
      if (file === "") return;
      const full = path.resolve(ctx.cwd, file);
      let before: string;
      try {
        before = fs.readFileSync(full, "utf8");
      } catch {
        if (name === "write") created.add(full);
        return;
      }
      if (created.has(full) || ASKED_TO_REMOVE.test(ask)) return;
      let dropped: string[] = [];
      if (name === "write")
        dropped = droppedLines(before, String(input.content ?? ""));
      else if (name === "edit")
        dropped = droppedLines(
          String(input.oldText ?? ""),
          String(input.newText ?? "")
        );
      else if (name === "batch_edit" && Array.isArray(input.edits))
        dropped = (input.edits as Record<string, unknown>[]).flatMap((one) =>
          droppedLines(String(one.oldText ?? ""), String(one.newText ?? ""))
        );
      const total = nonEmptyLines(before).length;
      if (
        dropped.length < DELETE_LINES_FLOOR ||
        dropped.length / Math.max(total, 1) < DELETE_SHARE_FLOOR
      )
        return;
      const key = `${name}:${full}:${JSON.stringify(input)}`;
      if (confirmedDeletes.has(key)) return;
      confirmedDeletes.add(key);
      const sample = dropped
        .slice(0, 6)
        .map((line) => `  ${line.trim().slice(0, 80)}`)
        .join("\n");
      return {
        block: true,
        reason:
          `This ${name} would remove ${dropped.length} of the ${total} lines in ${file}, and the user did not ask to remove anything. Among them:\n${sample}\n` +
          "Make only the change asked for and keep the rest. If removing them really is what the user wants, send the same call again.",
      };
    });

    pi.on("tool_result", async (event) => {
      const name = event.toolName;
      if ((EDIT_TOOLS.has(name) && !event.isError) || name === "bash")
        ranWork = true;
      let extra: string | null = null;
      if (event.isError && !EDIT_TOOLS.has(name)) {
        const print = `${name}:${errorFingerprint(event.content)}`;
        const count = (errors.get(print) ?? 0) + 1;
        errors.set(print, count);
        if (count >= SAME_ERROR_LIMIT && !noted.has(print)) {
          noted.add(print);
          extra = `The same error has come back ${count} times this turn.\n${STEP_BACK_NOTE}`;
        }
      }
      if (EDIT_TOOLS.has(name) && !event.isError) {
        const file = String(
          (event.input as Record<string, unknown>).path ?? ""
        );
        const count = (editsByFile.get(file) ?? 0) + 1;
        editsByFile.set(file, count);
        if (count >= SAME_FILE_EDIT_LIMIT && !noted.has(`file:${file}`)) {
          noted.add(`file:${file}`);
          extra = `You have changed ${file} ${count} times this turn and it still is not working.\n${STEP_BACK_NOTE}`;
        }
      }
      if (extra == null) return;
      return {
        content: [...event.content, { type: "text" as const, text: extra }],
      };
    });

    pi.on("agent_end", async (event) => {
      running = false;
      const reply = lastAssistantText(event.messages as unknown[]);
      if (reply.length > 0) lastReply = reply;
    });

    pi.on("agent_settled", async () => {
      if (pending != null) {
        await pending;
        pending = null;
      }
      // Set once work has run: later turns that only talk (the stop's account, a
      // question) leave it, so the next "still broken" is still judged.
      if (ranWork) lastRanWork = true;
      if (stage === "stop") attempts = 1;
    });
  };
}

export default createStuckGuard();
