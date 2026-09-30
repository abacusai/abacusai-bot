/**
 * The registered steps, by id (spec 00 C.2, C.5). Ids are never reused or
 * renumbered:
 * - 1 `transcripts-v2`: transcripts v1 → `threads/<id>.json` (C.3). Not
 *   registered yet; it lands with the v1 → UIMessage mapper and thread store.
 * - 2 `prefs-from-renderer-state` (C.4).
 * - 3 `final-legacy-prefs-import-and-drop`, 4 `archive-transcripts-v1`:
 *   reserved for the cut-over build (C.5).
 */
import type { MigrationStep } from "../types";
import { prefsFromRendererState } from "./002-prefs-from-renderer-state";

export const MIGRATION_STEPS: readonly MigrationStep[] = [
  prefsFromRendererState(),
];
