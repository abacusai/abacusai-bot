import {
  Check,
  CircleAlert,
  FileText,
  Info,
  Image,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { AgentStatus } from "#shared/agent-types";

import { useToolGroupDisclosure } from "../../conversation";
import { useSessionArtifactsQuery } from "../../hooks/use-workspace-queries";
import { ImageLightbox } from "../common/image-lightbox";
import { Markdown } from "../common/markdown";
import { Button } from "../ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BUBBLE_MAX_WIDTH } from "./bubble-width";
import { turnDeliverables } from "./deliverables";
import { DeliverablesPill } from "./deliverables-pill";
import { FeedbackRow } from "./feedback-row";
import {
  PremiumUpgradeCard,
  exhaustedScope,
  freeModelSwitches,
  wantsUpgradeCard,
} from "./premium-upgrade-card";
import type {
  AgentRenderItem,
  ChatRenderItem,
  UserFileAttachment,
  UserImageAttachment,
} from "./render-utils";
import { linkifyKnownFiles } from "./render-utils";
import { SubtaskCard, SubtaskReport } from "./subtask-card";
import { ThinkingLoader } from "./thinking-loader";
import { ToolGroupBlock } from "./tool-group";

const ConversationToolGroup = ({
  item,
}: {
  item: Extract<AgentRenderItem, { kind: "tool_group" }>;
}): JSX.Element => {
  const { expanded, setExpanded } = useToolGroupDisclosure(item.id);
  return (
    <ToolGroupBlock
      id={item.id}
      tools={item.tools}
      summary={item.summary}
      state={item.state}
      expanded={expanded}
      onExpandedChange={setExpanded}
    />
  );
};

// ─── Compute-points (credits) chip ────────────────────────────────────────────

/**
 * The reducer folds the CLI's end-of-turn `compute_points_used` into one
 * `credits` segment per turn (points/100); `total` is the running total.
 */
const CreditsChip = ({
  credits,
  total,
}: {
  credits: number;
  total: number;
}): JSX.Element => {
  const { t } = useTranslation();
  return (
    <div className="flex w-full justify-end" data-id="local-code-credits-chip">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="text-muted-foreground cursor-default text-[0.625rem] opacity-60 transition-opacity hover:opacity-100" />
          }
        >
          {t("workspace.credits.used", { credits: credits.toFixed(2) })}
        </TooltipTrigger>
        <TooltipContent side="top">
          {`${t("workspace.credits.thisTurn", { credits: credits.toFixed(2) })}\n${t("workspace.credits.total", { credits: total.toFixed(2) })}`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

// ─── Notification banner ──────────────────────────────────────────────────────

/** The agent said a different model would help, and the chat can offer one. */
export const wantsModelSwitch = (actions?: Array<{ type: string }>): boolean =>
  actions?.some((action) => action.type === "switch-model") === true;

const NotificationBanner = ({
  message,
  severity,
  onRetry,
  onSwitchModel,
}: {
  message: string;
  severity: string;
  onRetry?: () => void;
  /** Point the user at the model picker when a pinned model that keeps failing. */
  onSwitchModel?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const cfg = {
    info: {
      icon: Info,
      bg: "bg-blue-500/8 border-blue-500/20",
      text: "text-blue-400",
    },
    success: {
      icon: Check,
      bg: "bg-green-500/8 border-green-500/20",
      text: "text-green-400",
    },
    warning: {
      icon: TriangleAlert,
      bg: "bg-yellow-500/8 border-yellow-500/20",
      text: "text-yellow-400",
    },
    error: {
      icon: CircleAlert,
      bg: "bg-red-500/8 border-red-500/20",
      text: "text-red-400",
    },
  }[severity] ?? {
    icon: Info,
    bg: "bg-sidebar border-border",
    text: "text-muted-foreground",
  };
  const NotificationIcon = cfg.icon;

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${cfg.bg}`}
    >
      <NotificationIcon className={`size-3.5 shrink-0 ${cfg.text}`} />
      <span className={`flex-1 ${cfg.text}`}>{message}</span>
      {onSwitchModel != null && (
        <Button
          variant="secondary"
          size="xs"
          data-id="notification-switch-model-btn"
          onClick={onSwitchModel}
        >
          {t("workspace.switchModel")}
        </Button>
      )}
      {onRetry != null && (
        <Button
          variant="secondary"
          size="xs"
          data-id="notification-retry-btn"
          onClick={onRetry}
        >
          <RotateCw />
          {t("workspace.retry")}
        </Button>
      )}
    </div>
  );
};

// ─── Agent turn renderer ──────────────────────────────────────────────────────

const AgentTurnContent = ({
  items,
  isPending,
  agentStatus,
  onRetry,
  onSwitchModel,
  onPickModel,
  onResume,
  onRateTurn,
  creditsTotal = 0,
  onOpenSubtask,
  statusLabel,
  filesByName,
}: {
  items: AgentRenderItem[];
  isPending: boolean;
  agentStatus?: AgentStatus;
  onRetry?: () => void;
  onSwitchModel?: () => void;
  /** Pick a named model straight from a card, no picker hop. */
  onPickModel?: (modelId: string) => void;
  /** Run the dead turn again on the free pool once a source has joined it. */
  onResume?: () => void;
  /** Thumbs on a turn, by the rated bot text segment's id. */
  onRateTurn?: (
    segmentId: string,
    rating: "up" | "down" | "clear",
    comment?: string
  ) => Promise<boolean>;
  creditsTotal?: number;
  onOpenSubtask?: (subtaskId: string) => void;
  statusLabel?: string | null;
  conversationId?: string | null;
  filesByName?: Map<string, string>;
}): JSX.Element | null => {
  // Derived from the settled tool calls, so the card appears as soon as the
  // work exists and survives the tool log folding away.
  const deliverables = useMemo(() => turnDeliverables(items), [items]);

  if (items.length === 0 && !isPending) return null;

  // A busy turn always shows a status line at the bottom, suppressed only by a
  // pending permission or an existing spinny item. Not while text streams: a
  // text segment stays `transient` until superseded, so mid-stream text cannot
  // be told from text that handed off to a sub-agent's work, and keying off it
  // stalls the indicator entirely.
  const isWaitingPermission =
    agentStatus === AgentStatus.WaitingForToolPermission;
  const lastItem = items.length > 0 ? items[items.length - 1] : null;
  const lastItemIsSpinny = lastItem?.kind === "spinny";
  const showBottomLoader =
    isPending && !isWaitingPermission && !lastItemIsSpinny;

  return (
    <div className="group/assistant flex flex-col gap-1.5">
      {items.map((item, idx) => {
        // idx in keys: the CLI sometimes emits the same tool-call id twice
        // across sub-agent boundaries, which would collide on item.id alone.
        if (item.kind === "text") {
          return (
            <div
              key={`${item.id}-${idx}`}
              className="prose0 text-sm leading-[1.65]"
            >
              <Markdown
                content={
                  filesByName != null
                    ? linkifyKnownFiles(item.content, filesByName)
                    : item.content
                }
                streaming={item.streaming}
                className="prose dark:prose-invert text-foreground max-w-none"
              />
            </div>
          );
        }
        // Reasoning is kept in the transcript record but not rendered: it
        // arrives in bursts and turned the transcript into a ladder of
        // "Thinking" rows.
        if (item.kind === "thinking") {
          return null;
        }
        if (item.kind === "tool_group") {
          return (
            <ConversationToolGroup key={`${item.id}-${idx}`} item={item} />
          );
        }
        if (item.kind === "notification") {
          // Out of credits is not a malfunction: it gets the way out, not the red line.
          if (wantsUpgradeCard(item.actions)) {
            return (
              <PremiumUpgradeCard
                key={`${item.id}-${idx}`}
                dataId="chat-upgrade-card"
                scope={exhaustedScope(item.actions)}
                freeModels={freeModelSwitches(item.actions)}
                onPickModel={onPickModel}
                onSwitchModel={onSwitchModel}
                onResume={onResume}
              />
            );
          }
          return (
            <NotificationBanner
              key={`${item.id}-${idx}`}
              message={item.message}
              severity={item.severity}
              onRetry={item.severity === "error" ? onRetry : undefined}
              onSwitchModel={
                wantsModelSwitch(item.actions) ? onSwitchModel : undefined
              }
            />
          );
        }
        if (item.kind === "credits") {
          return (
            <CreditsChip
              key={`${item.id}-${idx}`}
              credits={item.creditsUsed}
              total={creditsTotal}
            />
          );
        }
        if (item.kind === "subtask") {
          return (
            <div key={`${item.id}-${idx}`} className="flex flex-col gap-1.5">
              <SubtaskCard
                summary={item.summary}
                onOpen={() => onOpenSubtask?.(item.summary.id)}
              />
              <SubtaskReport summary={item.summary} />
            </div>
          );
        }
        if (item.kind === "feedback") {
          // Only on a settled turn; mid-stream copy would copy a partial answer.
          if (isPending) return null;
          return (
            <FeedbackRow
              key={`${item.id}-${idx}`}
              content={item.content}
              credits={item.credits}
              creditsTotal={creditsTotal}
              onRate={
                onRateTurn == null
                  ? undefined
                  : (rating, comment) =>
                      onRateTurn(item.segmentId, rating, comment)
              }
            />
          );
        }
        if (item.kind === "spinny") {
          // Only ever the tail: a spinny item means "work is starting", and once
          // anything follows it the bottom loader is the indicator. In place,
          // the spinner sat above the tool it waited for and then jumped below.
          if (idx !== items.length - 1) return null;
          return (
            <ThinkingLoader
              key={item.id}
              isVisible={true}
              label={statusLabel}
            />
          );
        }
        return null;
      })}
      {deliverables.length > 0 && <DeliverablesPill items={deliverables} />}
      <ThinkingLoader isVisible={showBottomLoader} label={statusLabel} />
    </div>
  );
};

// ─── Image attachment strip for user messages ─────────────────────────────────

const UserImageThumbStrip = ({
  images,
}: {
  images: UserImageAttachment[];
}): JSX.Element => {
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [errored, setErrored] = useState<Record<string, boolean>>({});
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const results = await Promise.all(
        images.map(async (img) => {
          if (!img.absPath || !img.hostRoot) return null;
          try {
            const result = await window.api.files.readImageAsDataUrl({
              filePath: img.absPath,
              hostRoot: img.hostRoot,
            });
            if (result?.success && result.dataUrl != null) {
              return {
                absPath: img.absPath,
                dataUrl: result.dataUrl,
                ok: true as const,
              };
            }
            return { absPath: img.absPath, ok: false as const };
          } catch {
            return { absPath: img.absPath, ok: false as const };
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, string> = {};
      const failed: Record<string, boolean> = {};
      for (const r of results) {
        if (r == null) continue;
        if (r.ok) next[r.absPath] = r.dataUrl;
        else failed[r.absPath] = true;
      }
      setDataUrls(next);
      setErrored(failed);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [images]);

  return (
    <>
      <div
        data-id="local-code-user-images"
        className="flex flex-wrap justify-end gap-2"
      >
        {images.map((img, idx) => {
          const url = dataUrls[img.absPath];
          const isErr = errored[img.absPath] === true;
          const StatusIcon = isErr ? TriangleAlert : Image;
          const key = `${img.absPath}-${idx}`;
          if (url != null) {
            return (
              <Button
                variant="ghost"
                key={key}
                onClick={() => setLightboxUrl(url)}
                className="border-border size-11 overflow-hidden rounded-lg p-0"
                title={img.fileName}
                data-id={`local-code-user-image-${idx}`}
              >
                <img
                  src={url}
                  alt={img.fileName}
                  className="h-full w-full object-cover"
                />
              </Button>
            );
          }
          return (
            <div
              key={key}
              className="border-border bg-muted flex size-11 items-center justify-center rounded-lg border"
              title={isErr ? `Image not found: ${img.fileName}` : img.fileName}
              data-id={`local-code-user-image-${idx}`}
            >
              <StatusIcon
                className={`size-3.5 ${isErr ? "text-amber-400" : "text-muted-foreground opacity-60"}`}
              />
            </div>
          );
        })}
      </div>
      <ImageLightbox
        isOpen={lightboxUrl != null}
        imageUrl={lightboxUrl ?? ""}
        onClose={() => setLightboxUrl(null)}
      />
    </>
  );
};

// ─── File attachment strip for user messages ──────────────────────────────────

/** Attached files as pills: name, path on hover, Finder on click. */
const UserFileStrip = ({
  files,
}: {
  files: UserFileAttachment[];
}): JSX.Element => (
  <div
    data-id="local-code-user-files"
    className="flex flex-wrap justify-end gap-2"
  >
    {files.map((file, idx) => (
      <button
        type="button"
        key={`${file.absPath}-${idx}`}
        onClick={() => void window.api.showItemInFolder(file.absPath)}
        title={file.absPath}
        data-id={`local-code-user-file-${idx}`}
        className="border-border bg-muted/60 hover:bg-muted flex max-w-64 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left"
      >
        <FileText className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground truncate text-xs">
          {file.fileName}
        </span>
      </button>
    ))}
  </div>
);

// ─── User message bubble ──────────────────────────────────────────────────────

/**
 * Neither side is labelled, in a session as in a bot's chat: the side of the
 * screen already says who spoke, and no message app labels your own messages
 * or repeats the other party's name above every reply.
 */
export const UserMessageBubble = ({
  content,
  images,
  files,
  dataId,
}: {
  content: string;
  images?: UserImageAttachment[];
  files?: UserFileAttachment[];
  dataId?: string;
}): JSX.Element => (
  <div className="flex flex-col items-end gap-1">
    {images != null && images.length > 0 && (
      <UserImageThumbStrip images={images} />
    )}
    {files != null && files.length > 0 && <UserFileStrip files={files} />}
    {content.length > 0 && (
      <div
        className={`bg-primary/15 text-foreground ${BUBBLE_MAX_WIDTH} rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm leading-[1.55] [overflow-wrap:anywhere] whitespace-pre-wrap`}
        data-id={dataId}
      >
        {content}
      </div>
    )}
  </div>
);

// ─── Chat message list ────────────────────────────────────────────────────────

export const ChatMessageList = ({
  chatItems,
  isPending,
  currentTurnId,
  agentStatus,
  onRetry,
  onSwitchModel,
  onPickModel,
  onResume,
  onRateTurn,
  creditsTotal = 0,
  onOpenSubtask,
  statusLabel,
  conversationId,
}: {
  chatItems: ChatRenderItem[];
  isPending: boolean;
  currentTurnId?: string;
  agentStatus?: AgentStatus;
  onRetry?: () => void;
  onSwitchModel?: () => void;
  onPickModel?: (modelId: string) => void;
  onResume?: () => void;
  onRateTurn?: (
    segmentId: string,
    rating: "up" | "down" | "clear",
    comment?: string
  ) => Promise<boolean>;
  creditsTotal?: number;
  onOpenSubtask?: (subtaskId: string) => void;
  statusLabel?: string | null;
  conversationId?: string | null;
}): JSX.Element => {
  // Fetched once for the whole list and handed down, so a filename the agent
  // mentions becomes a link to the real file; an unmatched name stays plain.
  const artifactsQuery = useSessionArtifactsQuery();
  const filesByName = useMemo(() => {
    const byName = new Map<string, string>();
    if (conversationId == null) return byName;
    for (const artifact of artifactsQuery.data ?? []) {
      if (artifact.sessionId !== conversationId || artifact.kind === "link")
        continue;
      const name = artifact.location.split(/[/\\]/).pop();
      if (name != null && name.length > 0 && !byName.has(name))
        byName.set(name, artifact.location);
    }
    return byName;
  }, [artifactsQuery.data, conversationId]);

  return (
    <>
      {chatItems.map((item) => {
        if (item.kind === "user") {
          return (
            <UserMessageBubble
              key={item.id}
              content={item.text}
              images={item.images}
              files={item.files}
            />
          );
        }
        const isCurrentTurn = currentTurnId === item.id;
        return (
          // The agent's half of the iMessage geometry: left-aligned, capped short.
          <div
            key={item.id}
            className={`w-full ${BUBBLE_MAX_WIDTH} self-start`}
          >
            <AgentTurnContent
              items={item.items}
              isPending={isCurrentTurn ? isPending : false}
              agentStatus={isCurrentTurn ? agentStatus : undefined}
              onRetry={onRetry}
              onSwitchModel={onSwitchModel}
              onPickModel={onPickModel}
              onResume={onResume}
              onRateTurn={onRateTurn}
              creditsTotal={creditsTotal}
              onOpenSubtask={onOpenSubtask}
              statusLabel={isCurrentTurn ? statusLabel : undefined}
              conversationId={conversationId}
              filesByName={filesByName}
            />
          </div>
        );
      })}
      {/* Pending with no current agent turn: a follow-up not yet responded to */}
      {isPending && currentTurnId == null && (
        <AgentTurnContent
          key="pending-turn"
          items={[]}
          isPending={isPending}
          agentStatus={agentStatus}
          statusLabel={statusLabel}
        />
      )}
    </>
  );
};
