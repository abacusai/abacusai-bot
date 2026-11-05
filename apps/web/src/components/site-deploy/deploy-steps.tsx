/**
 * "Deploy your site": the three steps that move a site the agent built to
 * Abacus AI Agent on the web, which hosts and deploys it. Main zips the
 * project (sites.pack) on the person's click; this shows the steps, the zip
 * and its progress.
 * The paid welcome and the paid site card both show it.
 */
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import type {
  SitePack,
  SitePackProgress,
} from "@abacus-ai/contract/site-deploy";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  Copy,
  FileArchive,
  FolderOpen,
} from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

/** Where the steps are shown, as the funnel's detail. */
export type DeploySurface = "welcome" | "card";

/** The zip's size, in the reader's units. */
const sizeText = (bytes: number, locale: string): string => {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1
    ? new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "megabyte",
        maximumFractionDigits: 1,
      }).format(megabytes)
    : new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "kilobyte",
        maximumFractionDigits: 0,
      }).format(Math.max(1, bytes / 1024));
};

const Step = ({
  number,
  title,
  action,
  children,
}: {
  number: number;
  title: string;
  /** A button beside the title. */
  action?: ReactNode;
  children?: ReactNode;
}) => (
  <li className="flex gap-3">
    <span
      aria-hidden
      className="bg-primary text-primary-foreground mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
    >
      {number}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <p className="text-sm/6 font-medium">{title}</p>
        {action}
      </div>
      {children}
    </div>
  </li>
);

export interface DeployStepsViewProps {
  /** Nothing is zipped until the person asks. */
  idle: boolean;
  /** Null until the zip is made. */
  pack: SitePack | null;
  progress: SitePackProgress | null;
  copied: boolean;
  onOpenAgent(): void;
  onPack(): void;
  onReveal(): void;
  onDragOut(event: DragEvent<HTMLElement>): void;
  onCopy(): void;
  onCancel(): void;
  onRetry(): void;
}

/** The steps as drawn, for any state of the zip. */
export const DeployStepsView = ({
  idle,
  pack,
  progress,
  copied,
  onOpenAgent,
  onPack,
  onReveal,
  onDragOut,
  onCopy,
  onCancel,
  onRetry,
}: DeployStepsViewProps) => {
  const { t, i18n } = useTranslation();
  const list = (names: string[]) =>
    new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(names);
  const zip =
    pack == null ? (
      <div
        className="bg-muted flex items-center gap-3 rounded-[10px] px-3 py-2.5"
        data-slot="site-zip-packing"
      >
        <span className="text-muted-foreground min-w-0 flex-1 text-[13px]">
          {t("siteDeploy.packing", { count: progress?.files ?? 0 })}
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("siteDeploy.cancel")}
        </Button>
      </div>
    ) : pack.state === "ready" ? (
      <div className="flex flex-col gap-2" data-slot="site-zip-ready">
        <div
          draggable
          onDragStart={onDragOut}
          title={t("siteDeploy.dragHint")}
          className="bg-muted flex cursor-grab items-center gap-3 rounded-[10px] px-3 py-2.5 active:cursor-grabbing"
          data-slot="site-zip"
        >
          <FileArchive
            aria-hidden
            className="text-muted-foreground size-5 shrink-0"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium">
              {pack.path.split(/[\\/]/).at(-1)}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("siteDeploy.zipMeta", {
                count: pack.files,
                size: sizeText(pack.bytes, i18n.language),
              })}
            </span>
          </span>
          <Button size="sm" variant="outline" onClick={onReveal}>
            <FolderOpen aria-hidden />
            {t("siteDeploy.showInFolder")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs/5">
          {t("siteDeploy.dragHint")}
        </p>
        {pack.leftOut.length > 0 && (
          <p className="text-muted-foreground text-xs/5">
            {t("siteDeploy.leftOut", { names: list(pack.leftOut) })}
          </p>
        )}
        {pack.heldBack.length > 0 && (
          <p className="text-xs/5 text-amber-700 dark:text-amber-400">
            {t("siteDeploy.heldBack", { names: list(pack.heldBack) })}
          </p>
        )}
      </div>
    ) : (
      <div
        className="bg-muted flex items-center gap-3 rounded-[10px] px-3 py-2.5"
        data-slot="site-zip-problem"
        data-state={pack.state}
      >
        <span className="min-w-0 flex-1 text-[13px]">
          {pack.state === "too-big"
            ? t("siteDeploy.tooBig", { name: pack.name })
            : pack.state === "too-broad"
              ? t("siteDeploy.tooBroad")
              : pack.state === "none"
                ? t("siteDeploy.none")
                : pack.state === "cancelled"
                  ? t("siteDeploy.cancelled")
                  : t("siteDeploy.failed")}
        </span>
        {(pack.state === "cancelled" || pack.state === "failed") && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("siteDeploy.retry")}
          </Button>
        )}
      </div>
    );
  return (
    <ol className="flex flex-col gap-4" data-slot="deploy-steps">
      <Step
        number={1}
        title={t("siteDeploy.stepOpen")}
        action={
          <Button size="sm" data-step="open-agent" onClick={onOpenAgent}>
            {t("siteDeploy.openAgent")}
            <ArrowUpRight aria-hidden />
          </Button>
        }
      />
      <Step
        number={2}
        title={t(
          idle
            ? "siteDeploy.stepPack"
            : pack == null || pack.state === "ready"
              ? "siteDeploy.stepZip"
              : "siteDeploy.stepZipBlocked"
        )}
        action={
          idle ? (
            <Button size="sm" data-step="pack" onClick={onPack}>
              {t("siteDeploy.pack")}
            </Button>
          ) : null
        }
      >
        {idle ? null : zip}
      </Step>
      <Step
        number={3}
        title={t("siteDeploy.stepUpload")}
        action={
          <Button
            size="sm"
            variant="secondary"
            data-step="copy"
            onClick={onCopy}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {t(copied ? "siteDeploy.copied" : "siteDeploy.copy")}
          </Button>
        }
      >
        <p className="text-muted-foreground rounded-[10px] border border-dashed px-3 py-2 text-xs/5">
          {t("siteDeploy.prompt")}
        </p>
      </Step>
    </ol>
  );
};

