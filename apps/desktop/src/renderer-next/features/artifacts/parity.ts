/** Spec §2 inventory. Partial rows are explained in the implementation report. */
export const PHASE5_PARITY = [
  {
    id: "AR1",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: "Changed (PLAN rail)",
  },
  {
    id: "AR2",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity + New (sort)",
  },
  {
    id: "AR3",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity (matching changed to substring)",
  },
  {
    id: "AR4",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity",
  },
  {
    id: "AR5",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "New",
  },
  {
    id: "AR6",
    status: "retired",
    target: "features/artifacts/index.tsx",
    specStatus: "Retired (live data)",
  },
  {
    id: "AR7",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity (canvas copy)",
  },
  {
    id: "AR8",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity",
  },
  {
    id: "AR9",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: "Changed (canvas)",
  },
  {
    id: "AR10",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: "Changed (canvas: preview in Artifacts, not in the session)",
  },
  {
    id: "AR11",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: 'Changed (canvas `ArtifactsPreview`: "Open in browser")',
  },
  {
    id: "AR12",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity + New (bot and routine targets)",
  },
  {
    id: "AR13",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity",
  },
  {
    id: "AR14",
    status: "implemented",
    target: "features/artifacts/index.tsx",
    specStatus: "New",
  },
  {
    id: "AR15",
    status: "partial",
    target: "features/artifacts/index.tsx",
    specStatus: "Parity (Remove deferred)",
  },
] as const;
