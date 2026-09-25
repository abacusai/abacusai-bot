// Parses CHANGELOG.md (written by scripts/sync-changelog.js) into one section
// per release for the "What's new" page. Bundled as text so it works offline.

export interface ChangelogRelease {
  version: string;
  /** ISO date, or null when the heading carried none. */
  date: string | null;
  body: string;
}

const HEADING = /^## (\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/u;

export const parseChangelog = (markdown: string): ChangelogRelease[] => {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  const lines: string[] = [];
  const flush = (): void => {
    if (current == null) return;
    current.body = lines.join("\n").trim();
    releases.push(current);
    lines.length = 0;
  };
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = HEADING.exec(line);
    if (heading != null) {
      flush();
      current = { version: heading[1]!, date: heading[2] ?? null, body: "" };
      continue;
    }
    if (current != null) lines.push(line);
  }
  flush();
  return releases;
};
