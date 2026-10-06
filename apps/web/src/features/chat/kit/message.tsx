import {
  stripAttachmentRefs,
  visibleUserText,
  isHiddenUserText,
} from "@abacus-ai/contract/transcript/user-text";
/**
 * Message widgets (spec 02 §5.1, §5.3, §8.6): `BotMessage` (bubbles, bot
 * tint for the user, spoken parts and inline permissions) and
 * `SessionMessage` (prose rows, muted user bubble). User messages render
 * trailing `@/abs/path` lines as attachment chips; pending outbox messages
 * show "Not sent" with Retry/Discard when they failed. An assistant message
 * with no parts renders nothing (F12).
 */
import type { UIMessage } from "@tanstack/ai-client";
import type { MessageProps } from "@tanstack/ai-react/ui";
import { ChevronRight, FileText } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { botVisibleMessage } from "#renderer/lib/bot-turns/turns";
import { cn } from "#renderer/lib/cn";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "#renderer/ui/attachment";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";

import { Markdown } from "../markdown/markdown";
import { useToolWindow } from "../scroller/row-context";
import { useHost, useThreadStore } from "../store/selectors";
import {
  useChatView,
  useSubagentScope,
  type MessageDecoration,
} from "./context";
import { useKitParts, MessageScope } from "./message-scope";

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
  const { session, composer } = useChatView();
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
      {composer.readOnly == null && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void session.retryOutbox(message.id)}
        >
          {t("chat.message.retry")}
        </Button>
      )}
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

