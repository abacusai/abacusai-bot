import { useNavigate } from "@tanstack/react-router";

import { DiffView } from "#next/components/diff-view";
import { Button } from "#next/ui/button";

import { SessionContextTray } from "../context/context-tray";
import { SessionsSidebar } from "../sessions-sidebar";
const IDS = [
  "sessions-sidebar",
  "sessions-start",
  "sessions-dock",
  "sessions-changes",
  "sessions-files",
  "sessions-browser",
  "sessions-terminal",
  "sessions-agents",
  "sessions-device",
  "sessions-missing",
] as const;
const Nav = ({ fixture }: { fixture: string | undefined }) => {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-1">
      {IDS.map((id) => (
        <Button
          key={id}
          variant={id === fixture ? "secondary" : "ghost"}
          onClick={() =>
            void navigate({
              to: "/__ui",
              search: (p: Record<string, unknown>) => ({ ...p, fixture: id }),
            } as never)
          }
        >
          {id}
        </Button>
      ))}
    </div>
  );
};
const patch =
  "--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1,3 +1,4 @@\n export const openSession = () => {\n-  return null;\n+  const checkout = resolveCheckout();\n+  return checkout;\n };\n";
const View = ({ fixture }: { fixture: string }) => {
  if (fixture === "sessions-sidebar")
    return (
      <div className="bg-sidebar h-[600px] w-[280px]">
        <SessionsSidebar />
      </div>
    );
  if (fixture === "sessions-start")
    return (
      <div className="mx-auto flex max-w-[680px] flex-col gap-4 p-8">
        <h1 className="text-3xl font-semibold">What should we build?</h1>
        <div className="bg-card rounded-2xl border p-4">
          Tell the agent what to do…
        </div>
        <SessionContextTray workspaceId="default" onWorkspace={() => {}} />
      </div>
    );
  if (fixture === "sessions-changes" || fixture === "sessions-dock")
    return (
      <div className="flex h-[480px] rounded-xl border">
        <aside className="w-64 shrink-0 border-r p-3">
          <h2 className="mb-4 font-semibold">Changes</h2>
          <Button variant="secondary">src/session.ts +2 −1</Button>
          <Button variant="ghost">Keep all</Button>
          <Button variant="ghost">Undo all</Button>
        </aside>
        <DiffView patch={patch} />
      </div>
    );
  if (fixture === "sessions-missing")
    return (
      <div role="status" className="bg-muted rounded-xl p-5">
        The worktree folder is missing.
        <Button variant="outline">Use primary checkout</Button>
      </div>
    );
  return (
    <div className="bg-muted flex h-[480px] items-center justify-center rounded-xl border">
      <p>{fixture.slice(9)} surface — runtime fixture pending</p>
    </div>
  );
};
export const isSessionsGalleryFixture = (id: string) =>
  IDS.some((value) => value === id);
export const sessionsGallerySections = { Nav, View };
