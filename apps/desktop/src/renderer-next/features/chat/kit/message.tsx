/**
 * Message widgets (spec 02 §5.1, §5.3, §8.6): `BotMessage` (bubbles, bot
 * tint for the user, "Worked through {n} steps" for tool calls) and
 * `SessionMessage` (prose rows, muted user bubble). User messages render
 * trailing `@/abs/path` lines as attachment chips; pending outbox messages
 * show "Not sent" with Retry/Discard when they failed. An assistant message
 * with no parts renders nothing (F12).
 */
import type {
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai-client";
import type { MessageProps } from "@tanstack/ai-react/ui";
import { ChevronRight, FileText, ListChecks } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "#next/ui/attachment";
import { Button } from "#next/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#next/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "#next/ui/marker";
import {
  isRoutineFire,
  stripAttachmentRefs,
  visibleUserText,
  type AttachmentRef,
} from "#shared/transcript/user-text";

import { Markdown } from "../markdown/markdown";
import { useToolWindow } from "../scroller/row-context";
import { useHost, useThreadStore } from "../store/selectors";
import { useChatView, useSubagentScope } from "./context";
import { useKitParts, useMessageScope, MessageScope } from "./message-scope";
import { ToolLine } from "./tools/tool-line";

type Loose = Record<string, unknown>;

const ATTACHMENT_LINE = /^@((?:[A-Za-z]:[\\/]|\/)\S.*)$/;

/** The text and the trailing `@/abs/path` lines of a user message (§8.6). */
const splitAttachments = (text: string): { body: string; paths: string[] } => {
  const lines = text.split("\n");
  const paths: string[] = [];
  while (lines.length > 0) {
    const last = lines.at(-1)!.trim();
    const match = ATTACHMENT_LINE.exec(last);
    if (match == null) {
      if (last === "" && paths.length > 0) {
        lines.pop();
        continue;
      }
      break;
    }
    paths.unshift(match[1]!);
    lines.pop();
  }
  return { body: lines.join("\n").trimEnd(), paths };
};

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { content: string }).content)
    .join("");

const IMAGE = /\.(png|jpe?g|gif|webp|avif|heic|bmp|svg)$/i;

