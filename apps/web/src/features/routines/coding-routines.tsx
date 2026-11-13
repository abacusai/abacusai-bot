/**
 * Coding routines: offered beside a code project (the session start page,
 * the Routines landing) and set up in one tap. The project, a time and the
 * user's phone are filled in; Start makes the routine and its first run.
 */
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  SELF_LANE_FOR_APP,
  type MessagingSnapshot,
  type SelfLanePlatform,
} from "@abacus-ai/contract/messaging";
import { routineOfferClosed } from "@abacus-ai/contract/next-step";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Clock, Smartphone } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { SendError } from "#renderer/components/send-error";
import { useCollections } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { isRpcError } from "#renderer/data/query-client";
import type { AppClient } from "#renderer/data/transport/types";
import { composeSchedule, DEFAULT_SCHEDULE } from "#renderer/lib/bots/schedule";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  CODING_ROUTINE_TEMPLATES,
  type RoutineTemplate,
} from "#renderer/lib/routines/templates";
import { showError } from "#renderer/lib/toast";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";
import { NativeSelect, NativeSelectOption } from "#renderer/ui/native-select";

import { AlwaysOnButton, useAlwaysOnPlan } from "./always-on";

/** Where a starter was offered, as the funnel names it. */
export type CodingRoutineSurface = "start" | "library";

/** One hue per coding routine, the landing's tint scheme. */
const CODING_HUES: Record<string, number> = {
  "nightly-tests": 30,
  "pr-review-fixes": 250,
  "site-down": 0,
  "overnight-changes": 80,
  "game-check": 160,
};

const tint = (hue: number): CSSProperties => ({
  background: `color-mix(in oklab, oklch(0.72 0.15 ${hue}) 20%, transparent)`,
  color: `oklch(0.55 0.17 ${hue})`,
});

/** The chat apps' own names: proper nouns, the same in every language. */
const LANE_NAMES: Record<SelfLanePlatform, string> = {
  whatsapp: "WhatsApp",
  abacus_telegram: "Telegram",
  abacus_discord: "Discord",
};

const SELF_LANES = new Set<string>(Object.values(SELF_LANE_FOR_APP));

/** A phone the user's own reports can reach, and the bot that answers there. */
export interface ReportLane {
  lane: SelfLanePlatform;
  botId: string;
}

/**
 * The user's own chat apps that are linked and have a bot answering: a
 * routine made as that bot's reports to its chat and to the phone.
 */
export const reportLanes = (
  snapshot: Pick<MessagingSnapshot, "platforms"> | undefined
): ReportLane[] =>
  (snapshot?.platforms ?? []).flatMap((platform) =>
    SELF_LANES.has(platform.id) &&
    (platform.state === "connected" || platform.state === "syncing") &&
    platform.homeBotId != null
      ? [{ lane: platform.id as SelfLanePlatform, botId: platform.homeBotId }]
      : []
  );

/**
 * The routine already made from `template` for this project, if one is. A
 * site watch is per site, so another one can always be added.
 */
export const existingCodingRoutine = (
  routines: readonly Pick<RoutineRow, "id" | "prompt" | "workspaceId">[],
  template: Pick<RoutineTemplate, "prompt" | "needsWorkspace" | "coding">,
  workspaceId: string | null
): string | null =>
  template.coding?.watchesSite === true
    ? null
    : (routines.find(
        (row) =>
          row.prompt === template.prompt &&
          (template.needsWorkspace !== true || row.workspaceId === workspaceId)
      )?.id ?? null);

/**
 * Starters are offered on the desktop only (routines run on this computer),
 * and not to a free account near the end of its credits: every run spends them.
 */
export const useCodingRoutinesOffered = (): boolean => {
  const account = useAccount().data;
  return (
    IS_ELECTRON &&
    !routineOfferClosed(account?.credits_used, account?.credits_granted)
  );
};

