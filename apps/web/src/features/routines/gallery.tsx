import type { GithubWatchView } from "@abacus-ai/contract/contract/github";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { CODING_ROUTINE_TEMPLATES } from "#renderer/lib/routines/templates";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { RoutinesAlwaysOnCardView } from "./always-on";
import { CodingRoutineSheet, CodingRoutinesRow } from "./coding-routines";
import { RoutinesListBody } from "./page";
import { RoutinesSidebar } from "./sidebar";
export const phase5FixtureIds = [
  "routines-sidebar",
  "routine-report",
  "artifacts-grid",
  "artifacts-stress",
  "library-connectors",
  "settings-general",
  "settings-models",
  "settings-notifications",
  "settings-keyboard",
  "sound-synthesis",
  "routines-always-on-paid",
  "routines-always-on-free",
  "routines-coding-github",
  "routines-coding-local",
  "routines-repo-watch-sheet",
  "routines-repo-watch-off-github",
] as const;
export const Phase5GalleryNav = ({
  fixture,
}: {
  fixture: string | undefined;
}) => {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-1">
      {phase5FixtureIds.map((id) => (
        <Button
          key={id}
          variant={fixture === id ? "secondary" : "ghost"}
          onClick={() =>
            void navigate({
              to: "/__ui",
              search: (old) => ({ ...old, fixture: id }),
            })
          }
        >
          {id}
        </Button>
      ))}
    </div>
  );
};
export const RoutineSidebarGallery = () => (
  <div className="flex h-[calc(100dvh-180px)] min-h-64 gap-3">
    <aside className="w-[280px]">
      <RoutinesSidebar />
    </aside>
    <RoutinesListBody />
  </div>
);

/** The Routines page's "Run around the clock" card as `plan` sees it. */
export const AlwaysOnGallery = ({ plan }: { plan: "free" | "paid" }) => (
  <div className="max-w-xl p-6">
    <RoutinesAlwaysOnCardView plan={plan} onDismiss={() => undefined} />
  </div>
);

/** The fixture project, on GitHub or not, as the watcher's view says. */
const githubView = (onGithub: boolean): GithubWatchView => ({
  config: { on: false, repos: [], phoneFix: false },
  candidates: onGithub
    ? [
        {
          repo: "you/abacusai-bot",
          workspaceId: "abacusai-bot",
          name: "abacusai-bot",
        },
      ]
    : [],
  events: [],
  checkedAt: null,
  problem: null,
  lanes: [],
});

/** Seeds the watcher's view the coding routines read, before they render. */
const WithGithub = ({
  onGithub,
  children,
}: {
  onGithub: boolean;
  children: ReactNode;
}) => {
  const { transport } = useAppContext();
  const cache = useQueryClient();
  useState(() =>
    cache.setQueryData(
      transport.orpc.github.watch.queryKey({ input: {} }),
      githubView(onGithub)
    )
  );
  return children;
};

/** The start page's coding row for a project on GitHub, or only in git. */
export const CodingRowGallery = ({ onGithub }: { onGithub: boolean }) => (
  <WithGithub onGithub={onGithub}>
    <div className="max-w-xl p-6">
      <CodingRoutinesRow
        workspaceId="abacusai-bot"
        projectName="abacusai-bot"
      />
    </div>
  </WithGithub>
);

/** The repo watch's one-tap setup, for a project on GitHub or not. */
export const RepoWatchSheetGallery = ({ onGithub }: { onGithub: boolean }) => (
  <WithGithub onGithub={onGithub}>
    <CodingRoutineSheet
      template={CODING_ROUTINE_TEMPLATES.find(
        (template) => template.id === "repo-watch"
      )!}
      workspaceId="abacusai-bot"
      surface="start"
      onClose={() => undefined}
    />
  </WithGithub>
);