/**
 * The steps for `sessionId`'s latest site (`turnId`): the zip is made on the
 * person's click, once per site turn, and every button reports its step.
 */
export const DeploySteps = ({
  sessionId,
  turnId,
  surface,
}: {
  sessionId: string;
  turnId: string;
  surface: DeploySurface;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const client = transport.client;
  const [asked, setAsked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const packId = `${sessionId}:${turnId}:${attempt}`;
  const pack = useQuery({
    queryKey: ["site-pack", packId],
    queryFn: () =>
      client.sites
        .pack({ sessionId, packId })
        .catch((): SitePack => ({ state: "failed" })),
    enabled: asked,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  // Asked on an earlier showing, the zip or its run is still here.
  const idle = !asked && pack.data == null && !pack.isFetching;
  const packing = !idle && pack.data == null;
  const progress = useQuery({
    queryKey: ["site-pack-progress", packId],
    queryFn: () => client.sites.progress({ packId }).catch(() => null),
    enabled: packing,
    refetchInterval: packing ? 400 : false,
  });
  const funnel = (step: FunnelStep) =>
    void client.system.funnelStep({ step, detail: surface }).catch(() => {});
  const ready = pack.data?.state === "ready" ? pack.data : null;
  return (
    <DeployStepsView
      idle={idle}
      pack={pack.data ?? null}
      progress={progress.data ?? null}
      copied={copied}
      onOpenAgent={() => {
        funnel("site_deploy_open_agent");
        void platformSystem(client).openExternal({ url: ABACUS_AGENT_URL });
      }}
      onPack={() => {
        funnel("site_deploy_pack");
        setAsked(true);
      }}
      onReveal={() => {
        if (ready == null) return;
        funnel("site_deploy_show_folder");
        void client.system
          .showItemInFolder({ path: ready.path })
          .catch(() => {});
      }}
      onDragOut={(event) => {
        if (ready == null) return;
        // Main starts the native drag, so the file lands as a file wherever it is dropped.
        event.preventDefault();
        funnel("site_deploy_drag");
        void client.sites.startDrag({ path: ready.path }).catch(() => {});
      }}
      onCopy={() => {
        funnel("site_deploy_copy");
        void navigator.clipboard
          .writeText(t("siteDeploy.prompt"))
          .then(() => setCopied(true))
          .catch(() => {});
      }}
      onCancel={() => {
        funnel("site_deploy_cancel");
        void client.sites.cancel({ packId }).catch(() => {});
      }}
      onRetry={() => {
        funnel("site_deploy_retry");
        setAsked(true);
        setAttempt((value) => value + 1);
      }}
    />
  );
};
