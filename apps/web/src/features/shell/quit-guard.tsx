import type {
  QuitGuardAnswer,
  QuitGuardState,
  QuitGuardWork,
} from "@abacus-ai/contract/contract/system";
/**
 * The question a quit asks while work runs (main's quit-guard.ts), and the
 * bar that shows while the app waits for the work to finish. Main shows its
 * native dialog instead when this one does not answer `shown` in time.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";

/** The most chats the question names; the rest are counted. */
const QUIT_GUARD_NAMED_MAX = 4;

const answerQuitGuard = (
  transport: Transport,
  answer: QuitGuardAnswer
): void => {
  // An older main has no quit guard: nothing asked, nothing to answer.
  void transport.client.system
    .answerQuitGuard({ answer })
    .catch(() => undefined);
};

const useQuitGuardState = (transport: Transport): QuitGuardState => {
  const [state, setState] = useState<QuitGuardState>({ phase: "idle" });
  useEffect(() => {
    const abort = new AbortController();
    const read = (): void => {
      void transport.client.system
        .quitGuard({}, { signal: abort.signal })
        .then((next) => {
          if (!abort.signal.aborted) setState(next);
        })
        .catch(() => undefined);
    };
    read();
    followNotice(
      "system",
      transport,
      (event) => {
        if (event.type === "quit-guard") setState(event.state);
      },
      abort.signal,
      { reopened: read }
    );
    return () => abort.abort();
  }, [transport]);
  return state;
};

const WorkList = ({ work }: { work: QuitGuardWork[] }) => {
  const { t } = useTranslation();
  const named = work.slice(0, QUIT_GUARD_NAMED_MAX);
  const more = work.length - named.length;
  return (
    <ul className="bg-muted/50 flex flex-col gap-1 rounded-md px-3 py-2 text-xs">
      {named.map((item) => (
        <li key={item.sessionId} className="flex min-w-0 items-center gap-2">
          <Spinner className="size-3 shrink-0" />
          <span className="truncate font-medium" title={item.label}>
            {item.label || t("quitGuard.unnamed")}
          </span>
        </li>
      ))}
      {more > 0 && (
        <li className="text-muted-foreground pl-5">
          {t("quitGuard.more", { count: more })}
        </li>
      )}
    </ul>
  );
};

/** The question itself, open while main asks; `onAnswer` sends the choice. */
export const QuitGuardQuestion = ({
  open,
  work,
  onAnswer,
}: {
  open: boolean;
  work: QuitGuardWork[];
  onAnswer(answer: Exclude<QuitGuardAnswer, "shown">): void;
}) => {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && open) onAnswer("cancel");
      }}
    >
      <AlertDialogContent data-testid="quit-guard-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("quitGuard.title", { count: work.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("quitGuard.body", { count: work.length })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <WorkList work={work} />
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => onAnswer("cancel")}>
            {t("quitGuard.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => onAnswer("quit")}>
            {t("quitGuard.quitAnyway")}
          </Button>
          <Button autoFocus onClick={() => onAnswer("wait")}>
            {t("quitGuard.wait", { count: work.length })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export const QuitGuard = ({ transport }: { transport: Transport }) => {
  const { t } = useTranslation();
  const state = useQuitGuardState(transport);
  const asking = state.phase === "asking";

  // Tell main the question is on screen, so it shows no native one.
  useEffect(() => {
    if (asking) answerQuitGuard(transport, "shown");
  }, [asking, transport]);

  const work = state.phase === "idle" ? [] : state.work;
  const one = work.length === 1;
  const first = work[0]?.label || t("quitGuard.unnamed");

  return (
    <>
      <QuitGuardQuestion
        open={asking}
        work={work}
        onAnswer={(answer) => answerQuitGuard(transport, answer)}
      />
      {state.phase === "waiting" && (
        <div
          role="status"
          data-testid="quit-guard-waiting"
          className="bg-popover text-popover-foreground ring-foreground/10 fixed top-12 left-1/2 z-50 flex w-max max-w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg px-3 py-2 text-xs shadow-lg ring-1"
        >
          <Spinner className="size-3.5 shrink-0" />
          <span className="line-clamp-2 min-w-0">
            {one
              ? t("quitGuard.waitingOne", { name: first })
              : t("quitGuard.waitingMany", { count: work.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => answerQuitGuard(transport, "cancel")}
          >
            {t("quitGuard.dontQuit")}
          </Button>
        </div>
      )}
    </>
  );
};
