/**
 * Step 1 (spec 00 C.2, C.3): every v1 transcript
 * (`~/.abacusai-bot/transcripts/<id>.json`) into its v2 thread file
 * (`~/.abacusai-bot/threads/<id>.json`, UIMessage JSON), through the pure
 * mapper in `shared/transcript/`.
 *
 * Per file, streamed (one file in memory at a time, yielding every
 * `YIELD_EVERY` files), and isolated: a file that throws (a staging write
 * failing with ENOSPC, a string too long) is counted as `failed` and the
 * walk goes on, so one file never fails the step or blocks later steps.
 * - no twin → converted, written as `create`;
 * - a v1-derived twin from other v1 bytes (fingerprint) → `replace-derived`
 *   (regenerable from the untouched v1);
 * - an unparseable twin → `replace-user` (backed up: nothing proves it was
 *   derived);
 * - a current v1-derived twin, an `agui` twin, a newer build's twin or one
 *   that cannot be read → left alone;
 * - a v1 file the conversation was cleared from (its clear marker holds
 *   these bytes) → left alone;
 * - an unsafe name, an unparseable file or a non-v1 file → skipped and
 *   counted; step 4 quarantines them at the cut-over;
 * - an unreadable file, or one over `MAX_TRANSCRIPT_BYTES` → kept and
 *   counted, never converted (`ai.hydrate` serves any twin it has).
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
  isClearedV1,
  listTranscriptFiles,
  YIELD_EVERY,
  yieldToEventLoop,
} from "./transcript-files";

export const transcriptsV2 = (
  options: { maxBytes?: number } = {}
): MigrationStep => ({
  id: 1,
  name: "transcripts-v2",
  plan: async (ctx) => {
    const names = listTranscriptFiles(ctx.home, { strict: false });
    const stats = {
      files: names.length,
      converted: 0,
      created: 0,
      replaced: 0,
      upToDate: 0,
      agui: 0,
      foreign: 0,
      twinUnreadable: 0,
      cleared: 0,
      skipped: 0,
      unsafe: 0,
      corrupt: 0,
      notV1: 0,
      unreadable: 0,
      tooLarge: 0,
      vanished: 0,
      failed: 0,
    };
    const writes: PlannedWrite[] = [];
    const staged = path.join(ctx.staging, "threads");
    fs.mkdirSync(staged, { recursive: true });

    for (const [index, name] of names.entries()) {
      if (index > 0 && index % YIELD_EVERY === 0) {
        ctx.progress(index, names.length, "Upgrading chat history");
        await yieldToEventLoop();
      }
      try {
        const found = inspectTranscript(ctx.home, name, options.maxBytes);
        switch (found.status) {
          case "ok":
            break;
          case "unsafe":
          case "corrupt":
          case "not-v1":
            stats.skipped += 1;
            if (found.status === "unsafe") stats.unsafe += 1;
            else if (found.status === "corrupt") stats.corrupt += 1;
            else stats.notV1 += 1;
            ctx.log(`skipped ${name}: ${found.status}`);
            continue;
          default:
            stats[found.status] += 1;
            ctx.log(`kept ${name}: ${found.status}`);
            continue;
        }
        if (isClearedV1(found)) {
          stats.cleared += 1;
          continue;
        }
        const decision = decideConversion(found, found.twin);
        if (decision.action === "skip") {
          if (decision.reason === "agui") stats.agui += 1;
          else if (decision.reason === "foreign") stats.foreign += 1;
          else if (decision.reason === "unreadable") stats.twinUnreadable += 1;
          else stats.upToDate += 1;
          continue;
        }
        const token = found.marker?.token;
        const file = path.join(staged, `${found.sessionId}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify(
            v1ToThreadFile({
              threadId: found.sessionId,
              updatedAt: found.updatedAt,
              segments: found.segments,
              fingerprint: found.fingerprint,
              ...(token !== undefined && token !== "" && { afterClear: token }),
            })
          )
        );
        writes.push({
          dest: found.twinFile,
          staged: file,
          kind: decision.kind,
        });
        stats.converted += 1;
        if (decision.kind === "create") stats.created += 1;
        else stats.replaced += 1;
      } catch (error) {
        stats.failed += 1;
        ctx.log(`failed ${name}: ${String(error)}`);
      }
    }
    ctx.progress(names.length, names.length, "Upgrading chat history");
    ctx.log(JSON.stringify(stats));
    return { writes, removals: [], stats };
  },
});