const AttachmentChip = ({ path }: { path: string }) => {
  const { runtime, workspaceRoot, onOpenFile } = useChatView();
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const ext = name.includes(".") ? name.split(".").at(-1)!.toUpperCase() : "";
  const [thumb, setThumb] = useState<string | null>(null);
  const image = IMAGE.test(name);
  const chip = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined"
  );
  useEffect(() => {
    if (chip.current == null) return;
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(chip.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!image || !inView) return;
    let live = true;
    runtime.host
      .readImage(
        path,
        workspaceRoot ??
          path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")))
      )
      .then((url) => live && url !== "" && setThumb(url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [image, inView, path, runtime, workspaceRoot]);
  return (
    <Attachment className="w-64 cursor-pointer" ref={chip}>
      <AttachmentTrigger
        aria-label={name}
        onClick={() =>
          onOpenFile != null
            ? onOpenFile(path)
            : void runtime.host.showItemInFolder(path)
        }
      />
      <AttachmentMedia>
        {thumb != null ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <FileText aria-hidden />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>{ext}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
};

const PendingState = ({ message }: { message: UIMessage }) => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const abacus = (
    message.metadata as
      | { abacus?: { pending?: boolean; state?: string } }
      | undefined
  )?.abacus;
  if (abacus?.pending !== true) return null;
  if (abacus.state !== "failed")
    return (
      <div className="text-muted-foreground text-end text-xs">
        {t("chat.message.sending")}
      </div>
    );
  return (
    <div
      className="text-destructive flex items-center justify-end gap-1 text-xs"
      role="status"
    >
      {t("chat.message.notSent")}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void session.retryOutbox(message.id)}
      >
        {t("chat.message.retry")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => session.discardOutbox(message.id)}
      >
        {t("chat.message.discard")}
      </Button>
    </div>
  );
};

interface UserTextMeta {
  routineFire?: true;
  attachments?: AttachmentRef[];
}

/**
 * What the bubble shows (C.3 r1 fixes, `shared/transcript/user-text.ts`):
 * system reminders stripped, a routine-fire envelope hidden, attachments as
 * chips (migrated messages carry them as `userText.attachments`; live ones
 * as trailing `@/abs/path` lines).
 */
export const userView = (
  message: UIMessage
): { hidden: boolean; body: string; paths: string[] } => {
  const raw = textOf(message);
  const tags = (
    message.metadata as { abacus?: { userText?: UserTextMeta } } | undefined
  )?.abacus?.userText;
  if (tags?.routineFire === true || isRoutineFire(raw))
    return { hidden: true, body: "", paths: [] };
  const visible = visibleUserText(raw);
  if (tags?.attachments != null)
    return {
      hidden: false,
      body: stripAttachmentRefs(visible),
      paths: tags.attachments.map((ref) => ref.path),
    };
  const { body, paths } = splitAttachments(visible);
  return { hidden: false, body, paths };
};

const UserMessage = ({
  message,
  tint,
}: {
  message: UIMessage;
  tint: boolean;
}) => {
  const { workspaceRoot } = useChatView();
  const { hidden, body, paths } = userView(message);
  if (hidden) return null;
  return (
    <div className="flex flex-col items-end gap-1.5" data-role="user">
      {body !== "" ? (
        <div
          className={cn(
            "w-fit max-w-[min(520px,85%)] px-3 py-2",
            tint
              ? "rounded-[20px] rounded-br-md bg-[var(--bot-accent,var(--primary))] text-[var(--bot-accent-foreground,var(--primary-foreground))]"
              : "rounded-2xl bg-[var(--chat-user-bubble)]"
          )}
        >
          <Markdown content={body} role="user" workspaceRoot={workspaceRoot} />
        </div>
      ) : null}
      {paths.length > 0 ? (
        <AttachmentGroup className="justify-end">
          {paths.map((path) => (
            <AttachmentChip key={path} path={path} />
          ))}
        </AttachmentGroup>
      ) : null}
      <PendingState message={message} />
    </div>
  );
};

const Credits = ({ message }: { message: UIMessage }) => {
  const { t } = useTranslation();
  const credits = (
    message.metadata as
      | { abacus?: { credits?: Array<{ creditsUsed: number }> } }
      | undefined
  )?.abacus?.credits;
  if (credits == null || credits.length === 0) return null;
  const total = credits.reduce((sum, item) => sum + item.creditsUsed, 0);
  return (
    <div className="text-muted-foreground text-xs">
      {t("chat.message.credits", { count: total })}
    </div>
  );
};

const useStreaming = (message: UIMessage): boolean => {
  const { session } = useChatView();
  const active = useThreadStore(session, (state) => state.runs.active != null);
  const lastId = useHost(session, (state) => state.messages.at(-1)?.id);
  return active && message.role === "assistant" && message.id === lastId;
};

const pairs = (
  message: UIMessage
): Array<{ part: ToolCallPart; result?: ToolResultPart }> => {
  const results = new Map<string, ToolResultPart>();
  for (const part of message.parts)
    if (part.type === "tool-result")
      results.set(part.toolCallId, part as ToolResultPart);
  return message.parts
    .filter((part): part is ToolCallPart => part.type === "tool-call")
    .map((part) => {
      const result = results.get(part.id);
      return result != null ? { part, result } : { part };
    });
};

const MAX_TOOL_ROWS = 50;

/** Tool rows past the first 50 collapse to "{n} more steps" (§10). */
const StepList = ({
  items,
}: {
  items: Array<{ part: ToolCallPart; result?: ToolResultPart }>;
}) => {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(MAX_TOOL_ROWS);
  const window = useToolWindow();
  const message = useMessageScope().message;
  const scope = useSubagentScope() ?? "";
  const segments = message?.metadata?.abacus?.segments as
    | Array<{
        id: string;
        type: string;
        groupId?: string;
        partIndex?: number;
        summary?: string;
        category?: string;
      }>
    | undefined;
  const blocks: Array<{ id: string | null; items: typeof items }> = [];
  const start = window?.range.start ?? 0;
  const end = window?.range.end ?? limit;
  const visibleItems =
    window == null
      ? items.slice(start, end)
      : items.filter((item) => {
          const index = window.ids.indexOf(`${scope}\0${item.part.id}`);
          return index >= start && index < end;
        });
  const remaining =
    window == null
      ? Math.max(0, items.length - end)
      : items.filter(
          (item) => window.ids.indexOf(`${scope}\0${item.part.id}`) >= end
        ).length;
  for (const item of visibleItems) {
    const index = message?.parts.indexOf(item.part);
    const id =
      segments?.find((segment) => segment.partIndex === index)?.groupId ?? null;
    const previous = blocks.at(-1);
    if (id != null && previous?.id === id) previous.items.push(item);
    else blocks.push({ id, items: [item] });
  }
  return (
    <div className="flex flex-col">
      {window != null && start > 0 ? <StepControls side="earlier" /> : null}
      {blocks.map((block, index) => {
        const content = block.items.map(({ part, result }) => (
          <ToolLine
            key={part.id}
            part={part}
            {...(result != null ? { result } : {})}
          />
        ));
        if (block.id == null) return <div key={index}>{content}</div>;
        const group = segments?.find(
          (segment) => segment.type === "tool_group" && segment.id === block.id
        );
        return (
          <Collapsible key={index} data-slot="tool-group">
            <CollapsibleTrigger
              hidden={
                window != null &&
                (() => {
                  const index = window.ids.indexOf(
                    `group\0${scope}\0${message?.id}\0${block.id}`
                  );
                  return index < start || index >= end;
                })()
              }
            >
              {group?.summary ?? group?.category ?? block.id}
            </CollapsibleTrigger>
            <CollapsibleContent>{content}</CollapsibleContent>
          </Collapsible>
        );
      })}
      {remaining > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() =>
            window != null
              ? window.more()
              : setLimit((value) => Math.min(399, value + 100))
          }
        >
          {t("chat.tool.moreSteps", { count: remaining })}
        </Button>
      ) : null}
    </div>
  );
};

