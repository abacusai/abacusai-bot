import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#next/ui/button";

import type { ChatRuntime } from "../../runtime/runtime";
import { useThreadStore } from "../../store/selectors";
import { encodeAnswers } from "./decisions";
import { notchAcceptable } from "./notch-acceptable";
export interface NotchPermissionProps {
  runtime: ChatRuntime;
  threadId: string;
  onReview?(): void;
  onSnooze?(): void;
  maxHeight?: number;
  focused?: boolean;
  onHaptic?(key: string): void;
}
export const NotchPermissionList = ({
  runtime,
  threadId,
  onReview,
  onSnooze,
  maxHeight = 220,
  focused = false,
  onHaptic,
}: NotchPermissionProps) => {
  const { t } = useTranslation();
  const session = runtime.session(threadId);
  const items = useThreadStore(session, (state) => state.permissions.items);
  const answering = useThreadStore(
    session,
    (state) => state.permissions.answering
  );
  const descriptor = items[0];
  const measure = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<Map<number, ReadonlySet<number>>>(
    new Map()
  );
  const r = descriptor?.metadata.abacus.request;
  const questions = r?.type === "ask_user_question" ? r.questions : null;
  const safe = descriptor ? notchAcceptable(descriptor, () => true) : null;
  const lines = safe?.ok ? safe.lines : [];
  useLayoutEffect(() => {
    const node = measure.current;
    setFits(
      !!node &&
        node.clientWidth > 0 &&
        node.scrollWidth <= node.clientWidth &&
        (questions
          ? [...node.children].every(
              (child) => (child as HTMLElement).scrollHeight + 70 <= maxHeight
            )
          : node.scrollHeight + 70 <= maxHeight) &&
        [...node.querySelectorAll<HTMLElement>("[data-fit]")].every(
          (line) =>
            line.scrollWidth <= line.clientWidth &&
            line.scrollHeight <= (Number(line.dataset.lines) || 2) * 16
        )
    );
  }, [descriptor, maxHeight, step, questions]);
  useEffect(() => {
    if (!descriptor) return;
    const lineage = descriptor.metadata.abacus.lineage;
    onHaptic?.(
      `${lineage.threadId}:${lineage.incarnation}:${lineage.turnSeq}:${lineage.permissionId}:${step}`
    );
  }, [descriptor, step, onHaptic]);
  useEffect(() => {
    if (!focused || !descriptor) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSnooze?.();
      }
      if (
        event.key !== "Enter" ||
        !(event.metaKey || event.ctrlKey) ||
        !fits ||
        descriptor.metadata.abacus.request.type === "ask_user_question"
      )
        return;
      if (
        notchAcceptable(descriptor, () => fits).ok &&
        descriptor.metadata.abacus.allowed.includes("accept")
      ) {
        event.preventDefault();
        void runtime
          .respondPermission(threadId, descriptor, "accept")
          .catch(() => undefined);
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [focused, descriptor, fits, onSnooze, runtime, threadId]);
  if (!descriptor) return null;
  const pending = answering[descriptor.id];
  const q = questions?.[step];
  const respond = (decision: Parameters<ChatRuntime["respondPermission"]>[2]) =>
    void runtime
      .respondPermission(threadId, descriptor, decision)
      .catch(() => undefined);
  if (questions)
    return (
      <div>
        <div
          ref={measure}
          aria-hidden="true"
          style={{
            position: "absolute",
            visibility: "hidden",
            width: "calc(100% - 32px)",
            pointerEvents: "none",
          }}
        >
          {questions.map((question, index) => (
            <div key={index}>
              <h2 data-fit data-lines="2">
                {question.header}
              </h2>
              <p data-fit data-lines="2">
                {question.question}
              </p>
              <div className="flex gap-2" data-fit data-lines="2">
                {question.options.map((option, i) => (
                  <span key={i} className="whitespace-nowrap">
                    {option.label}
                  </span>
                ))}
              </div>
              {question.options.map((option, i) => (
                <p key={i} data-fit data-lines="1">
                  {option.description}
                </p>
              ))}
            </div>
          ))}
        </div>
        <div className="notch-question">
          <h2>{q?.header}</h2>
          <p>{q?.question}</p>
        </div>
        {fits && questions.every((q) => !q.multiSelect) ? (
          <div className="flex gap-2">
            {q?.options.map((o, i) => (
              <Button
                key={i}
                disabled={pending?.state === "sending"}
                onClick={() => {
                  const answers = new Map(selected);
                  answers.set(step, new Set([i]));
                  setSelected(answers);
                  if (step + 1 < questions.length) setStep(step + 1);
                  else
                    respond({
                      type: "question_answers",
                      answers: encodeAnswers(questions, answers, new Map()),
                    });
                }}
              >
                <span>
                  {o.label}
                  {o.description && (
                    <span className="block text-xs font-normal">
                      {o.description}
                    </span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <Button onClick={onReview}>{t("notch.approval.answerInApp")}</Button>
        )}
        <Button variant="ghost" onClick={onSnooze}>
          {t("notch.approval.notNow")}
        </Button>
      </div>
    );
  return (
    <div>
      <h2>{descriptor.message}</h2>
      <div ref={measure}>
        {lines.map((line, i) => (
          <p
            key={i}
            data-fit
            data-lines="2"
            className="break-all whitespace-pre-wrap"
          >
            {line}
          </p>
        ))}
      </div>
      {(!safe?.ok || !fits) && <p>{t("notch.approval.reviewOnly")}</p>}
      <div className="flex gap-2">
        {safe?.ok &&
          fits &&
          descriptor.metadata.abacus.allowed.includes("accept") && (
            <Button
              disabled={pending?.state === "sending"}
              onClick={() => respond("accept")}
            >
              {t("chat.permission.action.allow")}
            </Button>
          )}
        {descriptor.metadata.abacus.allowed.includes("reject") && (
          <Button
            variant="secondary"
            disabled={pending?.state === "sending"}
            onClick={() => respond("reject")}
          >
            {t("chat.permission.action.deny")}
          </Button>
        )}
        <Button variant="ghost" onClick={onReview}>
          {t("notch.approval.review")}
        </Button>
        <Button variant="ghost" onClick={onSnooze}>
          {t("notch.approval.notNow")}
        </Button>
      </div>
      {pending?.state === "error" && (
        <p role="alert">{t("notch.approval.noResponse")}</p>
      )}
    </div>
  );
};
