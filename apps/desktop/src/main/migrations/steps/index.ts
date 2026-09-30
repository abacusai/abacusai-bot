/**
 * The registered steps, by id (spec 00 C.2, C.5). Ids are never reused or
 * renumbered:
 * - 1 `transcripts-v2`: transcripts v1 → `threads/<id>.json` (C.3).
 * - 2 `prefs-from-renderer-state` (C.4).
 * - 3 `final-legacy-prefs-import-and-drop`, 4 `archive-transcripts-v1`:
 *   reserved for the cut-over build (C.5). Step 4 is written
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