const reportStep = (client: AppClient, step: FunnelStep, detail: string) =>
  void client.system
    .funnelStep({ step, detail: detail.replaceAll("-", "_") })
    .catch(() => undefined);

const Tile = ({ template }: { template: RoutineTemplate }) => {
  const Icon = template.icon;
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-[10px]"
      style={tint(CODING_HUES[template.id] ?? 280)}
    >
      <Icon className="size-4" />
    </span>
  );
};

/** The starters' cards, with the sheet they open. */
const useCodingStarters = (surface: CodingRoutineSurface) => {
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const c = useCollections();
  const routines = useLiveQuery(c.routines).data ?? [];
  const [open, setOpen] = useState<RoutineTemplate | null>(null);
  const pick = (template: RoutineTemplate, existing: string | null) => {
    if (existing != null) {
      void navigate({
        to: "/routines/$routineId",
        params: { routineId: existing },
      });
      return;
    }
    reportStep(transport.client, "code_routine_opened", template.id);
    setOpen(template);
  };
  useEffect(() => {
    reportStep(transport.client, "code_routine_shown", surface);
  }, [transport.client, surface]);
  return { routines, open, setOpen, pick };
};

/**
 * The start page's row: the routines that keep this project healthy, under
 * the starters for the work itself.
 */