const WorkedThrough = ({ message }: { message: UIMessage }) => {
  const { t } = useTranslation();
  const items = pairs(message);
  if (items.length === 0) return null;
  return (
    <Collapsible>
      <Marker
        render={<CollapsibleTrigger />}
        className="group/w hover:text-foreground w-fit cursor-pointer"
      >
        <MarkerIcon>
          <ListChecks aria-hidden />
        </MarkerIcon>
        <MarkerContent>
          {t("chat.message.workedThrough", { count: items.length })}
        </MarkerContent>
        <ChevronRight
          aria-hidden
          className="size-3 transition-transform group-data-[panel-open]/w:rotate-90"
        />
      </Marker>
      <CollapsibleContent className="pt-1">
        <StepList items={items} />
      </CollapsibleContent>
    </Collapsible>
  );
};

const isEmptyAssistant = (message: UIMessage): boolean =>
  message.role === "assistant" && message.parts.length === 0;

export const BotMessage = ({ message, Parts }: MessageProps<unknown>) => {
  const streaming = useStreaming(message);
  if (isEmptyAssistant(message)) return null;
  if (message.role === "user") return <UserMessage message={message} tint />;
  const PartsView = Parts as ComponentType;
  return (
    <MessageScope
      value={{ id: message.id, role: "assistant", streaming, message }}
    >
      <div className="flex flex-col items-start gap-1.5" data-role="assistant">
        <PartsView />
        <WorkedThrough message={message} />
        <Credits message={message} />
      </div>
    </MessageScope>
  );
};

