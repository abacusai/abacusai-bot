/**
 * Step 4 (spec 00 C.5), for the cut-over build only: it is **not** in
 * `MIGRATION_STEPS`, because the old renderer reads `transcripts/` until the
 * cut-over. Written now so its rules are tested against step 1's output
 * (C-T9). Per file, never waiting on a whole-directory condition:
 *
 * - **Archive** (a removal: the runner moves it into the step's backup
 *   directory) when the v2 twin is v1-derived and at least as new as v1, or
 *   is `agui` with `migratedFrom.updatedAt` at least as new as v1, or is
 *   `agui` without `migratedFrom` (the thread started under AG-UI; the v1
 *   file is an orphan).
 * - **Keep** a v1 file whose `agui` twin was migrated from an older v1: AG-UI
 *   owns the thread and wins, but what v1 has beyond it is not thrown away.
 * - **Quarantine** what step 1 skipped (unsafe name, corrupt, not v1): a copy
 *   goes to `backups/quarantine/transcripts/` (kept 90 days), and the source
 *   is removed into the backup directory.
 * - **Convert first** a v1 file with no qualifying twin (missing,
 *   unparseable, or stale v1-derived); it is archived on the next run. Such a
 *   plan reports `pending`, so the runner commits it without recording the
 *   step, and the next launch finishes: at most two launches.
 */
import fs from "node:fs";
import path from "node:path";

import {
  decideConversion,
  isSameOrNewer,
  v1ToThreadFile,
} from "#shared/transcript/thread-file";

import { quarantineRoot } from "../backup";
import type { MigrationStep, PlannedWrite } from "../types";
import {
  inspectTranscript,
  listTranscriptFiles,
  YIELD_EVERY,
  yieldToEventLoop,
} from "./transcript-files";

export const archiveTranscriptsV1 = (): MigrationStep => ({
  id: 4,
  name: "archive-transcripts-v1",
  plan: async (ctx) => {
    const names = listTranscriptFiles(ctx.home);
    const stats = {
      files: names.length,
      archived: 0,
      orphans: 0,
      kept: 0,
      converted: 0,
      quarantined: 0,
      unreadable: 0,
    };
    const writes: PlannedWrite[] = [];
    const removals: string[] = [];
    const stagedThreads = path.join(ctx.staging, "threads");
    const stagedQuarantine = path.join(ctx.staging, "quarantine");
    fs.mkdirSync(stagedThreads, { recursive: true });
    fs.mkdirSync(stagedQuarantine, { recursive: true });

    for (const [index, name] of names.entries()) {
      if (index > 0 && index % YIELD_EVERY === 0) {
        ctx.progress(index, names.length, "Archiving old chat history");
        await yieldToEventLoop();
      }
      const found = inspectTranscript(ctx.home, name);

      if (found.status !== "ok") {
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(found.file);
        } catch {
          // Nothing can be copied; left where it is, and listed.
          stats.unreadable += 1;
          ctx.log(`cannot read ${name}; left in place`);
          continue;
        }
        const staged = path.join(stagedQuarantine, name);
        fs.writeFileSync(staged, bytes);
        writes.push({
          dest: path.join(quarantineRoot(ctx.home), "transcripts", name),
          staged,
          kind: "create",
        });
        removals.push(found.file);
        stats.quarantined += 1;
        ctx.log(`quarantined ${name}: ${found.status}`);
        continue;
      }

      const { twin } = found;
      if (twin.status === "ok" && twin.source.kind === "agui") {
        const from = twin.source.migratedFrom;
        if (from === undefined) {
          stats.orphans += 1;
          stats.archived += 1;
          removals.push(found.file);
        } else if (isSameOrNewer(from.updatedAt, found.updatedAt)) {
          stats.archived += 1;
          removals.push(found.file);
        } else {
          stats.kept += 1;
          ctx.log(`kept ${name}: newer than the thread AG-UI took over`);
        }
        continue;
      }
      const decision = decideConversion({ updatedAt: found.updatedAt }, twin);
      if (decision.action === "skip") {
        stats.archived += 1;
        removals.push(found.file);
        continue;
      }
      const thread = v1ToThreadFile({
        threadId: found.sessionId,
        updatedAt: found.updatedAt,
        segments: found.segments,
      });
      const staged = path.join(stagedThreads, `${found.sessionId}.json`);
      fs.writeFileSync(staged, JSON.stringify(thread));
      writes.push({ dest: found.twinFile, staged, kind: decision.kind });
      stats.converted += 1;
    }
    ctx.progress(names.length, names.length, "Archiving old chat history");
    ctx.log(JSON.stringify(stats));
    return { writes, removals, stats, pending: stats.converted };
  },
});
