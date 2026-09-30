/**
 * The composer (spec 02 §8): a compound around the draft store. The bot pill
 * grows into a box on focus, text or attachments; the session box has two
 * rows; the mini (FullView) pill grows on focus. Submit routing is §8.3:
 * send (outbox admission), enqueue while busy, or blocked. Keyboard is
 * element-level, except Stop (`Mod+.`), the one global shortcut.
 */
import { useHotkey } from "@tanstack/react-hotkeys";
import { useSelector } from "@tanstack/react-store";
import { ArrowUp, FileText, Folder, Mic, Plus, X } from "lucide-react";
import { motion } from "motion/react";
import {
  createContext,
  use,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";
import { useMotionPreference } from "#next/lib/motion";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "#next/ui/attachment";
import { Button } from "#next/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "#next/ui/dropdown-menu";
import { Spinner } from "#next/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "#next/ui/tooltip";

import { isNotFound, rpcCode } from "#next/data/ai";

import type { AgentMode } from "#shared/agent-types";

import { useChatView } from "../kit/context";
import { composerChildren, composerSurface } from "../motion";
import { routeSubmit } from "../runtime/send";
import { questionPending, useBusy, useHost, useThreadStore } from "../store/selectors";
import { addFiles, addPaths, formatSize, removeAttachment } from "./attachments";
import { ModeChip, ModelChip } from "./chips";
import { clearDraft, draftStore, EMPTY_DRAFT, updateDraft, type Draft } from "./draft-store";
import { setQueueEditing } from "./queue-editing";
import { TriggerMenu, triggerAt, type TriggerState } from "./triggers";

/** The composer's max height before it scrolls (today's `COMPOSER_MAX_HEIGHT`). */
export const COMPOSER_MAX_HEIGHT = 200;

type ComposerState = "resting" | "focused" | "typing" | "busy" | "blocked";

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
  if (value == null) throw new Error("chat: a composer part rendered outside Composer.Root");
  return value;
};

/** Derived, not stored (§8.7): the bot pill is "open" with focus or a draft. */
export const useComposerExpanded = (threadId: string): boolean =>
  useSelector(draftStore, (state) => {
    const draft = state[threadId];
    return draft != null && (draft.text !== "" || draft.attachments.length > 0);
  });