const StepControls = ({ side }: { side: "earlier" | "more" }) => {
  const window = useToolWindow();
  const { t } = useTranslation();
  if (window == null) return null;
  const count =
    side === "earlier"
      ? window.range.start
      : window.ids.length - window.range.end;
  if (count === 0) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      data-slot="steps-more"
      onClick={side === "earlier" ? window.earlier : window.more}
    >
      {side === "earlier"
        ? t("chat.tool.earlierSteps", { count })
        : t("chat.tool.moreSteps", { count })}
    </Button>
  );
};

const GroupedParts = ({ message }: { message: UIMessage }) => {
  const SessionUI = useKitParts();
  const window = useToolWindow();
  const scope = useSubagentScope() ?? "";
  const segments = message.metadata?.abacus?.segments as
    | Array<{
        id: string;
        groupId?: string;
        partIndex: number | null;
        type: string;
        summary?: string;
        category?: string;
      }>
    | undefined;
  return (
    <SessionUI.Message message={message}>
      {(parts) => {
        const blocks: Array<{ id: string | null; parts: typeof parts }> = [];
        for (const part of parts) {
          if (part.part.type === "tool-result") continue;
          const index = message.parts.indexOf(part.part);
          const id =
            segments?.find((segment) => segment.partIndex === index)?.groupId ??
            null;
          const previous = blocks.at(-1);
          if (id != null && previous?.id === id) previous.parts.push(part);
          else blocks.push({ id, parts: [part] });
        }
        return blocks.map((block, index) => {
          const content = block.parts.map((part, i) => (
            <SessionUI.Part key={i} part={part} />
          ));
          if (block.id == null) return <div key={index}>{content}</div>;
          const header =
            window?.ids.indexOf(
              `group\0${scope}\0${message.id}\0${block.id}`
            ) ?? -1;
          const headerVisible =
            window == null ||
            (header >= window.range.start && header < window.range.end);
          const childVisible =
            window == null ||
            block.parts.some(
              (p) =>
                p.part.type === "tool-call" &&
                (() => {
                  const index = window.ids.indexOf(`${scope}\0${p.part.id}`);
                  return (
                    index >= window.range.start && index < window.range.end
                  );
                })()
            );
          if (!headerVisible && !childVisible) return null;
          const group = segments?.find(
            (segment) =>
              segment.id === block.id && segment.type === "tool_group"
          );
          return (
            <Collapsible key={index} defaultOpen data-slot="tool-group">
              <CollapsibleTrigger
                hidden={!headerVisible}
                className="text-muted-foreground flex items-center gap-2 text-xs"
              >
                <ChevronRight aria-hidden className="size-3" />
                {group?.summary ?? group?.category ?? block.id}
              </CollapsibleTrigger>
              <CollapsibleContent>{content}</CollapsibleContent>
            </Collapsible>
          );
        });
      }}
    </SessionUI.Message>
  );
};

export const SessionMessage = ({ message, Parts }: MessageProps<unknown>) => {
  const streaming = useStreaming(message);
  if (isEmptyAssistant(message)) return null;
  if (message.role === "user")
    return <UserMessage message={message} tint={false} />;
  const PartsView = Parts as ComponentType;
  const grouped = (
    message.metadata as { abacus?: { segments?: Loose[] } } | undefined
  )?.abacus?.segments?.some((segment) => segment.type === "tool_group");
  return (
    <MessageScope
      value={{ id: message.id, role: "assistant", streaming, message }}
    >
      <div
        className="flex flex-col gap-2"
        data-role="assistant"
        data-grouped={grouped ? "" : undefined}
      >
        <StepControls side="earlier" />
        {grouped ? <GroupedParts message={message} /> : <PartsView />}
        <StepControls side="more" />
        <Credits message={message} />
      </div>
    </MessageScope>
  );
};
