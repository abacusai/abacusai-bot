import { isSuggestTasksTool } from "@abacus-ai/contract/bots/suggested-tasks";
import {
  isPastedText,
  pastedTextTitle,
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
import { parsePartialJSON, type UIMessage } from "@tanstack/ai-client";
import type { MessageProps } from "@tanstack/ai-react/ui";
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  CircleAlert,
  Compass,
  Eye,
  FileText,
  Globe,
  Hammer,
  ListChecks,
  MessageCircleQuestionMark,
  PackageCheck,
  ScanText,
  Plug,
  Search,
  Sparkles,
  SquarePen,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { containmentRootFor } from "#renderer/components/file-preview/paths";
import {
  botVisibleMessage,
  isBotHelpTool,
  isHandOffTool,
  isPaidFeatureTool,
} from "#renderer/lib/bot-turns/turns";
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
import { Marker, MarkerContent, MarkerIcon } from "#renderer/ui/marker";

import { FoldsWholeContext, Markdown } from "../markdown/markdown";
import { coalescedIds, isBlankText, isThinking } from "../scroller/coalesce";
import { useToolWindow } from "../scroller/row-context";
import {
  descriptorFor,
  messageIndexOf,
  sameTurnWindow,
  turnWindow,
  useHost,
  useThreadStore,
  type TurnWindow,
} from "../store/selectors";
import {
  useChatView,
  useSubagentScope,
  type MessageDecoration,
} from "./context";
import {
  MessageActions,
  MessageMenu,
  MessageReactionPills,
  TurnActions,
} from "./message-actions";
import { useKitParts, useMessageScope, MessageScope } from "./message-scope";
import { ReplyQuote, jumpToMessage } from "./reply";
import { joinLabels, toolRunCounts, toolRunKind } from "./tool-run";
import { useRunOpen } from "./tool-run-state";
import { isMemoryTool } from "./tools/memory-tool";
import { toolInput } from "./tools/normalize";
import { PaidFeatureToolCard } from "./tools/paid-feature";
import { RunLiveOutput } from "./tools/tool-line";

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
  const { t } = useTranslation();
  const { runtime, workspaceRoot, onOpenFile } = useChatView();
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const ext = name.includes(".") ? name.split(".").at(-1)!.toUpperCase() : "";
  const pasted = isPastedText(name);
  const [pastedTitle, setPastedTitle] = useState("");
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
      .readImage(path, containmentRootFor(path, workspaceRoot))
      .then((url) => live && url !== "" && setThumb(url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [image, inView, path, runtime, workspaceRoot]);
  // A paste is titled by its first line: one small read once it is in view.
  useEffect(() => {
    if (!pasted || !inView || runtime.host.readText == null) return;
    let live = true;
    runtime.host
      .readText(path, containmentRootFor(path, workspaceRoot))
      .then((head) => live && setPastedTitle(pastedTextTitle(head)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pasted, inView, path, runtime, workspaceRoot]);
  const label = pasted ? t("chat.composer.pastedText") : ext;
  const title = pasted ? pastedTitle || label : name;
  return (
    <Attachment className="w-64 cursor-pointer" ref={chip}>
      <AttachmentTrigger
        aria-label={title}
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
        ) : pasted ? (
          <ScanText aria-hidden />
        ) : (
          <FileText aria-hidden />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        <AttachmentDescription>{label}</AttachmentDescription>
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
type AppLineKind = "test-repair" | "test-repair-limit" | "tests-left-alone";

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

/**
 * The app's own line in a transcript (the verify loop's). A user-role message
 * so the transcript keeps it in place, but never the user's words: it is hidden
 * as user text everywhere, and drawn here in the reader's language.
 */
/**
 * A hidden note the route draws as a row of its own (a bot-to-bot exchange,
 * a task another bot passed on): kept in the transcript like an app line,
 * drawn by `decorateMessage`.
 */
export const routeRowOf = (message: UIMessage): string | null => {
  const kind = (
    message.metadata as { abacus?: { userText?: UserTextMeta } } | undefined
  )?.abacus?.userText?.operator?.kind;
  return kind === "bot-exchange" || kind === "bot-task" ? kind : null;
};

export const appLineOf = (message: UIMessage): AppLineKind | null => {
  const kind = (
    message.metadata as { abacus?: { userText?: UserTextMeta } } | undefined
  )?.abacus?.userText?.operator?.kind;
  return kind === "test-repair" ||
    kind === "test-repair-limit" ||
    kind === "tests-left-alone"
    ? kind
    : null;
};

const AppLine = ({ kind }: { kind: AppLineKind }) => {
  const { t } = useTranslation();
  const warning = kind !== "test-repair";
  return (
    <Marker variant="border" data-slot="app-line" data-kind={kind}>
      <MarkerIcon>
        {warning ? (
          <AlertTriangle
            aria-hidden
            className="text-[var(--chat-status-attention)]"
          />
        ) : (
          <Wrench aria-hidden />
        )}
      </MarkerIcon>
      <MarkerContent>
        {kind === "test-repair"
          ? t("chat.appLine.testRepair")
          : kind === "test-repair-limit"
            ? t("chat.appLine.testRepairLimit")
            : t("chat.appLine.testsLeftAlone")}
      </MarkerContent>
    </Marker>
  );
};

/** A user message taller than this folds, with a toggle; its words are all there. */
const USER_FOLD_PX = 320;

/**
 * The user's words in their bubble, folded past `USER_FOLD_PX` (with room
 * to spare, so a message just over it stays open) behind "Show more", as a
 * long code block folds. The one fold here: it tells markdown's code blocks
 * not to fold inside it (`FoldsWholeContext`), and once opened it stays
 * open. Keyboard focus landing below the fold (a link, a code block) opens
 * it; a click or drag-select anywhere in it, or the text's own focus ring,
 * does not. Measured, so it holds for any width and font.
 */
const FoldedText = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  /** A pointer is down in the text: the focus it causes is not keyboard focus. */
  const pointer = useRef(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node == null) return;
    const measure = () => setTall(node.scrollHeight > USER_FOLD_PX * 1.25);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const folded = tall && !open;
  return (
    <FoldsWholeContext value>
      <div
        ref={ref}
        data-slot="user-text"
        data-folded={folded ? "" : undefined}
        onPointerDownCapture={() => {
          pointer.current = true;
        }}
        onPointerUpCapture={() => {
          pointer.current = false;
        }}
        onPointerCancelCapture={() => {
          pointer.current = false;
        }}
        onFocusCapture={(event) => {
          // A press (a click, a drag-select) focuses what it lands on: only keyboard focus opens.
          if (pointer.current) {
            pointer.current = false;
            return;
          }
          if (!folded) return;
          const fold = event.currentTarget;
          const target = event.target as HTMLElement;
          // The text's own wrapper (selection, focus ring) holds everything: not a reason to open.
          if (target.contains(fold.firstElementChild)) return;
          // Where the target sits in the text, whatever focus scrolled the clip by.
          const bottom =
            target.getBoundingClientRect().bottom -
            fold.getBoundingClientRect().top +
            fold.scrollTop;
          if (bottom > fold.clientHeight) {
            fold.scrollTop = 0;
            setOpen(true);
          }
        }}
        className={cn(
          folded &&
            "max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
        )}
      >
        {children}
      </div>
      {tall ? (
        <button
          type="button"
          data-slot="user-text-more"
          aria-expanded={open}
          className="mt-1 text-xs font-medium underline-offset-2 opacity-80 hover:underline hover:opacity-100"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("chat.message.showLess") : t("chat.message.showMore")}
        </button>
      ) : null}
    </FoldsWholeContext>
  );
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
  const { workspaceRoot, threadId, skin } = useChatView();
  const { hidden, body, paths } = userView(message);
  const appLine = appLineOf(message);
  if (appLine != null) return <AppLine kind={appLine} />;
  if (hidden) return null;
  const reacted = (message.metadata?.abacus?.reactions?.length ?? 0) > 0;
  return (
    <MessageActions message={message} text={body}>
      <div className="flex flex-col items-end gap-1.5" data-role="user">
        {body !== "" || message.metadata?.abacus?.userText?.replyTo ? (
          <div
            data-slot="user-bubble"
            data-tint={tint ? "" : undefined}
            className={cn(
              "relative w-fit max-w-[min(640px,85%)] px-3 py-2",
              tint
                ? "rounded-[20px] rounded-br-md bg-[var(--bot-accent,var(--primary))] text-[var(--bot-accent-foreground,var(--primary-foreground))]"
                : "rounded-2xl bg-[var(--chat-user-bubble)]",
              // Room for the tapback pill hanging off the bottom edge.
              reacted && badge == null && "mb-2"
            )}
          >
            {message.metadata?.abacus?.userText?.replyTo ? (
              <ReplyQuote
                variant="bubble"
                target={message.metadata.abacus.userText.replyTo}
                onJump={(id) => jumpToMessage(id, threadId)}
              />
            ) : null}
            <FoldedText>
              <Markdown
                content={body}
                role="user"
                selectable
                workspaceRoot={workspaceRoot}
              />
            </FoldedText>
            {badge != null ? (
              // The bot's badge stays where it is; the user's pill sits beside it.
              <span className="inline-flex items-center gap-1.5">
                {badge}
                <MessageReactionPills message={message} inline />
              </span>
            ) : (
              <MessageReactionPills message={message} />
            )}
            {skin === "session" ? null : (
              <MessageMenu message={message} text={body} />
            )}
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
    </MessageActions>
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
    <div
      className="text-muted-foreground text-xs select-none"
      data-selection-chrome=""
    >
      {t("chat.message.credits", { count: total })}
    </div>
  );
};

const useStreaming = (message: UIMessage): boolean => {
  const { session } = useChatView();
  const active = useThreadStore(session, (state) => state.runs.active != null);
  const lastId = useHost(session, (state) => state.messages.at(-1)?.id);
  const abacus = message.metadata?.abacus as
    | { coalescedIds?: string[] }
    | undefined;
  return (
    active &&
    message.role === "assistant" &&
    (message.id === lastId || abacus?.coalescedIds?.includes(lastId!) === true)
  );
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

/**
 * The route's decoration of one message (03-bots §11.3), or none. Sessions
 * decorate from the message's own turn, so only that turn's changes re-render
 * the row; the bot skin's gap stamps and feedback look across the thread.
 */
const useDecoration = (message: UIMessage): MessageDecoration | null => {
  const { session, slots, skin } = useChatView();
  const decorate = slots.decorateMessage;
  const narrow = skin === "session";
  const window = useHost(
    session,
    (state): TurnWindow =>
      decorate == null
        ? NO_WINDOW
        : narrow
          ? turnWindow(state.messages, message.id)
          : { items: state.messages, last: true },
    sameTurnWindow
  );
  const runActive = useThreadStore(
    session,
    (state) => state.runs.active != null
  );
  if (decorate == null) return null;
  const messages = narrow ? session.hostStore.state.messages : window.items;
  return decorate(message, {
    messages,
    index: messageIndexOf(messages, message.id),
    runActive,
  });
};

const NO_WINDOW: TurnWindow = { items: [], last: false };

/**
 * The assistant turn this row closes: the prose of every assistant message
 * since the last user message, when this row is the turn's last (no other
 * assistant message follows before the next user message, or the end) and
 * the turn is finished. Otherwise none, so a turn carries exactly one row.
 */
export const turnEndOf = (
  messages: readonly UIMessage[],
  message: UIMessage,
  runActive: boolean
): { text: string; id: string } | null => {
  if (message.role !== "assistant") return null;
  const index = messageIndexOf(messages, message.id);
  if (index < 0) return null;
  const folded = new Set(coalescedIds(message));
  let next = index + 1;
  while (
    next < messages.length &&
    (folded.has(messages[next]!.id) || messages[next]!.role === "system")
  )
    next++;
  const following = messages[next];
  if (following?.role === "assistant") return null;
  if (following == null && runActive) return null;
  let start = index;
  while (start > 0 && messages[start - 1]!.role !== "user") start--;
  const text = messages
    .slice(start, index + 1)
    .filter((item) => item.role === "assistant")
    .map((item) =>
      item.parts
        .filter(
          (part) =>
            part.type === "text" &&
            (part as { metadata?: { abacus?: { kind?: string } } }).metadata
              ?.abacus?.kind == null
        )
        .map((part) => (part as { content: string }).content)
        .join("")
    )
    .filter((chunk) => chunk.trim() !== "")
    .join("\n\n");
  return { text, id: message.id };
};

type Part = UIMessage["parts"][number];

const isPlanCard = (part: Part): boolean =>
  part.type === "tool-call" && isPaidFeatureTool(part.name);

/**
 * Where a turn's plan cards show: paid_feature is called before the reply,
 * yet its card reads after it, under the reply's buttons. Only the turn's
 * last row shows them, all of them, last; a row a later row of its turn
 * follows (`carried`) shows none. Both skins draw them this way.
 */
export const turnPlanCards = (
  messages: readonly UIMessage[],
  message: UIMessage
): { carried: boolean; cards: Part[] } => {
  const none = { carried: false, cards: [] };
  if (message.role !== "assistant") return none;
  const index = messageIndexOf(messages, message.id);
  if (index < 0) return none;
  const folded = new Set(coalescedIds(message));
  let next = index + 1;
  while (
    next < messages.length &&
    (folded.has(messages[next]!.id) || messages[next]!.role === "system")
  )
    next++;
  if (messages[next]?.role === "assistant") return { carried: true, cards: [] };
  let start = index;
  while (start > 0 && messages[start - 1]!.role !== "user") start--;
  const cards = messages
    .slice(start, next)
    .filter((item) => item.role === "assistant")
    .flatMap((item) => item.parts.filter(isPlanCard));
  return { carried: false, cards };
};

const useTurnPlanCards = (message: UIMessage) => {
  const { session } = useChatView();
  return useHost(
    session,
    (state) => turnPlanCards(state.messages, message),
    (a, b) =>
      a.carried === b.carried &&
      a.cards.length === b.cards.length &&
      a.cards.every((card, index) => card === b.cards[index])
  );
};

/** The message without its plan cards, which `PlanCards` draws instead. */
const withoutPlanCards = (message: UIMessage): UIMessage => {
  const calls = new Set(
    message.parts.filter(isPlanCard).map((part) => (part as { id: string }).id)
  );
  if (calls.size === 0) return message;
  return {
    ...message,
    parts: message.parts.filter(
      (part) =>
        !isPlanCard(part) &&
        !(part.type === "tool-result" && calls.has(part.toolCallId))
    ),
  };
};

const PlanCards = ({ cards }: { cards: readonly Part[] }) =>
  cards.map((card) =>
    card.type === "tool-call" ? (
      <PaidFeatureToolCard key={card.id} part={card as never} />
    ) : null
  );

const useTurnEnd = (
  message: UIMessage
): { text: string; id: string } | null => {
  const { session } = useChatView();
  const runActive = useThreadStore(
    session,
    (state) => state.runs.active != null
  );
  return useHost(
    session,
    (state) => turnEndOf(state.messages, message, runActive),
    (a, b) => a?.text === b?.text && a?.id === b?.id
  );
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
  const plan = useTurnPlanCards(message);
  const visible = botVisibleMessage(message, messages, runActive);
  if (visible !== message) return <BotUI.Message message={visible} />;
  const bare = withoutPlanCards(message);
  if (bare !== message) return <BotUI.Message message={bare} />;
  if (
    (isEmptyAssistant(message) && plan.cards.length === 0) ||
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
      value={{
        id: message.id,
        role: "assistant",
        streaming,
        message,
        feedback: decoration?.actions,
      }}
    >
      <MessageActions message={message} feedback={decoration?.actions}>
        <div
          className="flex flex-col items-start gap-1.5"
          data-role="assistant"
        >
          {decoration?.before}
          {message.parts.some((part) => part.type === "subagent") ? (
            <StepControls side="earlier" />
          ) : null}
          <PartsView />
          {message.parts.some((part) => part.type === "subagent") ? (
            <StepControls side="more" />
          ) : null}
          <PlanCards cards={plan.cards} />
          <Credits message={message} />
          {decoration?.after}
        </div>
      </MessageActions>
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

const RUN_ICONS = {
  Read: Eye,
  Edit: SquarePen,
  Command: Terminal,
  CodeSearch: Search,
  WebSearch: Globe,
  Browser: Compass,
  Mcp: Plug,
  Plan: ListChecks,
  Ask: MessageCircleQuestionMark,
  Subagent: Bot,
  Present: PackageCheck,
  Create: Sparkles,
  Other: Wrench,
  mixed: Hammer,
} as const;

type ToolCall = Extract<UIMessage["parts"][number], { type: "tool-call" }>;
type ToolResult = Extract<UIMessage["parts"][number], { type: "tool-result" }>;

/**
 * Every consecutive tool call, of any kind, is one run. It stays closed unless
 * the person opens it; while it works the header says so with a shimmer. A
 * failed step is not counted: the agent handles it and its reply says what matters.
 */
const ToolRun = ({
  calls,
  results,
  streaming,
  summary,
  children,
}: {
  calls: ToolCall[];
  results: ReadonlyMap<string, ToolResult>;
  streaming: boolean;
  /** The server's own summary, when it made this run whole. */
  summary: string | undefined;
  children: ReactNode;
}) => {
  const { t, i18n } = useTranslation();
  const { session, threadId } = useChatView();
  const scope = useSubagentScope();
  // Keyed by the run's first call, so the disclosure survives a remount.
  const [open, setOpen] = useRunOpen(
    threadId,
    `${scope ?? ""}\0${calls[0]?.id ?? ""}`
  );
  // A call the person must approve is waiting, not running.
  const needsYou = useThreadStore(session, (state) =>
    calls.reduce(
      (count, call) =>
        count +
        (!results.has(call.id) && descriptorFor(state, scope, call.id) != null
          ? 1
          : 0),
      0
    )
  );
  const pending = calls.filter(
    (call) => !results.has(call.id) && call.state !== "error"
  ).length;
  const running = streaming && pending > needsYou;
  const stopped = calls.filter(
    (call) => results.get(call.id)?.outcome === "cancelled"
  ).length;
  const refused = calls.filter(
    (call) => results.get(call.id)?.outcome === "denied"
  ).length;
  const runCalls = calls.map((call) => ({
    name: call.name,
    input: toolInput(call, parsePartialJSON),
  }));
  const label =
    (!running ? summary : undefined) ??
    joinLabels(
      toolRunCounts(runCalls).map(([action, count]) =>
        t(`chat.tool.summary${action}${running ? "Active" : ""}`, { count })
      ),
      i18n.language
    );
  const Icon = RUN_ICONS[toolRunKind(runCalls)];
  const liveCall = running
    ? calls.findLast((call) => call.name === "bash" && !results.has(call.id))
    : undefined;
  return (
    <Collapsible
      data-slot="tool-group"
      data-running={running ? "" : undefined}
      data-needs-you={needsYou > 0 ? "" : undefined}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger className="group/run text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-7 w-full items-center gap-2 rounded-md text-xs transition-colors outline-none focus-visible:ring-2">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className={cn("min-w-0 truncate", running && "shimmer")}>
          {label}
        </span>
        {needsYou > 0 ? (
          <span
            data-slot="run-attention"
            className="flex shrink-0 items-center gap-1 text-[var(--chat-status-attention)]"
          >
            <CircleAlert aria-hidden className="size-3" />
            {t("chat.tool.summaryNeedsYou", { count: needsYou })}
          </span>
        ) : null}
        {stopped > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {t("chat.tool.summaryStopped", { count: stopped })}
          </span>
        ) : null}
        {refused > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {t("chat.tool.summaryRefused", { count: refused })}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 transition-transform duration-150 group-data-[panel-open]/run:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      {!open && liveCall != null ? (
        <RunLiveOutput part={liveCall} result={results.get(liveCall.id)} />
      ) : null}
      <CollapsibleContent
        data-slot="tool-cluster"
        className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

const GroupedParts = ({ message }: { message: UIMessage }) => {
  const SessionUI = useKitParts();
  const { streaming } = useMessageScope();
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
  const plan = useTurnPlanCards(message);
  const results = new Map<string, ToolResult>();
  for (const part of selectedMessage.parts)
    if (part.type === "tool-result") results.set(part.toolCallId, part);
  return (
    <SessionUI.Message message={selectedMessage}>
      {(parts) => {
        // Only a call that is not a tool call (prose, a sub-agent card, ...)
        // ends a run; the server's own groups never split one.
        type Item = (typeof parts)[number];
        const blocks: Array<
          { run: false; part: Item } | { run: true; parts: Item[] }
        > = [];
        // Reasoning between two calls rides inside their run, in order;
        // reasoning with no call after it stays where it was.
        let held: Item[] = [];
        const flush = () => {
          for (const part of held) blocks.push({ run: false, part });
          held = [];
        };
        for (const part of parts) {
          if (part.part.type === "tool-result" || isBlankText(part.part))
            continue;
          if (isThinking(part.part)) {
            held.push(part);
            continue;
          }
          if (part.part.type !== "tool-call") {
            flush();
            blocks.push({ run: false, part });
            continue;
          }
          if (
            visibleUnits != null &&
            !visibleUnits.has(`${scope}\0${part.part.id}`)
          )
            continue;
          // Drawn after the reply and its buttons (turnPlanCards).
          if (isPaidFeatureTool(part.part.name)) continue;
          // A card the reply points at (a place in the app), and a memory
          // change, stand on their own: folded into a closed run, nobody saw
          // them.
          if (
            isBotHelpTool(part.part.name) ||
            isSuggestTasksTool(part.part.name) ||
            isMemoryTool(part.part.name) ||
            isHandOffTool(part.part.name)
          ) {
            flush();
            blocks.push({ run: false, part });
            continue;
          }
          const previous = blocks.at(-1);
          if (previous?.run) {
            previous.parts.push(...held, part);
            held = [];
          } else {
            flush();
            blocks.push({ run: true, parts: [part] });
          }
        }
        flush();
        const rendered = blocks.map((block) => {
          if (!block.run)
            return (
              <SessionUI.Part
                key={indexed.parts.get(block.part.part)}
                part={block.part}
              />
            );
          const callParts = block.parts.filter(
            (p) => p.part.type === "tool-call"
          );
          const calls = callParts.map((p) => p.part as ToolCall);
          const ids = new Set(
            callParts.map(
              (p) => indexed.groupIds.get(indexed.parts.get(p.part)!) ?? null
            )
          );
          const groupId = ids.size === 1 ? [...ids][0] : null;
          return (
            <ToolRun
              key={indexed.parts.get(block.parts[0]!.part)}
              calls={calls}
              results={results}
              streaming={streaming}
              summary={
                groupId == null
                  ? undefined
                  : indexed.groups.get(groupId)?.summary
              }
            >
              {block.parts.map((part) => (
                <SessionUI.Part
                  key={indexed.parts.get(part.part)}
                  part={part}
                />
              ))}
            </ToolRun>
          );
        });
        return (
          <>
            {rendered}
            <PlanCards cards={plan.cards} />
          </>
        );
      }}
    </SessionUI.Message>
  );
};

export const SessionMessage = ({ message }: MessageProps<unknown>) => {
  const decoration = useDecoration(message);
  const streaming = useStreaming(message);
  const turn = useTurnEnd(message);
  if (isEmptyAssistant(message)) return null;
  // What the route draws around the user's words: a report, a link to the chat this one continues.
  if (message.role === "user")
    return (
      <>
        {decoration?.before}
        <UserMessage message={message} tint={false} />
        {decoration?.after}
      </>
    );
  const grouped = (
    message.metadata as { abacus?: { segments?: Loose[] } } | undefined
  )?.abacus?.segments?.some((segment) => segment.type === "tool_group");
  return (
    <MessageScope
      value={{ id: message.id, role: "assistant", streaming, message }}
    >
      <div
        // Part spacing lives in chat.css (assistant-parts): prose hugs its
        // tool group, the group leaves room before what follows.
        className="flex flex-col"
        data-slot="assistant-parts"
        data-role="assistant"
        data-message-target={message.id}
        data-grouped={grouped ? "" : undefined}
      >
        {decoration?.before}
        <StepControls side="earlier" />
        <GroupedParts message={message} />
        <StepControls side="more" />
        <Credits message={message} />
        {decoration?.after}
        {turn != null && !streaming ? (
          <TurnActions text={turn.text} feedback={decoration?.actions} />
        ) : null}
      </div>
    </MessageScope>
  );
};