const Attachments = () => {
  const { t } = useTranslation();
  const { threadId, draft } = useComposer();
  if (draft.attachments.length === 0) return null;
  return (
    <AttachmentGroup className="scroll-fade-x">
      {draft.attachments.map((attachment) => (
        <Attachment key={attachment.id} className="w-56" data-state={attachment.state}>
          <AttachmentMedia>
            {attachment.state === "uploading" ? (
              <Spinner aria-hidden />
            ) : attachment.preview != null ? (
              <img src={attachment.preview} alt="" className="size-full object-cover" />
            ) : (
              <FileText aria-hidden />
            )}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{attachment.name}</AttachmentTitle>
            <AttachmentDescription className={cn(attachment.state === "error" && "text-destructive")}>
              {attachment.state === "error"
                ? (attachment.error ?? t("chat.composer.attachFailed"))
                : [attachment.name.split(".").at(-1)?.toUpperCase(), formatSize(attachment.size)].filter(Boolean).join(", ")}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentAction aria-label={t("chat.composer.removeAttachment")} onClick={() => removeAttachment(threadId, attachment.id)}>
            <X aria-hidden />
          </AttachmentAction>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
};

const Attach = () => {
  const { t } = useTranslation();
  const { runtime } = useChatView();
  const { threadId } = useComposer();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="secondary" size="icon-lg" aria-label={t("chat.composer.attach")} className="size-9 shrink-0 rounded-full" />}
      >
        <Plus aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem
          onClick={async () => {
            const files = await runtime.host.pickFiles();
            if (files != null) addPaths(threadId, files);
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
  );
};

const Dictate = () => {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t("chat.composer.dictate")} className="size-9 rounded-full" />}>
        <Mic aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{t("chat.composer.dictateSoon")}</TooltipContent>
    </Tooltip>
  );
};

const SendOrStop = () => {
  const { t } = useTranslation();
  const { skin } = useChatView();
  const { draft, busy, submit, stop, cancelling } = useComposer();
  const hasText = draft.text.trim() !== "" || draft.attachments.length > 0;
  if (busy && !hasText)
    return (
      <Button
        size="icon-lg"
        aria-label={t("chat.composer.stop")}
        className="size-9 rounded-full bg-foreground text-background hover:bg-foreground/90"
        onClick={stop}
        disabled={cancelling}
      >
        {cancelling ? <Spinner aria-hidden /> : <span aria-hidden className="size-2.5 rounded-[2px] bg-current" />}
      </Button>
    );
  return (
    <Button
      size="icon-lg"
      aria-label={busy ? t("chat.composer.queue") : t("chat.composer.send")}
      disabled={!hasText}
      className={cn(
        "size-9 rounded-full",
        skin === "bot" && hasText && "bg-[var(--bot-accent,var(--primary))] text-[var(--bot-accent-foreground,var(--primary-foreground))]",
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
  const draft = useSelector(draftStore, (state) => state[threadId] ?? EMPTY_DRAFT);
  const busy = useBusy(session, config.turnBusy === true);
  const hydrated = useHost(session, (state) => state.ready);
  const gone = useHost(session, (state) => state.notFound);
  const cancelling = useHost(session, (state) => state.cancelling);
  const question = useThreadStore(session, questionPending);
  const liveMode = useThreadStore(session, (state) => state.agent?.mode ?? null);
  const incarnation = useThreadStore(session, (state) => state.incarnation);
  const queue = useThreadStore(session, (state) => state.queue);
  const skills = useThreadStore(session, (state) => state.skills);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pref = useMotionPreference();
  const fieldId = useId();

  const hasDraft = draft.text !== "" || draft.attachments.length > 0;
  const expanded =
    config.mode === "full" && skin === "session" ? !menuOpen : focused || hasDraft;
  const state: ComposerState = config.readOnly != null ? "blocked" : busy ? "busy" : draft.text !== "" ? "typing" : focused ? "focused" : "resting";

  const submit = (): void => {
    const route = routeSubmit({
      text: draft.text,
      attachments: draft.attachments,
      busy,
      readOnly: config.readOnly != null || gone,
      questionPending: question,
      preStart: config.preStart === true,
      hydrated,
      ...(draft.mode != null ? { mode: draft.mode } : {}),
      ...(draft.model != null ? { model: draft.model } : {}),
      ...(config.fixedMode != null ? { fixedMode: config.fixedMode } : {}),
    });
    setError(null);
    switch (route.kind) {
      case "noop":
        return;
      case "blocked":
        if (route.reason === "uploading") setError(t("chat.composer.uploading"));
        return;
      case "enqueue": {
        const saved = draft;
        clearDraft(threadId);
        runtime.queue.enqueue(threadId, route.text).catch(() => {
          updateDraft(threadId, () => saved);
          setError(t("chat.composer.queueFailed"));
        });
        return;
      }
      case "send": {
        const saved = draft;
        clearDraft(threadId);
        const restore = (message: string) => {
          updateDraft(threadId, () => saved);
          setError(message);
        };
        session
          .submit(route.text, route.forwardedProps)
          .then((result) => {
            if (result.kind === "rejected") restore(t("chat.composer.rejected"));
            else if (result.kind === "stale") updateDraft(threadId, () => saved);
            else config.onFirstSend?.(route.text);
          })
          .catch((thrown: unknown) => {
            if (rpcCode(thrown) === "CONFLICT") {
              void runtime.queue.enqueue(threadId, route.text);
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

  useHotkey(
    "Mod+." as never,
    (event) => {
      event.preventDefault();
      stop();
    },
    { ignoreInputs: false, enabled: busy && view.focused }
  );

  const setText = (text: string, caret: number | null) => {
    updateDraft(threadId, (current) => ({ ...current, text }));
    setTrigger(caret == null ? null : triggerAt(text, caret, { mentions: config.mentions != null, skills: skills.length > 0 }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && (mod || (!event.shiftKey && trigger == null))) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "ArrowUp" && draft.text === "" && queue.length > 0) {
      event.preventDefault();
      setQueueEditing(threadId, queue.at(-1)!.id);
      return;
    }
    if (event.key === "Escape") {
      if (trigger != null) {
        event.preventDefault();
        setTrigger(null);
        return;
      }
      event.currentTarget.blur();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(threadId, files, runtime.host, config.attachmentsBase);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(threadId, files, runtime.host, config.attachmentsBase);
  };

  if (config.readOnly != null || gone)
    return (
      <div className="flex min-h-13 items-center gap-3 rounded-[20px] bg-[var(--chat-surface-2)] px-4 py-3 text-sm text-muted-foreground" data-slot="composer-readonly" role="status">
        <span className="flex-1">{config.readOnly?.reason ?? t("chat.composer.gone")}</span>
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

  const value: ComposerContextValue = { threadId, draft, expanded, busy, state, submit, stop, cancelling, error };
  const mode = config.showModeChip ? (
    <ModeChip
      value={liveMode}
      draft={draft.mode}
      live={incarnation != null}
      onDraft={(next: AgentMode) => updateDraft(threadId, (current) => ({ ...current, mode: next }))}
      {...(config.setMode != null ? { setMode: config.setMode } : {})}
      onOpenChange={setMenuOpen}
      onRevert={() => setError(t("chat.composer.modeFailed"))}
    />
  ) : null;
  const model = config.model != null ? <ModelChip binding={config.model} /> : null;

  return (
    <ComposerContext value={value}>
      <div className="flex flex-col" data-slot="composer" data-state={state} data-expanded={expanded ? "" : undefined}>
        {trigger != null ? (
          <TriggerMenu
            trigger={trigger}
            skills={skills}
            mentions={config.mentions}
            onPick={(insert) => {
              const next = draft.text.slice(0, trigger.start) + insert + draft.text.slice(trigger.end);
              setText(next, null);
              field.current?.focus();
            }}
            onClose={() => setTrigger(null)}
          />
        ) : null}
        <motion.div
          layout={pref === "full"}
          layoutId={`composer:${threadId}`}
          transition={surfaceTransition}
          onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
          onDrop={onDrop}
          className={cn(
            "relative z-10 flex flex-col bg-[var(--chat-surface)]",
            expanded ? "gap-2.5 rounded-[22px] pt-3 pb-2 ps-3 pe-2" : "min-h-13 flex-row items-center gap-2 rounded-full px-2",
            skin === "session" && expanded && "min-h-[100px] rounded-[20px] ps-4"
          )}
        >
          {expanded ? <Attachments /> : null}
          {expanded ? null : <Attach />}
          <label htmlFor={fieldId} className="sr-only">
            {config.placeholder}
          </label>
          <textarea
            ref={field}
            id={fieldId}
            aria-label={config.placeholder}
            value={draft.text}
            placeholder={placeholder}
            rows={1}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => setText(event.target.value, event.target.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            style={{ maxHeight: COMPOSER_MAX_HEIGHT, fieldSizing: "content" } as React.CSSProperties}
            className={cn(
              "min-w-0 resize-none bg-transparent text-sm leading-5 outline-none placeholder:text-muted-foreground",
              expanded ? "w-full px-1" : "flex-1 py-2"
            )}
          />
          {expanded ? (
            <motion.div
              className="flex items-center gap-1.5"
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
            <>
              <Dictate />
              <SendOrStop />
            </>
          )}
        </motion.div>
        {error != null ? (
          <p role="alert" className="px-4 pt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {view.slots.composerContext != null ? (
          <div className="-mt-3 mx-3 rounded-b-xl bg-[var(--chat-surface-2)] px-2 pt-4 pb-1 text-[13px]" data-slot="composer-context">
            {view.slots.composerContext}
          </div>
        ) : null}
      </div>
    </ComposerContext>
  );
};

/** Compound parts for pages that compose their own composer (§8.1). */
export const Composer = {
  Thread: ThreadComposer,
  Attachments,
  Attach,
  Dictate,
  SendOrStop,
};