type UserTextMeta = import("@abacus-ai/contract/agent-types").UserTextTags;

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
  if (isHiddenUserText(raw, tags)) return { hidden: true, body: "", paths: [] };
  const visible = visibleUserText(raw, tags);
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
  badge,
}: {
  message: UIMessage;
  tint: boolean;
  badge?: ReactNode;
}) => {
  const { workspaceRoot } = useChatView();
  const { hidden, body, paths } = userView(message);
  if (hidden) return null;
  return (
    <div className="flex flex-col items-end gap-1.5" data-role="user">
      {body !== "" ? (
        <div
          className={cn(
            "relative w-fit max-w-[min(520px,85%)] px-3 py-2",
            tint
              ? "rounded-[20px] rounded-br-md bg-[var(--bot-accent,var(--primary))] text-[var(--bot-accent-foreground,var(--primary-foreground))]"
              : "rounded-2xl bg-[var(--chat-user-bubble)]"
          )}
        >
          <Markdown content={body} role="user" workspaceRoot={workspaceRoot} />
          {badge}
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

interface ToolSegment {
  id: string;
  type: string;
  groupId?: string;
  partIndex?: number | null;
  summary?: string;
  category?: string;
}

// Index each immutable message once, rather than searching thousands of parts
// and segments for every row in the moving tool window.
const messageIndex = (message: UIMessage | undefined) => {
  const parts = new Map<UIMessage["parts"][number], number>();
  message?.parts.forEach((part, index) => {
    if (!parts.has(part)) parts.set(part, index);
  });
  const groupIds = new Map<number, string | null>();
  const groups = new Map<string, ToolSegment>();
  for (const segment of (message?.metadata?.abacus?.segments ??
    []) as ToolSegment[]) {
    if (segment.partIndex != null && !groupIds.has(segment.partIndex))
      groupIds.set(segment.partIndex, segment.groupId ?? null);
    if (segment.type === "tool_group" && !groups.has(segment.id))
      groups.set(segment.id, segment);
  }
  return { parts, groupIds, groups };
};

const isEmptyAssistant = (message: UIMessage): boolean =>
  message.role === "assistant" && message.parts.length === 0;

/** The route's decoration of one message (03-bots §11.3), or none. */
const useDecoration = (message: UIMessage): MessageDecoration | null => {
  const { session, slots } = useChatView();
  const messages = useHost(session, (state) => state.messages);
  const runActive = useThreadStore(
    session,
    (state) => state.runs.active != null
  );
  const decorate = slots.decorateMessage;
  if (decorate == null) return null;
  const index = messages.findIndex((item) => item.id === message.id);
  return decorate(message, { messages, index, runActive });
};

export const BotMessage = ({ message, Parts }: MessageProps<unknown>) => {
  const BotUI = useKitParts();
  const streaming = useStreaming(message);
  const decoration = useDecoration(message);
  const { session } = useChatView();
  const messages = useHost(session, (state) => state.messages);
  const runActive = useThreadStore(
    session,
    (state) => state.runs.active != null
  );
  const visible = botVisibleMessage(message, messages, runActive);
  if (visible !== message) return <BotUI.Message message={visible} />;
  if (
    isEmptyAssistant(message) ||
    (decoration?.hidden === true &&
      !message.parts.some((part) => part.type === "tool-call"))
  )
    return null;
  if (message.role === "user")
    return (
      <>
        {decoration?.before}
        <UserMessage message={message} tint badge={decoration?.badge} />
        {decoration?.after}
      </>
    );
  const PartsView = Parts as ComponentType;
  return (
    <MessageScope
      value={{ id: message.id, role: "assistant", streaming, message }}
    >
      <div className="flex flex-col items-start gap-1.5" data-role="assistant">
        {decoration?.before}
        {message.parts.some((part) => part.type === "subagent") ? (
          <StepControls side="earlier" />
        ) : null}
        <PartsView />
        {message.parts.some((part) => part.type === "subagent") ? (
          <StepControls side="more" />
        ) : null}
        <Credits message={message} />
        {decoration?.after}
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
  const indexed = messageIndex(message);
  const visibleUnits =
    window == null
      ? null
      : new Set(window.ids.slice(window.range.start, window.range.end));
  // Bound the selector's allocation work as well as the mounted widgets.
  // Keep each visible call's result so its status and expander stay intact.
  const selectedMessage =
    visibleUnits == null
      ? message
      : {
          ...message,
          parts: message.parts.filter((part) => {
            if (part.type === "tool-call")
              return visibleUnits.has(`${scope}\0${part.id}`);
            if (part.type === "tool-result")
              return visibleUnits.has(`${scope}\0${part.toolCallId}`);
            return true;
          }),
        };
  return (
    <SessionUI.Message message={selectedMessage}>
      {(parts) => {
        const blocks: Array<{ id: string | null; parts: typeof parts }> = [];
        for (const part of parts) {
          if (part.part.type === "tool-result") continue;
          if (
            part.part.type === "tool-call" &&
            visibleUnits != null &&
            !visibleUnits.has(`${scope}\0${part.part.id}`)
          )
            continue;
          const index = indexed.parts.get(part.part)!;
          const id = indexed.groupIds.get(index) ?? null;
          const previous = blocks.at(-1);
          if (id != null && previous?.id === id) previous.parts.push(part);
          else blocks.push({ id, parts: [part] });
        }
        return blocks.map((block) => {
          const content = block.parts.map((part) => (
            <SessionUI.Part key={indexed.parts.get(part.part)} part={part} />
          ));
          if (block.id == null)
            return (
              <div key={indexed.parts.get(block.parts[0]!.part)}>{content}</div>
            );
          const headerVisible =
            visibleUnits == null ||
            visibleUnits.has(`group\0${scope}\0${message.id}\0${block.id}`);
          const childVisible =
            visibleUnits == null ||
            block.parts.some(
              (p) =>
                p.part.type === "tool-call" &&
                visibleUnits.has(`${scope}\0${p.part.id}`)
            );
          if (!headerVisible && !childVisible) return null;
          if (!headerVisible) return <div key={block.id}>{content}</div>;
          const group = indexed.groups.get(block.id);
          return (
            <Collapsible key={block.id} defaultOpen data-slot="tool-group">
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

export const SessionMessage = ({ message }: MessageProps<unknown>) => {
  const streaming = useStreaming(message);
  if (isEmptyAssistant(message)) return null;
  if (message.role === "user")
    return <UserMessage message={message} tint={false} />;
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
        <GroupedParts message={message} />
        <StepControls side="more" />
        <Credits message={message} />
      </div>
    </MessageScope>
  );
};
