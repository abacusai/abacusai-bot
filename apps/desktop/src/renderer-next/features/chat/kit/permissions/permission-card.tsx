/**
 * Permission cards (spec 02 §6.4) and the question card (§6.5). Each card
 * is its own form (`role="group"`, labelled by its title); any pending
 * descriptor can be answered in any order (§6.2).
 */
import type { PermissionDecision, PermissionRequest } from "@abacus-ai/agent";
import { Ellipsis } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";
import { Button } from "#next/ui/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "#next/ui/questionnaire";
import { Spinner } from "#next/ui/spinner";
import { Textarea } from "#next/ui/textarea";

import { MODE_LABEL_KEYS } from "../../composer/modes";
import { Markdown } from "../../markdown/markdown";
import { useThreadStore } from "../../store/selectors";
import type {
  AnsweringState,
  PermissionDescriptor,
} from "../../store/thread-store";
import { useChatView } from "../context";
import {
  allowedActions,
  askableQuestions,
  encodeAnswers,
  withNote,
  type QuestionItem,
} from "./decisions";
import { present, type CardAction, type CardBody } from "./presenters";

const VARIANT: Record<
  CardAction["variant"],
  "default" | "secondary" | "ghost"
> = {
  primary: "default",
  secondary: "secondary",
  deny: "ghost",
  warning: "secondary",
};

const DIFF_PREVIEW_LINES = 12;

const Body = ({ body }: { body: CardBody }) => {
  const { t } = useTranslation();
  const { workspaceRoot } = useChatView();
  const [all, setAll] = useState(false);
  switch (body.kind) {
    case "command":
      return (
        <div className="chat-terminal text-foreground/90 max-h-40">
          {body.command}
          {body.cwd != null && body.cwd !== "" ? (
            <div className="text-muted-foreground mt-1">{body.cwd}</div>
          ) : null}
        </div>
      );
    case "diff": {
      const changed = body.lines.filter((line) => line.kind !== "same");
      const shown = all ? body.lines : changed.slice(0, DIFF_PREVIEW_LINES);
      return (
        <div className="flex flex-col gap-1">
          <div className="chat-diff max-h-72">
            {shown.map((line, index) => (
              <div key={index} data-kind={line.kind}>
                {`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`}
              </div>
            ))}
          </div>
          {!all && changed.length > DIFF_PREVIEW_LINES ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setAll(true)}
            >
              {t("chat.permission.showAll")}
            </Button>
          ) : null}
        </div>
      );
    }
    case "content":
      return <pre className="chat-terminal max-h-60">{body.text}</pre>;
    case "text":
      return <div className="chat-terminal">{body.text}</div>;
    case "path":
      return <div className="chat-terminal">{body.path}</div>;
    case "plan":
      return (
        <div className="max-h-72 overflow-auto rounded-[10px] bg-[var(--chat-inset)] p-3">
          <Markdown
            content={body.markdown}
            role="assistant"
            workspaceRoot={workspaceRoot}
          />
        </div>
      );
    case "denials":
      return (
        <div className="flex flex-col gap-2">
          <div className="chat-terminal">{body.command}</div>
          <ul className="chat-mono flex flex-col gap-0.5 text-xs">
            {body.denials.map((denial, index) => (
              <li key={index}>
                <span className="text-destructive">
                  {t(`chat.permission.verb.${denial.verb}`)}
                </span>{" "}
                {denial.target}
              </li>
            ))}
          </ul>
          {body.note != null ? (
            <p className="text-muted-foreground text-xs">{body.note}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {t("chat.permission.sandboxRunsAgain")}
          </p>
        </div>
      );
    case "question":
    case "none":
      return null;
  }
};

const problemKey = (answering: AnsweringState | undefined): string | null =>
  answering?.state === "error"
    ? `chat.permission.problem.${answering.message}`
    : null;

export interface PermissionCardProps {
  descriptor: PermissionDescriptor;
  /** Take focus on appearance (the composer had it). */
  autoFocus?: boolean;
  onAnswered?: () => void;
}

