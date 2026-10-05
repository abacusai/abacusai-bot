/**
 * Step 4 (spec 00 C.5), for the cut-over build only: it is **not** in
 * `MIGRATION_STEPS`, because the old renderer reads `transcripts/` until the
 * cut-over. Written now so its rules are tested against step 1's output
 * (C-T9). Per file, never waiting on a whole-directory condition, and each
 * file isolated (a throw is counted as `failed`, the walk goes on):
 *
 * - **Archive** (a removal: the runner moves it into the step's backup
 *   directory) when the v2 twin is v1-derived from these bytes
 *   (fingerprint), or is `agui` with `migratedFrom.updatedAt` at least as new
 *   as v1, or is `agui` without `migratedFrom` (the thread started under
 *   AG-UI; the v1 file is an orphan).
 * - **Archive cleared history**: a v1 file whose clear marker holds its
 *   bytes, with its twin unless the twin was written after the clear.
 * - **Keep** a v1 file whose `agui` twin was migrated from an older v1: AG-UI
 *   owns the thread and wins, but what v1 has beyond it is not thrown away.
 *   Keep one whose twin is a newer build's or cannot be read, and one that
 *   cannot be read itself or is over the size cap: none is proof of anything,
 *   so none is quarantined (quarantine is pruned after 90 days).
 * - **Quarantine** what step 1 skipped (unsafe name, corrupt, not v1): a copy
 *   goes to `backups/quarantine/transcripts/` (kept 90 days), and the source
 *   is removed into the backup directory.
 * - **Convert first** a v1 file with no qualifying twin (missing,
 *   unparseable, or stale v1-derived); it is archived on the next run. Such a
 *   plan reports `pending`, so the runner commits it without recording the
 *   step, and the next launch finishes: at most two launches.
 * - **Orphaned twins**: a v1-derived twin with no v1 file at all (left by a
 *   crash mid-clear, a failed v2 removal, or a session deleted by an older
 *   build) is archived. Until now `ai.hydrate` treated such a twin as
 *   cleared because its v1 file was gone; once v1 files are archived that
 *   rule goes, and this keeps cleared history from coming back.
 */
import fs from "node:fs";
import path from "node:path";

import {
  decideConversion,
  isSameOrNewer,
  v1ToThreadFile,
} from "#shared/transcript/thread-file";

import {
  ARCHIVE_INDEX_NAME,
  isSafeSessionId,
  readArchiveIndexStrict,
  type ArchiveIndex,
} from "../../services/session/thread-store";
import { quarantineRoot } from "../backup";
import type { MigrationStep, PlannedWrite } from "../types";
import {
  inspectTranscript,
  isClearedV1,
  listThreadFiles,
  listTranscriptFiles,
  readTwinSummary,
  threadsDir,
  v1PathIsAbsent,
  YIELD_EVERY,
  yieldToEventLoop,
} from "./transcript-files";

