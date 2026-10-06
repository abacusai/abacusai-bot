import type { AgentMode } from "@abacus-ai/contract/agent-types";
/**
 * The composer (spec 02 §8): a compound around the draft store. The bot pill
 * grows into a box on focus, text or attachments; the session box has two
 * rows; the mini (FullView) pill grows on focus. Submit routing is §8.3:
 * send (outbox admission), enqueue while busy, or blocked. Keyboard is
 * element-level, except Stop (`Mod+.`), the one global shortcut.
 */
import { Store, useSelector } from "@tanstack/react-store";
import { ArrowUp, FileText, Folder, Mic, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  use,
  useId,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { isNotFound } from "#renderer/data/ai";
import { isRpcError } from "#renderer/data/query-client";
import { cn } from "#renderer/lib/cn";
import { useMotionPreference } from "#renderer/lib/motion";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { useConnectedDictation } from "#renderer/lib/voice/use-dictation";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "#renderer/ui/attachment";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { useChatView } from "../kit/context";
import { composeReply, ReplyQuote } from "../kit/reply";
import {
  composerChildren,
  composerMorph,
  composerReveal,
  composerSurface,
} from "../motion";
import { routeSubmit } from "../runtime/send";
import {
  questionPending,
  useBusy,
  useHost,
  useThreadStore,
} from "../store/selectors";
import {
  addFiles,
  addPaths,
  formatSize,
  removeAttachment,
} from "./attachments";
import { ModeChip, ModelChip } from "./chips";
import {
  clearDraft,
  draftStore,
  draftRevision,
  restoreDraft,
  EMPTY_DRAFT,
  updateDraft,
  type Draft,
} from "./draft-store";
import { setQueueEditing } from "./queue-editing";
import { TriggerMenu, triggerAt, type TriggerState } from "./triggers";

/** The composer's max height before it scrolls (today's `COMPOSER_MAX_HEIGHT`). */
const COMPOSER_MAX_HEIGHT = 200;

/**
 * The surface's corner radius per shape (ComposerStates): the 48 px pill,
 * the bot's typing box and the session box. A `style`, never a class, so
 * motion's layout projection corrects it mid-morph instead of stretching it
 * with the surface's scale.
 */
export const SURFACE_RADIUS = { pill: 24, bot: 22, session: 20 } as const;

/**
 * A child of the surface that must keep its size while the surface morphs
 * (icons, chips, buttons, text): `layout="position"` lets motion counter the
 * surface's scale and slide the child into place, so only the surface
 * itself animates its shape.
 */
const Still = ({
  layout,
  className,
  children,
}: {
  layout: "position" | false;
  className?: string;
  children: ReactNode;
}) => (
  <motion.div layout={layout} data-layout="position" className={className}>
    {children}
  </motion.div>
);

type ComposerState =
  | "resting"
  | "focused"
  | "typing"
  | "busy"
  | "blocked"
  | "dictating";

interface ComposerContextValue {
  threadId: string;
  draft: Draft;
  expanded: boolean;
  busy: boolean;
  state: ComposerState;
  submit(): void;
  stop(): void;
  cancelling: boolean;
  error: string | null;
}

const ComposerContext = createContext<ComposerContextValue | null>(null);
const useComposer = (): ComposerContextValue => {
  const value = use(ComposerContext);
  if (value == null)
    throw new Error("chat: a composer part rendered outside Composer.Root");
  return value;
};

const focusedThreads = new Store<ReadonlySet<string>>(new Set<string>());
const modelMenus = new Store<ReadonlySet<string>>(new Set<string>());
const setModelMenu = (threadId: string, open: boolean): void => {
  modelMenus.setState((state) => {
    const next = new Set(state);
    if (open) next.add(threadId);
    else next.delete(threadId);
    return next;
  });
};
const setThreadFocus = (threadId: string, focused: boolean): void => {
  focusedThreads.setState((state) => {
    if (state.has(threadId) === focused) return state;
    const next = new Set(state);
    if (focused) next.add(threadId);
    else next.delete(threadId);
    return next;
  });
};
/** The bot pill is expanded with focus or a non-empty draft (§8.7, 03 §16.3). */
export const useComposerExpanded = (threadId: string): boolean => {
  const focused = useSelector(focusedThreads, (state) => state.has(threadId));
  const drafted = useSelector(draftStore, (state) => {
    const draft = state[threadId];
    return (
      draft != null &&
      (draft.text !== "" ||
        draft.attachments.length > 0 ||
        draft.replyTo != null)
    );
  });
  const menu = useSelector(modelMenus, (state) => state.has(threadId));
  return focused || drafted || menu;
};

const Attachments = () => {
  const { t } = useTranslation();
  const { threadId, draft } = useComposer();
  const pref = useMotionPreference();
  const morph = composerMorph(pref, threadId);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {draft.attachments.length === 0 ? null : (
        <motion.div
          key="attachments"
          data-slot="composer-attachments"
          data-layout="position"
          className="w-full"
          layout={morph.layout ? "position" : false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={composerReveal(pref)}
        >
          <AttachmentGroup className="scroll-fade-x">
            {draft.attachments.map((attachment) => (
              <Attachment
                key={attachment.id}
                className="w-56"
                data-state={attachment.state}
              >
                <AttachmentMedia>
                  {attachment.state === "uploading" ? (
                    <Spinner aria-hidden />
                  ) : attachment.preview != null ? (
                    <img
                      src={attachment.preview}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    <FileText aria-hidden />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{attachment.name}</AttachmentTitle>
                  <AttachmentDescription
                    className={cn(
                      attachment.state === "error" && "text-destructive"
                    )}
                  >
                    {attachment.state === "error"
                      ? (attachment.error ?? t("chat.composer.attachFailed"))
                      : [
                          attachment.name.split(".").at(-1)?.toUpperCase(),
                          formatSize(attachment.size),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentAction
                  aria-label={t("chat.composer.removeAttachment")}
                  onClick={() => removeAttachment(threadId, attachment.id)}
                >
                  <X aria-hidden />
                </AttachmentAction>
              </Attachment>
            ))}
          </AttachmentGroup>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const Attach = () => {
  const { t } = useTranslation();
  const { runtime, composer: config } = useChatView();
  const { threadId } = useComposer();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="secondary"
              size="icon-lg"
              aria-label={t("chat.composer.attach")}
              className="size-9 shrink-0 rounded-full"
            />
          }
        >
          <Plus aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem
            onClick={async () => {
              setError(null);
              try {
                const files = await runtime.host.pickFiles(
                  config.attachmentContext
                );
                if (files != null) addPaths(threadId, files);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            <FileText aria-hidden />
            {t("chat.composer.attachFiles")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              const folder = await runtime.host.pickFolder();
              if (folder != null) addPaths(threadId, [{ path: folder }]);
            }}
          >
            <Folder aria-hidden />
            {t("chat.composer.attachFolder")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

const Dictate = () => {
  const { t } = useTranslation();
  const { threadId } = useComposer();
  const voice = useConnectedDictation(threadId, (text) => {
    updateDraft(threadId, (draft) => ({
      ...draft,
      text: `${draft.text}${draft.text ? " " : ""}${text}`,
    }));
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={t(
              voice.state === "recording"
                ? "notch.listening.end"
                : "chat.composer.dictate"
            )}
            aria-pressed={voice.state === "recording"}
            disabled={
              voice.state === "starting" || voice.state === "transcribing"
            }
            onClick={() => {
              if (voice.state === "recording") void voice.end();
              else void voice.start();
            }}
            className="size-9 rounded-full"
          />
        }
      >
        <Mic aria-hidden />
      </TooltipTrigger>
      <TooltipContent>
        {t(
          voice.state === "error"
            ? "notch.listening.error"
            : "chat.composer.dictate"
        )}
      </TooltipContent>
    </Tooltip>
  );
};

const SendOrStop = () => {
  const { t } = useTranslation();
  const { skin, composer: config } = useChatView();
  const { draft, busy, submit, stop, cancelling } = useComposer();
  const hasText = draft.text.trim() !== "" || draft.attachments.length > 0;
  if (busy && !hasText)
    return (
      <Button
        size="icon-lg"
        aria-label={t("chat.composer.stop")}
        className="bg-foreground text-background hover:bg-foreground/90 size-9 rounded-full"
        onClick={stop}
        disabled={cancelling}
      >
        {cancelling ? (
          <Spinner aria-hidden />
        ) : (
          <span aria-hidden className="size-2.5 rounded-[2px] bg-current" />
        )}
      </Button>
    );
  return (
    <Button
      size="icon-lg"
      aria-label={busy ? t("chat.composer.queue") : t("chat.composer.send")}
      disabled={!hasText || !!config.blocked}
      className={cn(
        "size-9 rounded-full",
        skin === "bot" &&
          hasText &&
          "bg-[var(--bot-accent,var(--primary))] text-[var(--bot-accent-foreground,var(--primary-foreground))]",
        !hasText && "bg-secondary text-muted-foreground"
      )}
      onClick={submit}
    >
      <ArrowUp aria-hidden />
    </Button>
  );
};

/** The whole thread composer the chat view places in its input slot. */
export const ThreadComposer = () => {
  const { t } = useTranslation();
  const view = useChatView();
  const { session, threadId, skin, composer: config, runtime } = view;
  const draft = useSelector(
    draftStore,
    (state) => state[threadId] ?? EMPTY_DRAFT
  );
  const busy = useBusy(session, config.turnBusy === true);
  const hydrated = useHost(session, (state) => state.ready);
  const gone = useHost(session, (state) => state.notFound);
  const cancelling = useHost(session, (state) => state.cancelling);
  const question = useThreadStore(session, questionPending);
  const liveMode = useThreadStore(
    session,
    (state) => state.agent?.mode ?? null
  );
  const incarnation = useThreadStore(session, (state) => state.incarnation);
  const queue = useThreadStore(session, (state) => state.queue);
  const liveSkills = useThreadStore(session, (state) => state.skills);
  const skills =
    liveSkills.length > 0 ? liveSkills : (config.skillsBaseline ?? []);
  const focused = useSelector(focusedThreads, (state) => state.has(threadId));
  const setFocused = (value: boolean): void => setThreadFocus(threadId, value);
  const modelMenuOpen = useSelector(modelMenus, (state) => state.has(threadId));
  useEffect(
    () => () => {
      setThreadFocus(threadId, false);
      setModelMenu(threadId, false);
    },
    [threadId]
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState | null>(() =>
    triggerAt(draft.text, draft.text.length, {
      mentions: config.mentions != null,
      skills: skills.length > 0,
    })
  );
  const field = useRef<HTMLTextAreaElement>(null);
  const pref = useMotionPreference();
  const fieldId = useId();

  const hasDraft =
    draft.text !== "" || draft.attachments.length > 0 || draft.replyTo != null;
  const expanded =
    config.mode === "full" && skin === "session"
      ? true
      : focused ||
        hasDraft ||
        menuOpen ||
        modelMenuOpen ||
        config.dictating === true;
  const state: ComposerState =
    config.readOnly != null
      ? "blocked"
      : config.dictating === true
        ? "dictating"
        : busy
          ? "busy"
          : draft.text !== ""
            ? "typing"
            : focused
              ? "focused"
              : "resting";

  const submit = (): void => {
    if (config.blocked) {
      config.onBlocked?.();
      return;
    }
    const route = routeSubmit({
      text: draft.text,
      attachments: draft.attachments,
      busy,
      readOnly: config.readOnly != null || gone,
      questionPending: question,
      preStart: config.preStart === true,
      hydrated: hydrated || config.preStart === true,
      ...((draft.mode ?? config.defaultMode) != null
        ? { mode: draft.mode ?? config.defaultMode }
        : {}),
      ...(draft.model != null ? { model: draft.model } : {}),
      ...(config.fixedMode != null ? { fixedMode: config.fixedMode } : {}),
    });
    const composed =
      "text" in route
        ? composeReply(route.text, draft.replyTo, view.authorName)
        : null;
    setError(null);
    switch (route.kind) {
      case "noop":
        return;
      case "blocked":
        if (route.reason === "uploading")
          setError(t("chat.composer.uploading"));
        return;
      case "enqueue": {
        const saved = draft;
        clearDraft(threadId);
        const clearedRevision = draftRevision(threadId);
        runtime.queue
          .enqueue(threadId, composed!.text, composed!.userText)
          .catch(() => {
            restoreDraft(threadId, clearedRevision, saved);
            setError(t("chat.composer.queueFailed"));
          });
        return;
      }
      case "send": {
        const saved = draft;
        clearDraft(threadId);
        const clearedRevision = draftRevision(threadId);
        const restore = (message: string) => {
          restoreDraft(threadId, clearedRevision, saved);
          setError(message);
        };
        void config.history?.add(route.text);
        const admission = config.onSubmitEnvelope
          ? config
              .onSubmitEnvelope({
                runId: crypto.randomUUID(),
                messageId: crypto.randomUUID(),
                parts: [{ type: "text", content: composed!.text }],
                userText: composed!.userText,
                forwardedProps: {
                  ...route.forwardedProps,
                  model: config.model?.value ?? null,
                },
              })
              .then(() => ({ kind: "started" as const }))
          : session.submit(
              composed!.text,
              route.forwardedProps,
              composed!.userText
            );
        admission
          .then((result) => {
            if (result.kind === "rejected")
              restore(t("chat.composer.rejected"));
            else if (result.kind === "stale")
              restoreDraft(threadId, clearedRevision, saved);
            else config.onFirstSend?.(route.text);
          })
          .catch((thrown: unknown) => {
            if (isRpcError(thrown) && thrown.code === "CONFLICT") {
              void runtime.queue
                .enqueue(threadId, composed!.text, composed!.userText)
                .catch(() => restore(t("chat.composer.queueFailed")));
              return;
            }
            if (isNotFound(thrown)) {
              restore(t("chat.composer.gone"));
              return;
            }
            restore(t("chat.composer.notReady"));
          });
        return;
      }
    }
  };
  const stop = (): void => void session.cancel().catch(() => {});

  const setText = (text: string, caret: number | null) => {
    updateDraft(threadId, (current) => ({ ...current, text }));
    setTrigger(
      caret == null
        ? null
        : triggerAt(text, caret, {
            mentions: config.mentions != null,
            skills: skills.length > 0,
          })
    );
  };

  const historyIndex = useRef(-1);
  const historyItems = useRef<string[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (
      event.key === "Enter" &&
      (mod || (!event.shiftKey && trigger == null))
    ) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "ArrowUp" && draft.text === "" && queue.length > 0) {
      event.preventDefault();
      setQueueEditing(threadId, queue.at(-1)!.id);
      return;
    }
    if (
      config.history &&
      queue.length === 0 &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      event.currentTarget.selectionStart === 0
    ) {
      event.preventDefault();
      void config.history.list().then((items) => {
        historyItems.current = items;
        historyIndex.current = Math.max(
          -1,
          Math.min(
            items.length - 1,
            historyIndex.current + (event.key === "ArrowUp" ? 1 : -1)
          )
        );
        setText(
          historyIndex.current < 0
            ? ""
            : (items[items.length - 1 - historyIndex.current] ?? ""),
          null
        );
      });
      return;
    }
    if (event.key === "Escape") {
      if (trigger != null) {
        event.preventDefault();
        setTrigger(null);
        return;
      }
      if (draft.replyTo) {
        event.preventDefault();
        updateDraft(threadId, (current) => ({
          ...current,
          replyTo: undefined,
        }));
        return;
      }
      event.currentTarget.blur();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(
      threadId,
      files,
      runtime.host,
      config.attachmentsBase,
      config.attachmentContext
    );
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(
      threadId,
      files,
      runtime.host,
      config.attachmentsBase,
      config.attachmentContext
    );
  };

  // The 800 px band and phones (chat-kit W800): the model chip is an icon button.
  const narrow = useMediaQuery("(max-width: 899px)");
  // Cross-route morph (shared-element.ts): the surface is `composer` on the
  // pages whose composers pair up. Unconditional: it sits above the early
  // returns, and a read-only page carries no name (nothing to morph into).
  const sharedStyle = useSharedElementName(
    config.sharedElement && config.readOnly == null && !gone
      ? "composer"
      : null,
    "composer"
  );

  if (config.readOnly != null || gone)
    return (
      <div
        className="text-muted-foreground flex min-h-13 items-center gap-3 rounded-[20px] bg-[var(--chat-surface-2)] px-4 py-3 text-sm"
        data-slot="composer-readonly"
        role="status"
      >
        <span className="flex-1">
          {config.readOnly?.reason ?? t("chat.composer.gone")}
        </span>
        {config.readOnly?.action}
      </div>
    );

  const placeholder = busy
    ? skin === "bot"
      ? t("chat.composer.busyBot")
      : t("chat.composer.busySession")
    : config.mode === "mini" && !expanded
      ? t("chat.composer.mini")
      : config.placeholder;

  const surfaceTransition = composerSurface(pref);
  const childFade = composerChildren(pref);
  const morph = composerMorph(pref, threadId);
  const reveal = composerReveal(pref);
  const still = morph.layout ? ("position" as const) : false;
  const radius = expanded
    ? skin === "session"
      ? SURFACE_RADIUS.session
      : SURFACE_RADIUS.bot
    : SURFACE_RADIUS.pill;

  const value: ComposerContextValue = {
    threadId,
    draft,
    expanded,
    busy,
    state,
    submit,
    stop,
    cancelling,
    error,
  };
  const mode = config.showModeChip ? (
    <ModeChip
      availableModes={config.availableModes}
      value={liveMode}
      draft={draft.mode ?? config.defaultMode}
      live={incarnation != null}
      onDraft={(next: AgentMode) =>
        updateDraft(threadId, (current) => ({ ...current, mode: next }))
      }
      {...(config.setMode != null ? { setMode: config.setMode } : {})}
      onOpenChange={setMenuOpen}
      onRevert={() => setError(t("chat.composer.modeFailed"))}
    />
  ) : null;
  const model =
    config.model != null ? (
      <ModelChip
        binding={config.model}
        compact={narrow}
        onUseLocalModel={config.onUseLocalModel}
        onOpenChange={(open) => setModelMenu(threadId, open)}
      />
    ) : null;

  return (
    <ComposerContext value={value}>
      <div
        className="flex flex-col"
        data-slot="composer"
        data-tour="composer"
        data-state={state}
        data-expanded={expanded ? "" : undefined}
        onKeyDown={(event) => {
          // Escape cancels the reply from anywhere in the composer, but not
          // from a portaled popover (a chip menu, a tooltip) closing itself.
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            draft.replyTo &&
            event.currentTarget.contains(event.target as Node)
          ) {
            event.preventDefault();
            updateDraft(threadId, (current) => ({
              ...current,
              replyTo: undefined,
            }));
          }
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setFocused(false);
        }}
      >
        {trigger != null ? (
          <TriggerMenu
            trigger={trigger}
            field={field}
            skills={skills}
            mentions={config.mentions}
            onPick={(insert) => {
              const next =
                draft.text.slice(0, trigger.start) +
                insert +
                draft.text.slice(trigger.end);
              setText(next, null);
              field.current?.focus();
            }}
            onClose={() => setTrigger(null)}
          />
        ) : null}
        <label htmlFor={fieldId} className="sr-only">
          {config.placeholder}
        </label>
        <motion.div
          {...morph}
          transition={surfaceTransition}
          onDragOver={(event: DragEvent<HTMLDivElement>) =>
            event.preventDefault()
          }
          onDrop={onDrop}
          style={{ ...sharedStyle, borderRadius: radius }}
          data-slot="composer-surface"
          data-layout={morph.layout ? "layout" : undefined}
          data-radius={radius}
          className={cn(
            "relative z-10 flex flex-col bg-[var(--chat-surface)]",
            // ComposerStates: the pill is 48 px; the typing box is the text
            // area over the toolbar row with 8 px under it, nothing else.
            expanded
              ? "gap-2 ps-3 pe-2 pt-3 pb-2"
              : "min-h-12 flex-row items-center gap-2 px-2",
            // The session box (100 px, 14/8/8/16): the text area takes the
            // spare height, so the toolbar sits on the box's bottom edge.
            skin === "session" &&
              expanded &&
              "phone:border phone:border-foreground/[0.08] phone:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)] min-h-[100px] ps-4 pt-3.5 [&>textarea]:flex-1"
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {draft.replyTo ? (
              <motion.div
                key="reply"
                data-slot="reply-preview"
                data-layout="position"
                className="w-full"
                layout={morph.layout ? "position" : false}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reveal}
              >
                <ReplyQuote
                  target={draft.replyTo}
                  onCancel={() => {
                    updateDraft(threadId, (current) => ({
                      ...current,
                      replyTo: undefined,
                    }));
                    field.current?.focus();
                  }}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
          {expanded ? <Attachments /> : null}
          {expanded ? null : (
            <Still layout={still} className="flex shrink-0">
              <Attach />
            </Still>
          )}
          <motion.textarea
            layout={still}
            data-layout="position"
            ref={field}
            data-continuity-id={`composer:${threadId}`}
            id={fieldId}
            aria-label={config.placeholder}
            title={
              config.attachmentsBase == null
                ? t("chat.composer.pasteUnavailable")
                : undefined
            }
            value={draft.text}
            placeholder={placeholder}
            rows={1}
            onChange={(event) =>
              setText(event.target.value, event.target.selectionStart)
            }
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            style={
              {
                maxHeight: COMPOSER_MAX_HEIGHT,
                fieldSizing: "content",
              } as React.CSSProperties
            }
            className={cn(
              "placeholder:text-muted-foreground min-w-0 resize-none bg-transparent text-sm leading-5 outline-none",
              expanded ? "w-full px-1" : "flex-1 py-2"
            )}
          />
          {expanded ? (
            <motion.div
              className="flex items-center gap-1.5"
              layout={still}
              data-layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={childFade}
            >
              <Attach />
              {mode}
              <span className="flex-1" />
              {model}
              <Dictate />
              <SendOrStop />
            </motion.div>
          ) : (
            <Still layout={still} className="flex shrink-0 items-center gap-2">
              <Dictate />
              <SendOrStop />
            </Still>
          )}
        </motion.div>
        {error != null ? (
          <p role="alert" className="text-destructive px-4 pt-1.5 text-xs">
            {error}
          </p>
        ) : null}
        {view.slots.composerContext != null ? (
          // The context bar (repo · branch · worktree) hangs under the box
          // as its own 48 px strip: inset 12 px, bottom corners 14 px, tucked
          // 16 px under the box with the same 16 px of top padding, so it
          // reads as attached. Phones stack it plainly below.
          <div
            className="phone:mx-0 phone:mt-2 phone:min-h-0 phone:rounded-none phone:bg-transparent phone:px-1 phone:pt-0 mx-3 -mt-4 flex min-h-12 flex-col justify-center rounded-b-[14px] bg-[var(--chat-surface-2)] px-3.5 pt-4 text-[13px]"
            data-slot="composer-context"
          >
            {view.slots.composerContext}
          </div>
        ) : null}
      </div>
    </ComposerContext>
  );
};

/** Compound parts for pages that compose their own composer (§8.1). */