export const PermissionCard = ({
  descriptor,
  autoFocus = false,
  onAnswered,
}: PermissionCardProps) => {
  const { t } = useTranslation();
  const { session, runtime, threadId, skin, notchEnabled } = useChatView();
  const request = descriptor.metadata.abacus.request as PermissionRequest;
  const model = present(request);
  const titleId = useId();
  const answering = useThreadStore(
    session,
    (state) => state.permissions.answering[descriptor.id]
  );
  const mode = useThreadStore(session, (state) => state.agent?.mode ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [visible, setVisible] = useState(model.delayed !== true);
  const primary = useRef<HTMLButtonElement>(null);
  const noteAllowed =
    model.note &&
    (descriptor.metadata.abacus.allowed as readonly string[]).some(
      (kind) => kind === "accept_with_message" || kind === "reject_with_message"
    );
  useEffect(() => {
    if (model.delayed !== true) return;
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [model.delayed]);
  useEffect(() => {
    if (autoFocus && visible) primary.current?.focus();
  }, [autoFocus, visible]);
  if (request.type === "ask_user_question")
    return <QuestionCard descriptor={descriptor} onAnswered={onAnswered} />;
  if (!visible) return null;
  const actions = allowedActions(descriptor, model.actions);
  const sending = answering?.state === "sending";
  const answer = (decision: PermissionDecision) => {
    void runtime.respondPermission(
      threadId,
      descriptor,
      withNote(decision, noteOpen ? note : "")
    );
    onAnswered?.();
  };
  const primaryAction =
    actions.find((action) => action.variant === "primary") ?? actions[0];
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      primaryAction != null &&
      !sending
    ) {
      event.preventDefault();
      answer(primaryAction.decision);
    }
    if (event.key === "Escape" && noteOpen) {
      event.stopPropagation();
      setNoteOpen(false);
    }
  };
  const problem = problemKey(answering);
  const labelFor = (action: CardAction) =>
    skin === "bot" && action.label === "allowOnce"
      ? t("chat.permission.action.allow")
      : t(`chat.permission.action.${action.label}`, action.values);
  const leading = model.stacked
    ? actions
    : actions.filter((action) => action.variant !== "deny");
  const trailing = model.stacked
    ? []
    : actions.filter((action) => action.variant === "deny");
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-slot="permission-card"
      data-permission={descriptor.id}
      className="flex flex-col gap-3 rounded-[20px] bg-[var(--chat-surface)] p-4 text-sm"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2">
        {model.warning ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-[var(--chat-status-attention)]"
          />
        ) : null}
        <div id={titleId} className="min-w-0 flex-1 font-medium">
          {t(`chat.permission.title.${model.title}`, model.titleValues)}
        </div>
        {model.aside?.kind === "mode" && mode != null ? (
          <div className="text-muted-foreground text-xs">
            {t(MODE_LABEL_KEYS[mode] ?? "chat.mode.DEFAULT")}
          </div>
        ) : null}
        {model.aside?.kind === "changes" ? (
          <div className="chat-mono text-xs">
            <span className="text-[var(--chat-diff-add-fg)]">
              +{model.aside.additions}
            </span>{" "}
            <span className="text-[var(--chat-diff-del-fg)]">
              -{model.aside.deletions}
            </span>
          </div>
        ) : null}
      </div>
      {model.description != null ? (
        <p className="text-muted-foreground leading-normal">
          {t(`chat.permission.title.${model.description}`)}
        </p>
      ) : null}
      <Body body={model.body} />
      {model.paths != null ? (
        <ul className="chat-mono text-muted-foreground text-xs">
          {model.paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : null}
      {noteOpen ? (
        <Textarea
          autoFocus
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-label={t("chat.permission.addNote")}
          placeholder={t("chat.permission.notePlaceholder")}
          className="min-h-16"
        />
      ) : null}
      <div
        className={cn(
          "flex gap-2",
          model.stacked ? "flex-col" : "flex-wrap items-center"
        )}
      >
        {leading.map((action) => (
          <Button
            key={action.id}
            // Focus goes to the primary action, wherever it sits: for a
            // credentials read that is Deny, never the secondary Allow once.
            ref={action.id === primaryAction?.id ? primary : undefined}
            variant={VARIANT[action.variant]}
            size={model.stacked ? "lg" : "default"}
            disabled={sending}
            className={cn(
              model.stacked && "justify-start",
              action.variant === "warning" &&
                "text-[var(--chat-status-attention)]"
            )}
            onClick={() => answer(action.decision)}
          >
            {sending &&
            answering?.decision ===
              (typeof action.decision === "string"
                ? action.decision
                : action.decision.type) ? (
              <Spinner aria-hidden />
            ) : null}
            {labelFor(action)}
          </Button>
        ))}
        {model.stacked ? null : <span className="flex-1" />}
        {trailing.map((action) => (
          <Button
            key={action.id}
            ref={action.id === primaryAction?.id ? primary : undefined}
            variant="ghost"
            disabled={sending}
            onClick={() => answer(action.decision)}
          >
            {labelFor(action)}
          </Button>
        ))}
        {noteAllowed && !model.stacked ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("chat.permission.addNote")}
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen((open) => !open)}
          >
            <Ellipsis aria-hidden />
          </Button>
        ) : null}
        {noteAllowed && model.stacked && !noteOpen ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setNoteOpen(true)}
          >
            {t("chat.permission.addNote")}
          </Button>
        ) : null}
      </div>
      {skin === "bot" && notchEnabled ? (
        <div className="text-muted-foreground text-end text-xs">
          {t("chat.permission.alsoInNotch")}
        </div>
      ) : null}
      {problem != null ? (
        <p role="status" className="text-destructive text-xs">
          {t(problem)}
        </p>
      ) : null}
    </div>
  );
};

