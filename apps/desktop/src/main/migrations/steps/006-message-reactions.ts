/** Upgrade v2 thread records without changing prompts or taking ownership of future files. */
import fs from "node:fs";
import path from "node:path";

import { parseThreadTwin } from "@abacus-ai/contract/transcript/thread-file";

import {
  MAX_TRANSCRIPT_BYTES,
  isSafeSessionId,
} from "../../services/session/thread-store";
import type { MigrationStep, PlannedWrite } from "../types";
import { YIELD_EVERY, yieldToEventLoop } from "./transcript-files";

export const messageReactions = (): MigrationStep => ({
  id: 6,
  name: "message-reactions",
  plan: async (ctx) => {
    const dir = path.join(ctx.home, "threads");
    const writes: PlannedWrite[] = [];
    const stats = { upgraded: 0, skipped: 0, failed: 0 };
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { writes, removals: [], stats };
      throw error;
    }
    for (const [index, entry] of names.entries()) {
      if (index > 0 && index % YIELD_EVERY === 0) await yieldToEventLoop();
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json") ||
        !isSafeSessionId(entry.name.slice(0, -5))
      )
        continue;
      const dest = path.join(dir, entry.name);
      try {
        if (fs.statSync(dest).size > MAX_TRANSCRIPT_BYTES) {
          stats.skipped++;
          continue;
        }
        const text = fs.readFileSync(dest, "utf8");
        const raw = JSON.parse(text) as { version?: unknown };
        const parsed = parseThreadTwin(text);
        if (raw?.version !== 2 || parsed.status !== "ok") {
          stats.skipped++;
          continue;
        }
        const staged = path.join(ctx.staging, "threads", entry.name);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, JSON.stringify(parsed.file));
        writes.push({ dest, staged, kind: "replace-user" });
        stats.upgraded++;
      } catch (error) {
        stats.failed++;
        ctx.log(`message reactions migration: ${entry.name}: ${String(error)}`);
      }
    }
    return {
      writes,
      removals: [],
      stats,
      ...(stats.failed > 0 && { pending: stats.failed }),
    };
  },
});
