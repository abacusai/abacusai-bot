/**
 * The Routines area with no routine open: always the way to make one, with
 * the templates beside it. The routines themselves are in the sidebar.
 */
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { Clock3, Inbox, Sun, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { GITHUB_CONNECTOR_ID } from "#renderer/lib/build-starters";
import { AppLink } from "#renderer/lib/navigation/app-link";
import {
  CODING_COVERED_TEMPLATE_IDS,
  FORM_ROUTINE_TEMPLATES,
} from "#renderer/lib/routines/templates";
import { useAppContext } from "#renderer/lib/use-app-context";

import { RoutinesAlwaysOnCard } from "./always-on";
import {
  CodingRoutinesSection,
  useCodingRoutinesOffered,
} from "./coding-routines";
import { RoutineCreateAction } from "./create-action";

/** One hue per template, so each card reads apart; tints work in both themes. */
const TEMPLATE_HUES: Record<string, number> = {
  "morning-brief": 300,
  "inbox-triage": 160,
  "pr-digest": 250,
  "failing-tests": 30,
  "dependency-watch": 0,
  "week-in-review": 80,
};

const tint = (hue: number): CSSProperties => ({
  background: `color-mix(in oklab, oklch(0.72 0.15 ${hue}) 20%, transparent)`,
  color: `oklch(0.55 0.17 ${hue})`,
});

const Tile = ({
  icon: Icon,
  hue,
  size,
}: {
  icon: LucideIcon;
  hue: number;
  size: "lg" | "sm";
}) => (
  <span
    aria-hidden
    className={
      size === "lg"
        ? "flex size-14 shrink-0 items-center justify-center rounded-[18px]"
        : "flex size-8 shrink-0 items-center justify-center rounded-[10px]"
    }
    style={tint(hue)}
  >
    <Icon className={size === "lg" ? "size-6" : "size-4"} />
  </span>
);

/**
 * The project a coder works in, for the coding routines: the last picked one
 * that is a git repository, else any that is. Null with none open.
 */
const useCodingProject = (): {
  coder: boolean;
  workspaceId: string | null;
  name: string | null;
} => {
  const { transport } = useAppContext();
  const c = useCollections();
  const prefs = usePrefs();
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  const repos = new Set(
    (useLiveQuery(c.gitState).data ?? [])
      .filter((row) => row.gitAvailable)
      .map((row) => row.workspaceId)
  );
  const connectors = useQuery(
    transport.orpc.connectors.statuses.queryOptions({ input: {} })
  );
  const pickable = workspaces.filter(
    (w) =>
      w.status !== "deleted" &&
      (w.kind == null || w.kind === "auto") &&
      repos.has(w.id)
  );
  const project =
    pickable.find((w) => w.id === prefs.lastPickedWorkspaceId) ??
    pickable[0] ??
    null;
  return {
    coder:
      project != null ||
      connectors.data?.[GITHUB_CONNECTOR_ID]?.state === "connected",
    workspaceId: project?.id ?? null,
    name:
      project == null
        ? null
        : project.label || (project.path?.split(/[\\/]/).pop() ?? null),
  };
};

export const RoutinesLanding = () => {
  const { t } = useTranslation();
  const project = useCodingProject();
  const coding = useCodingRoutinesOffered() && project.coder;
  const templates = coding
    ? FORM_ROUTINE_TEMPLATES.filter(
        (template) => !CODING_COVERED_TEMPLATE_IDS.has(template.id)
      )
    : FORM_ROUTINE_TEMPLATES;
  return (
    <div
      className="scroll-fade-y @container size-full overflow-y-auto"
      data-testid="routines-list-body"
    >
      <div className="mx-auto flex w-full max-w-[860px] flex-col items-center gap-5 px-6 py-14">
        <div className="flex items-center gap-2">
          <Tile icon={Sun} hue={300} size="lg" />
          <Tile icon={Clock3} hue={160} size="lg" />
          <Tile icon={Inbox} hue={250} size="lg" />
        </div>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("routines.page.landingTitle")}
          </h1>
          <p className="text-muted-foreground max-w-[560px] text-sm">
            {t("routines.page.landingDescription")}
          </p>
        </div>
        <RoutineCreateAction />
        {coding && (
          <div className="mt-6 w-full">
            <CodingRoutinesSection
              workspaceId={project.workspaceId}
              projectName={project.name}
            />
          </div>
        )}
        <section className="mt-6 flex w-full flex-col gap-2">
          <h2 className="text-muted-foreground text-[13px] font-medium">
            {t(
              coding
                ? "routines.coding.everythingElse"
                : "routines.page.templatesLead"
            )}
          </h2>
          <div className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
            {templates.map((template) => (
              <AppLink
                key={template.id}
                to="/routines/new"
                search={{ template: template.id }}
                transition="none"
                data-testid={`routine-template-${template.id}`}
                className="bg-background hover:bg-accent/40 focus-visible:ring-ring/50 flex flex-col gap-2 rounded-2xl border p-4 text-start outline-none focus-visible:ring-2"
              >
                <Tile
                  icon={template.icon}
                  hue={TEMPLATE_HUES[template.id] ?? 280}
                  size="sm"
                />
                <span className="text-sm font-medium">
                  {t(`routines.templates.${template.id}.name`)}
                </span>
                <span className="text-muted-foreground text-xs leading-snug">
                  {t(`routines.templates.${template.id}.description`)}
                </span>
                {template.works != null && (
                  <span className="text-muted-foreground text-[11px]">
                    {t("routines.page.templateReads", {
                      names: template.works.join(" · "),
                    })}
                  </span>
                )}
              </AppLink>
            ))}
          </div>
        </section>
        <RoutinesAlwaysOnCard />
      </div>
    </div>
  );
};
