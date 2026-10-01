import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DiffView } from "#renderer/components/diff-view";
import { FilePreview } from "#renderer/components/file-preview";
import { FileTreeView } from "#renderer/components/file-tree";
import { Spinner } from "#renderer/components/spinner";
import { repaint } from "#renderer/components/terminal/ghostty";
import { Button } from "#renderer/ui/button";

import { SessionContextTray } from "../context/context-tray";
import { useSession } from "../data/queries";
import { DeviceTab } from "../device/device-tab";
import { SessionIdentity } from "../sessions-pages";
import { SessionsSidebar } from "../sessions-sidebar";
import {
  getTerminalView,
  disposeTerminalView,
} from "../terminal/terminal-registry";
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
const TerminalGallery = () => {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  useEffect(() => {
    let live = true;
    void getTerminalView("gallery:terminal")
      .then((view) => {
        if (!live || !target.current) return;
        target.current.append(view.element);
        view.fit.fit();
        view.term.write(
          "$ git status\r\nOn branch sessions\r\nChanges not staged for commit:\r\n  modified: src/session.ts\r\n\r\n$ "
        );
        repaint(view.term);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      disposeTerminalView("gallery:terminal");
    };
  }, []);
  return (
    <div className="flex h-[480px] flex-col rounded-xl border">
      <h2 className="border-b p-2 text-sm">{t("sessions.dock.terminal")}</h2>
      {error ? <p role="alert">{error}</p> : null}
      <div ref={target} className="min-h-0 flex-1 p-3" />
    </div>
  );
};
const View = ({ fixture }: { fixture: string }) => {
  const { t } = useTranslation();
  const row = useSession("fix-sidebar-width");
  const [selected, setSelected] = useState("src/session.ts");
  if (fixture === "sessions-sidebar")
    return (
      <div className="bg-sidebar h-[600px] w-[280px]">
        <SessionsSidebar />
      </div>
    );
  if (fixture === "sessions-start")
    return (
      <div className="mx-auto flex max-w-[680px] flex-col gap-4 p-8">
        <h1 className="text-3xl font-semibold">
          {t("sessions.start.heading")}
        </h1>
        <div className="bg-card rounded-2xl border p-4">
          {t("sessions.start.placeholder")}
        </div>
        <SessionContextTray workspaceId="default" onWorkspace={() => {}} />
      </div>
    );
  if (fixture === "sessions-changes" || fixture === "sessions-dock")
    return (
      <div className="flex h-[480px] rounded-xl border">
        <aside className="w-64 shrink-0 border-r p-3">
          <h2 className="mb-4 font-semibold">{t("sessions.dock.changes")}</h2>
          <Button variant="secondary">src/session.ts +2 −1</Button>
          <Button variant="ghost">{t("sessions.changes.keepAll")}</Button>
          <Button variant="ghost">{t("sessions.changes.undoAll")}</Button>
        </aside>
        <DiffView patch={patch} />
      </div>
    );
  if (fixture === "sessions-missing")
    return (
      <div role="status" className="bg-muted rounded-xl p-5">
        {t("sessions.missing.worktree")}
        <Button variant="outline">{t("sessions.missing.primary")}</Button>
      </div>
    );
  if (fixture === "sessions-terminal") return <TerminalGallery />;
  if (fixture === "sessions-device")
    return (
      <div className="h-[480px]">
        <DeviceTab visible />
      </div>
    );
  if (fixture === "sessions-files")
    return (
      <div className="flex h-[480px] rounded-xl border">
        <aside className="w-56 border-r p-2">
          <FileTreeView
            paths={["src/session.ts", "docs/README.md", "package.json"]}
            onSelect={setSelected}
            onOpen={setSelected}
            onRename={() => {}}
            gitStatus={[{ path: "src/session.ts", status: "modified" }]}
          />
        </aside>
        <FilePreview
          key={selected}
          path={selected}
          hostRoot="/gallery"
          read={{
            image: async () => "",
            text: async () =>
              ({
                content: selected.endsWith(".md")
                  ? "# Sessions\n\nCheckout-aware sessions."
                  : "export const checkout = { kind: 'primary' };",
                truncated: false,
                sizeBytes: 48,
              }) as never,
          }}
          onOpenExternally={() => {}}
        />
      </div>
    );
  if (fixture === "sessions-browser")
    return (
      <div className="flex h-[480px] flex-col rounded-xl border p-3">
        <h2>{t("sessions.browser.title")}</h2>
        <div role="alert" className="my-auto flex flex-col items-center gap-3">
          <p>{t("sessions.browser.unavailable")}</p>
          <Button>{t("sessions.common.retry")}</Button>
        </div>
      </div>
    );
  if (fixture === "sessions-agents")
    return (
      <div className="flex h-[480px] flex-col gap-2 rounded-xl border p-3">
        <h2>{t("sessions.dock.agents")}</h2>
        <Button variant="secondary">
          {t("sessions.gallery.researchAgent")}
        </Button>
        <Button variant="ghost">{t("sessions.gallery.testAgent")}</Button>
        <p className="text-muted-foreground text-sm">
          {t("sessions.gallery.agentDetail")}
        </p>
        <Button className="self-start">{t("sessions.agents.continue")}</Button>
      </div>
    );
  if (row) return <SessionIdentity sessionId={row.id} />;
  return <Spinner />;
};
export const isSessionsGalleryFixture = (id: string) =>
  IDS.some((value) => value === id);
export const sessionsGallerySections = { Nav, View };