export const CodingRoutinesRow = ({
  workspaceId,
  projectName,
}: {
  workspaceId: string;
  projectName: string;
}) => {
  const { t } = useTranslation();
  const { routines, open, setOpen, pick } = useCodingStarters("start");
  return (
    <section
      aria-label={t("routines.coding.rowTitle", { project: projectName })}
      data-testid="coding-routines-row"
      className="flex flex-col gap-2"
    >
      <p className="text-foreground/75 flex items-center gap-1.5 text-xs">
        <Clock aria-hidden className="size-3.5" />
        {t("routines.coding.rowTitle", { project: projectName })}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {CODING_ROUTINE_TEMPLATES.slice(0, 4).map((template) => {
          const existing = existingCodingRoutine(
            routines,
            template,
            workspaceId
          );
          return (
            <button
              key={template.id}
              type="button"
              data-testid={`coding-routine-${template.id}`}
              onClick={() => pick(template, existing)}
              className="bg-background hover:bg-accent/40 focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-xl border p-2.5 text-start outline-none focus-visible:ring-2"
            >
              <Tile template={template} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {t(`routines.templates.${template.id}.name`)}
                </span>
                <span className="text-muted-foreground truncate text-[11px]">
                  {existing != null
                    ? t("routines.coding.alreadyOn")
                    : t(`routines.templates.${template.id}.when`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {open != null && (
        <CodingRoutineSheet
          template={open}
          workspaceId={workspaceId}
          surface="start"
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
};

/** The Routines landing's section: every coding routine, for the open project. */
export const CodingRoutinesSection = ({
  workspaceId,
  projectName,
}: {
  workspaceId: string | null;
  projectName: string | null;
}) => {
  const { t } = useTranslation();
  const { routines, open, setOpen, pick } = useCodingStarters("library");
  return (
    <section
      data-testid="coding-routines-section"
      className="flex w-full flex-col gap-2"
    >
      <h2 className="text-muted-foreground text-[13px] font-medium">
        {projectName != null
          ? t("routines.coding.sectionTitle", { project: projectName })
          : t("routines.coding.sectionTitleNoProject")}
      </h2>
      <div className="grid gap-3 @lg:grid-cols-2">
        {CODING_ROUTINE_TEMPLATES.map((template) => {
          const existing = existingCodingRoutine(
            routines,
            template,
            workspaceId
          );
          return (
            <button
              key={template.id}
              type="button"
              data-testid={`coding-routine-${template.id}`}
              onClick={() => pick(template, existing)}
              className="bg-background hover:bg-accent/40 focus-visible:ring-ring/50 flex items-start gap-3 rounded-2xl border p-4 text-start outline-none focus-visible:ring-2"
            >
              <Tile template={template} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium">
                  {t(`routines.templates.${template.id}.name`)}
                </span>
                <span className="text-muted-foreground text-xs leading-snug">
                  {t(`routines.templates.${template.id}.description`)}
                </span>
                <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                  {existing != null ? (
                    <>
                      <Check aria-hidden className="size-3" />
                      {t("routines.coding.alreadyOn")}
                    </>
                  ) : (
                    t(`routines.templates.${template.id}.when`)
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {open != null && (
        <CodingRoutineSheet
          template={open}
          workspaceId={workspaceId}
          surface="library"
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
};

/** The one-tap setup: everything filled in, Start makes it and runs it once. */
export const CodingRoutineSheet = ({
  template,
  workspaceId: offeredWorkspaceId,
  surface,
  onClose,
}: {
  template: RoutineTemplate;
  workspaceId: string | null;
  surface: CodingRoutineSurface;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const { db, transport } = useAppContext();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const c = useCollections();
  const plan = useAlwaysOnPlan();
  const workspaces = (useLiveQuery(c.workspaces).data ?? []).filter(
    (w) => w.status !== "deleted" && (w.kind == null || w.kind === "auto")
  );
  const messaging = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const lanes = reportLanes(messaging.data);
  const needsProject = template.needsWorkspace === true;
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    offeredWorkspaceId ?? prefs.lastPickedWorkspaceId ?? null
  );
  const [time, setTime] = useState(template.time);
  const [site, setSite] = useState("");
  const [siteError, setSiteError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fixedTime = template.preset === "custom";
  const watchesSite = template.coding?.watchesSite === true;

  const start = async () => {
    const url = site.trim();
    if (watchesSite && !isSiteUrl(url)) {
      setSiteError(true);
      return;
    }
    if (needsProject && workspaceId == null) return;
    setSaving(true);
    setError(null);
    const { schedule } = composeSchedule({
      ...DEFAULT_SCHEDULE,
      preset: template.preset,
      time,
      custom: template.custom ?? "",
    });
    // Made as the phone's bot, it reports to that bot's chat and the phone.
    const botId = lanes[0]?.botId ?? null;
    const insert = (id: string) =>
      db.collections.routines.insert({
        id,
        name: t(`routines.templates.${template.id}.name`),
        prompt: template.prompt,
        schedule,
        runAt: null,
        workspaceId,
        botId,
        enabled: true,
        createdAt: Date.now(),
        lastRunAt: null,
        lastResult: null,
        recentRuns: [],
        nextRunAt: null,
        webhookToken: null,
        webhookUrl: null,
        webhookPublicPending: false,
        botName: null,
        ...(watchesSite ? { uptimeUrl: withScheme(url) } : {}),
        ...(template.coding?.quietIsNormal === true
          ? { quietIsNormal: true }
          : {}),
        ...(template.coding?.githubReviews === true
          ? { githubReviews: true }
          : {}),
      }).isPersisted.promise;
    try {
      const id = await insertFresh(insert);
      reportStep(transport.client, "code_routine_started", template.id);
      void transport.client.routines
        .run({ id, trigger: "create" })
        .catch(() => showError(t("phase5.firstRunFailed")));
      onClose();
      await navigate({
        to: "/routines/$routineId",
        params: { routineId: id },
        transition: "nav-forward",
      });
    } catch {
      setError(t("phase5.saveRoutineFailed"));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="rounded-2xl p-5 sm:max-w-[520px]"
        data-testid="coding-routine-sheet"
        data-surface={surface}
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <Tile template={template} />
            <div className="flex flex-col gap-1">
              <DialogTitle>
                {t(`routines.templates.${template.id}.name`)}
              </DialogTitle>
              <DialogDescription>
                {t(`routines.templates.${template.id}.promise`)}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {error && <SendError error={error} />}
        <FieldGroup className="gap-4">
          {watchesSite && (
            <Field data-invalid={siteError || undefined}>
              <FieldLabel htmlFor="coding-routine-site">
                {t("routines.coding.siteLabel")}
              </FieldLabel>
              <Input
                id="coding-routine-site"
                type="url"
                inputMode="url"
                autoFocus
                placeholder={t("routines.coding.sitePlaceholder")}
                value={site}
                aria-invalid={siteError || undefined}
                onChange={(e) => {
                  setSite(e.target.value);
                  setSiteError(false);
                }}
              />
              {siteError && (
                <FieldError>{t("routines.coding.siteInvalid")}</FieldError>
              )}
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="coding-routine-project">
              {t("routines.coding.projectLabel")}
            </FieldLabel>
            <NativeSelect
              id="coding-routine-project"
              value={workspaceId ?? ""}
              onChange={(e) => setWorkspaceId(e.target.value || null)}
            >
              {(!needsProject || workspaceId == null) && (
                <NativeSelectOption value="">
                  {needsProject
                    ? t("routines.coding.projectPick")
                    : t("phase5.ownFolder")}
                </NativeSelectOption>
              )}
              {workspaces.map((w) => (
                <NativeSelectOption key={w.id} value={w.id}>
                  {w.label ?? w.path}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="coding-routine-time">
              {t("routines.coding.whenLabel")}
            </FieldLabel>
            {fixedTime ? (
              <p className="text-sm">
                {t(`routines.templates.${template.id}.when`)}
              </p>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <span>
                  {t(
                    template.preset === "weekdays"
                      ? "routines.coding.weekdaysAt"
                      : "routines.coding.dailyAt"
                  )}
                </span>
                <Input
                  id="coding-routine-time"
                  type="time"
                  className="w-32"
                  value={time}
                  onChange={(e) => setTime(e.target.value || template.time)}
                />
              </div>
            )}
          </Field>
          <div className="flex items-start gap-3 rounded-xl border p-3">
            <Smartphone aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 text-[13px]">
              {lanes.length > 0 ? (
                <span>
                  {t("routines.coding.reportsTo", {
                    apps: [
                      ...new Set(lanes.map((x) => LANE_NAMES[x.lane])),
                    ].join(" · "),
                  })}
                </span>
              ) : (
                <>
                  <span>{t("routines.coding.reportsHere")}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onClose();
                      void navigate({ to: "/library/messaging" });
                    }}
                  >
                    {t("routines.coding.connectPhone")}
                    <ArrowRight aria-hidden />
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="text-muted-foreground flex flex-col items-start gap-2 text-xs">
            <span>
              {t(
                watchesSite
                  ? "routines.coding.whereSite"
                  : "routines.coding.where"
              )}
            </span>
            {plan === "free" && (
              <>
                <span>{t("routines.coding.alwaysOnFree")}</span>
                <AlwaysOnButton plan={plan} variant="outline" />
              </>
            )}
          </div>
        </FieldGroup>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-muted-foreground text-xs">
            {t("routines.coding.firstRun")}
          </span>
          <Button
            data-testid="coding-routine-start"
            disabled={saving || (needsProject && workspaceId == null)}
            onClick={() => void start()}
          >
            {t("routines.coding.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Inserted under a new id, and once more under another if that one is taken. */
const insertFresh = async (
  insert: (id: string) => Promise<unknown>
): Promise<string> => {
  const id = `routine-${crypto.randomUUID()}`;
  try {
    await insert(id);
    return id;
  } catch (e) {
    if (!isRpcError(e) || e.code !== "CONFLICT") throw e;
  }
  const retry = `routine-${crypto.randomUUID()}`;
  await insert(retry);
  return retry;
};

/** A site as typed: a bare host gets https. */
const withScheme = (value: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

export const isSiteUrl = (value: string): boolean => {
  if (value.length === 0) return false;
  try {
    const url = new URL(withScheme(value));
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.includes(".")
    );
  } catch {
    return false;
  }
};