/** `ask_user_question` (§6.5): the registry questionnaire, today's encoding. */
const QuestionCard = ({
  descriptor,
  onAnswered,
}: {
  descriptor: PermissionDescriptor;
  onAnswered?: () => void;
}) => {
  const { t } = useTranslation();
  const { runtime, threadId, session } = useChatView();
  const request = descriptor.metadata.abacus.request as Extract<
    PermissionRequest,
    { type: "ask_user_question" }
  >;
  const questions = askableQuestions(request.questions as QuestionItem[]);
  const answering = useThreadStore(
    session,
    (state) => state.permissions.answering[descriptor.id]
  );
  const titleId = useId();
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const skipAllowed = (
    descriptor.metadata.abacus.allowed as readonly string[]
  ).includes("reject");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selected = new Map<number, Set<number>>();
    const notes = new Map<number, string>();
    questions.forEach((_q, index) => {
      const values = data
        .getAll(`question_${index}`)
        .map(Number)
        .filter(Number.isInteger);
      if (values.length > 0) selected.set(index, new Set(values));
      const note = data.get(`note_${index}`);
      if (typeof note === "string" && note !== "") notes.set(index, note);
    });
    void runtime.respondPermission(threadId, descriptor, {
      type: "question_answers",
      answers: encodeAnswers(questions, selected, notes),
    });
    onAnswered?.();
  };
  const problem = problemKey(answering);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-slot="permission-card"
      data-permission={descriptor.id}
      className="flex flex-col gap-3 rounded-[20px] bg-[var(--chat-surface)] p-4 text-sm"
    >
      <span id={titleId} className="sr-only">
        {t("chat.permission.title.question")}
      </span>
      <Questionnaire
        shortcuts="letters"
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            answering?.state !== "sending"
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
        onSubmit={submit}
        className="flex flex-col gap-3"
      >
        <QuestionnaireProgress
          className="text-muted-foreground self-end text-xs"
          render={(props, state) => (
            <div {...props}>
              {t("chat.question.progress", {
                current: state.current + 1,
                total: state.total,
              })}
            </div>
          )}
        />
        {questions.map((question, index) => (
          <QuestionnaireItem
            key={index}
            name={`question_${index}`}
            multiple={question.multiSelect}
          >
            <QuestionnaireTitle className="font-medium">
              {question.question}
            </QuestionnaireTitle>
            <QuestionnaireChoices>
              {question.options.map((option, optionIndex) => (
                <QuestionnaireChoice
                  key={optionIndex}
                  value={String(optionIndex)}
                >
                  {option.label}
                  {option.description !== "" ? (
                    <QuestionnaireChoiceDescription>
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  ) : null}
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
            {openNotes[index] ? (
              <Textarea
                name={`note_${index}`}
                aria-label={t("chat.permission.addNote")}
                className="min-h-14"
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground self-start"
                onClick={() =>
                  setOpenNotes((notes) => ({ ...notes, [index]: true }))
                }
              >
                {t("chat.permission.addNote")}
              </Button>
            )}
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          {skipAllowed ? (
            <Button
              variant="ghost"
              disabled={answering?.state === "sending"}
              onClick={() => {
                void runtime.respondPermission(threadId, descriptor, "reject");
                onAnswered?.();
              }}
            >
              {t("chat.permission.action.skipAll")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <QuestionnairePrevious>
            {t("chat.question.previous")}
          </QuestionnairePrevious>
          <QuestionnaireNext>{t("chat.question.next")}</QuestionnaireNext>
          <QuestionnaireSubmit disabled={answering?.state === "sending"}>
            {t("chat.question.submit")}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
      {problem != null ? (
        <p role="status" className="text-destructive text-xs">
          {t(problem)}
        </p>
      ) : null}
    </div>
  );
};
