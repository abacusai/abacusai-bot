import { useNavigate } from "@tanstack/react-router";

import { Button } from "#renderer/ui/button";

import { RoutinesAlwaysOnCardView } from "./always-on";
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
