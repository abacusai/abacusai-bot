/**
 * Step 1 (spec 00 C.2, C.3): every v1 transcript
 * (`~/.abacusai-bot/transcripts/<id>.json`) into its v2 thread file
 * (`~/.abacusai-bot/threads/<id>.json`, UIMessage JSON), through the pure
 * mapper in `shared/transcript/`.
 *
 * Per file, streamed (one file in memory at a time, yielding every
 * `YIELD_EVERY` files):
 * - no twin → converted, written as `create`;
 * - a v1-derived twin older than v1 → `replace-derived` (regenerable from the
 *   untouched v1);
 * - an unparseable twin → `replace-user` (backed up: nothing proves it was
 *   derived);
 * - a current v1-derived twin, or an `agui` twin → left alone;
 * - an unsafe name, an unparseable file or a non-v1 file → skipped and
 *   counted; step 4 quarantines them at the cut-over.
 *
 * `transcripts/` is only read: the old renderer keeps using it until the
 * cut-over, and the dual-write keeps `threads/` current after this step.
 * Idempotent: a second run finds every twin current and plans nothing.
 */
import fs from "node:fs";
import path from "node:path";

import {
  decideConversion,
  v1ToThreadFile,
} from "#shared/transcript/thread-file";

import type { MigrationStep, PlannedWrite } from "../types";
import {
  inspectTranscript,
  listTranscriptFiles,
  YIELD_EVERY,
  yieldToEventLoop,
} from "./transcript-files";

export const transcriptsV2 = (): MigrationStep => ({
  id: 1,
  name: "transcripts-v2",
  plan: async (ctx) => {
    const names = listTranscriptFiles(ctx.home);
    const stats = {
      files: names.length,
      converted: 0,
      created: 0,
      replaced: 0,
      upToDate: 0,
      agui: 0,
      skipped: 0,
      unsafe: 0,
      corrupt: 0,
      notV1: 0,
    };
    const writes: PlannedWrite[] = [];
    const staged = path.join(ctx.staging, "threads");
    fs.mkdirSync(staged, { recursive: true });

    for (const [index, name] of names.entries()) {
      if (index > 0 && index % YIELD_EVERY === 0) {
        ctx.progress(index, names.length, "Upgrading chat history");
        await yieldToEventLoop();
      }
      const found = inspectTranscript(ctx.home, name);
      if (found.status !== "ok") {
        stats.skipped += 1;
        if (found.status === "unsafe") stats.unsafe += 1;
        else if (found.status === "corrupt") stats.corrupt += 1;
        else stats.notV1 += 1;
        ctx.log(`skipped ${name}: ${found.status}`);
        continue;
      }
      const decision = decideConversion(found.updatedAt, found.twin);
      if (decision.action === "skip") {
        if (decision.reason === "agui") stats.agui += 1;
        else stats.upToDate += 1;
        continue;
      }
      const thread = v1ToThreadFile({
        threadId: found.sessionId,
        updatedAt: found.updatedAt,
        segments: found.segments,
      });
      const file = path.join(staged, `${found.sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify(thread));
      writes.push({ dest: found.twinFile, staged: file, kind: decision.kind });
      stats.converted += 1;
      if (decision.kind === "create") stats.created += 1;
      else stats.replaced += 1;
    }
    ctx.progress(names.length, names.length, "Upgrading chat history");
    ctx.log(JSON.stringify(stats));
    return { writes, removals: [], stats };
  },
});
