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
