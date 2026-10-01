import type { ArtifactRow } from "#shared/contract/rows";

export const artifactGalleryRows: ArtifactRow[] = [
  ["file", "Weekly briefing", "/gallery/briefing.md"],
  ["file", "Research notes", "/gallery/research.txt"],
  ["file", "Project budget", "/gallery/budget.xlsx"],
  ["file", "Presentation", "/gallery/presentation.pptx"],
  ["link", "Documentation", "https://example.com/docs"],
  ["file", "Release report", "/gallery/release.pdf"],
].map(([kind, title, location], index) => ({
  id: `gallery-artifact-${index}`,
  kind: kind as ArtifactRow["kind"],
  title: title!,
  location: location!,
  toolName: "write_file",
  workspaceId: "workspace",
  sessionId: "review-prs",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
}));

/** Performance fixture: the same card/preview implementation, 300 lazy images. */
export const artifactStressRows: ArtifactRow[] = Array.from(
  { length: 2000 },
  (_, index) => ({
    ...artifactGalleryRows[0]!,
    id: `stress-artifact-${index}`,
    title: `Artifact ${String(index).padStart(4, "0")}`,
    kind: index < 300 ? "image" : "file",
    location: `/gallery/${index < 300 ? "image.png" : "report.md"}`,
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 2000 - index)).toISOString(),
  })
);