export const archiveTranscriptsV1 = (
  options: { maxBytes?: number } = {}
): MigrationStep => ({
  id: 4,
  name: "archive-transcripts-v1",
  plan: async (ctx) => {
    const names = listTranscriptFiles(ctx.home);
    const threadNames = listThreadFiles(ctx.home);
    const stats = {
      files: names.length,
      archived: 0,
      orphans: 0,
      cleared: 0,
      orphanTwins: 0,
      kept: 0,
      converted: 0,
      quarantined: 0,
      unreadable: 0,
      tooLarge: 0,
      vanished: 0,
      failed: 0,
    };
    const writes: PlannedWrite[] = [];
    const removals: string[] = [];
    const stagedThreads = path.join(ctx.staging, "threads");
    const stagedQuarantine = path.join(ctx.staging, "quarantine");
    fs.mkdirSync(stagedThreads, { recursive: true });
    fs.mkdirSync(stagedQuarantine, { recursive: true });
    // What earlier commits of this step archived, and what this one adds:
    // committed with the removals, so a later run (or the transition thread
    // store) tells a twin whose v1 this step archived from an orphan.
    // Throws (the plan fails, nothing is removed) unless absent or valid.
    const index = readArchiveIndexStrict(threadsDir(ctx.home));
    const added: ArchiveIndex["archived"] = {};
    const total = names.length + threadNames.length;
    const label = "Archiving old chat history";
    let done = 0;
    const tick = async () => {
      done += 1;
      if (done % YIELD_EVERY === 0) {
        ctx.progress(done, total, label);
        await yieldToEventLoop();
      }
    };

    for (const name of names) {
      await tick();
      try {
        const found = inspectTranscript(ctx.home, name, options.maxBytes);

        if (
          found.status === "unreadable" ||
          found.status === "tooLarge" ||
          found.status === "vanished"
        ) {
          stats[found.status] += 1;
          ctx.log(`${name}: ${found.status}; left in place`);
          continue;
        }

        if (found.status !== "ok") {
          const staged = path.join(stagedQuarantine, name);
          fs.copyFileSync(found.file, staged);
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
        if (isClearedV1(found)) {
          stats.cleared += 1;
          stats.archived += 1;
          removals.push(found.file);
          const postClear =
            twin.status === "ok" &&
            twin.source.afterClear === found.marker?.token;
          if (twin.status !== "missing" && !postClear)
            removals.push(found.twinFile);
          continue;
        }
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
        const decision = decideConversion(found, twin);
        if (decision.action === "skip") {
          if (decision.reason === "up-to-date") {
            stats.archived += 1;
            removals.push(found.file);
            added[found.sessionId] = {
              fingerprint: found.fingerprint,
              updatedAt: found.updatedAt,
            };
          } else {
            stats.kept += 1;
            ctx.log(`kept ${name}: its thread file is ${decision.reason}`);
          }
          continue;
        }
        const token = found.marker?.token;
        const staged = path.join(stagedThreads, `${found.sessionId}.json`);
        fs.writeFileSync(
          staged,
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
        writes.push({ dest: found.twinFile, staged, kind: decision.kind });
        stats.converted += 1;
      } catch (error) {
        stats.failed += 1;
        ctx.log(`failed ${name}: ${String(error)}`);
      }
    }

    const withV1 = new Set(names);
    for (const name of threadNames) {
      await tick();
      try {
        const sessionId = name.slice(0, -".json".length);
        if (
          withV1.has(name) ||
          !isSafeSessionId(sessionId) ||
          index.archived[sessionId] !== undefined ||
          added[sessionId] !== undefined
        )
          continue;
        // Nothing at all at the v1 path, not even a folder or a link.
        if (!v1PathIsAbsent(ctx.home, sessionId)) continue;
        const twinFile = path.join(threadsDir(ctx.home), name);
        const twin = readTwinSummary(twinFile);
        if (twin.status === "ok" && twin.source.kind === "transcript-v1") {
          stats.orphanTwins += 1;
          removals.push(twinFile);
          ctx.log(`archived ${name}: v1-derived with no v1 file`);
        }
      } catch (error) {
        stats.failed += 1;
        ctx.log(`failed ${name}: ${String(error)}`);
      }
    }

    if (Object.keys(added).length > 0) {
      const dest = path.join(threadsDir(ctx.home), ARCHIVE_INDEX_NAME);
      const staged = path.join(ctx.staging, ARCHIVE_INDEX_NAME);
      const next: ArchiveIndex = {
        version: 1,
        archived: { ...index.archived, ...added },
      };
      fs.writeFileSync(staged, JSON.stringify(next));
      writes.push({
        dest,
        staged,
        kind: fs.existsSync(dest) ? "replace-user" : "create",
      });
    }

    ctx.progress(total, total, label);
    ctx.log(JSON.stringify(stats));
    return { writes, removals, stats, pending: stats.converted };
  },
});
