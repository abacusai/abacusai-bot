import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/** Same test as main's isEmailPersonaEntry: the model may style the marker. */
const isPersonaEntry = (entry: string): boolean =>
  /^[\s#*_>-]*email persona/i.test(entry);

type Phase =
  | { kind: "generating"; percent: number }
  | { kind: "done"; text: string }
  | { kind: "failed" };

/**
 * Front and centre while the persona is being learnt from Gmail — a full
 * screen with the progress — and then the persona itself: keep it, edit it
 * with the rest of memory, or forget it on the spot.
 */
export const PersonaLearnedDialog = (): JSX.Element | null => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      window.api.agent.onEvent((event) => {
        if (event.type === "user-persona-learned")
          setPhase({ kind: "done", text: event.text });
        else if (event.type === "user-persona-progress")
          setPhase(
            event.percent < 0
              ? { kind: "failed" }
              : event.percent >= 100
                ? null
                : { kind: "generating", percent: event.percent }
          );
      }),
    []
  );

  if (phase == null) return null;
  const close = (): void => setPhase(null);

  const forget = async (): Promise<void> => {
    setBusy(true);
    try {
      const snapshot = await window.api.agent.listMemories();
      const index = snapshot.user.findIndex(isPersonaEntry);
      if (index >= 0)
        await window.api.agent.forgetMemory({
          target: "user",
          index,
          entry: snapshot.user[index]!,
        });
    } finally {
      setBusy(false);
      close();
    }
  };

  if (phase.kind === "generating") {
    return (
      // Blocking on purpose: closing is not offered until the run ends.
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent
          className="flex h-screen w-screen max-w-none flex-col items-center justify-center rounded-none border-0 sm:max-w-none"
          data-id="persona-generating"
          showCloseButton={false}
        >
          <DialogHeader className="items-center text-center">
            <DialogTitle className="text-2xl">
              {t("persona.generatingTitle")}
            </DialogTitle>
            <DialogDescription className="max-w-md">
              {t("persona.generatingBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="w-full max-w-md">
            <div
              className="bg-muted h-3 w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-valuenow={phase.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="bg-primary h-full rounded-full transition-[width] duration-700"
                style={{ width: `${phase.percent}%` }}
              />
            </div>
            <p
              className="text-muted-foreground mt-3 text-center text-sm"
              data-id="persona-generating-percent"
            >
              {t("persona.generatingPercent", { percent: phase.percent })}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (phase.kind === "failed") {
    return (
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent data-id="persona-failed">
          <DialogHeader>
            <DialogTitle>{t("persona.failedTitle")}</DialogTitle>
            <DialogDescription>{t("persona.failedBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={close} data-id="persona-failed-ok">
              {t("persona.ok")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="flex h-screen w-screen max-w-none flex-col justify-center rounded-none border-0 sm:max-w-none"
        data-id="persona-learned"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="text-2xl">{t("persona.title")}</DialogTitle>
            <DialogDescription>{t("persona.body")}</DialogDescription>
          </DialogHeader>
          <div
            className="bg-muted/40 max-h-[60vh] overflow-y-auto rounded-lg border px-5 py-4 text-base leading-relaxed whitespace-pre-wrap"
            data-id="persona-learned-text"
          >
            {phase.text}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void forget()}
              data-id="persona-learned-forget"
            >
              {t("persona.forget")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                close();
                void navigate({ to: "/settings/memory" });
              }}
              data-id="persona-learned-edit"
            >
              {t("persona.edit")}
            </Button>
            <Button onClick={close} data-id="persona-learned-ok">
              {t("persona.ok")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};
