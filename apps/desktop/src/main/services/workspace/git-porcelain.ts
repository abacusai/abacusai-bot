/**
 * Reading git's machine-readable output without mangling the filenames. The
 * default porcelain output quotes any unusual path (non-ASCII included) and
 * escapes bytes in octal, and renames arrive as `old -> new`, unparseable when
 * a name contains ` -> `. `-z` gives NUL-separated records with paths verbatim,
 * so both readers ask for it and the parsing below is what that costs.
 */

export interface ParsedStatusEntry {
  path: string;
  status: string;
  stagedStatus: string | null;
  unstagedStatus: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface ParsedNumstatEntry {
  path: string;
  additions: number | null;
  deletions: number | null;
}

/**
 * `git status --porcelain -uall -z`: `XY <path>` records. A rename or copy is
 * followed by a second record with the origin path, consumed and dropped.
 */
export function parseStatusZ(stdout: string): ParsedStatusEntry[] {
  const fields = stdout.split("\0");
  const entries: ParsedStatusEntry[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    // "XY p" is the shortest real record; anything shorter is the trailing
    // empty field left by the final NUL.
    if (record == null || record.length < 4) continue;

    const stagedCode = record[0] ?? " ";
    const unstagedCode = record[1] ?? " ";
    const path = record.slice(3);

    // Step over the origin path or it reads as a change of its own.
    if (
      stagedCode === "R" ||
      stagedCode === "C" ||
      unstagedCode === "R" ||
      unstagedCode === "C"
    ) {
      i += 1;
    }

    if (path.length === 0) continue;

    const isUntracked = stagedCode === "?" && unstagedCode === "?";

    entries.push({
      path,
      status: `${stagedCode}${unstagedCode}`.trim() || "?",
      stagedStatus: isUntracked
        ? null
        : stagedCode.trim().length > 0
          ? stagedCode
          : null,
      unstagedStatus:
        unstagedCode.trim().length > 0
          ? unstagedCode
          : isUntracked
            ? "?"
            : null,
      additions: null,
      deletions: null,
    });
  }

  return entries;
}

/**
 * `git diff --numstat -z`: `additions\tdeletions\tpath` records. A rename writes
 * an empty path then old and new paths, so the count belongs two fields on.
 * `-` means binary and stays null rather than a misleading zero.
 */
export function parseNumstatZ(stdout: string): ParsedNumstatEntry[] {
  const fields = stdout.split("\0");
  const entries: ParsedNumstatEntry[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record == null || record.length === 0) continue;

    const parts = record.split("\t");
    if (parts.length < 3) continue;

    const [rawAdditions, rawDeletions] = parts;
    let path = parts.slice(2).join("\t");

    if (path.length === 0) {
      // Rename: <old> then <new>. The entry is the file's new home.
      path = fields[i + 2] ?? "";
      i += 2;
    }

    if (path.length === 0) continue;

    entries.push({
      path,
      additions: parseCount(rawAdditions),
      deletions: parseCount(rawDeletions),
    });
  }

  return entries;
}

const parseCount = (raw: string | undefined): number | null => {
  if (raw == null || raw === "-") return null;

  const value = Number(raw);

  return Number.isFinite(value) ? value : null;
};
