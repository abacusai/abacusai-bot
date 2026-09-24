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

const MARKER = "Email persona (from my sent mail):";

/**
 * "We learnt this about you": shown once, the moment the Gmail persona lands
 * in the USER profile. The person can keep it, edit it with the rest of
 * their memory, or forget it on the spot.
 */
export const PersonaLearnedDialog = (): JSX.Element | null => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      window.api.agent.onEvent((event) => {
        if (event.type === "user-persona-learned") setText(event.text);
      }),
    []
  );

  if (text == null) return null;
  const close = (): void => setText(null);

  const forget = async (): Promise<void> => {
    setBusy(true);
    try {
      const snapshot = await window.api.agent.listMemories();
      const index = snapshot.user.findIndex((entry) =>
        entry.startsWith(MARKER)
      );
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

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg" data-id="persona-learned">
        <DialogHeader>
          <DialogTitle>{t("persona.title")}</DialogTitle>
          <DialogDescription>{t("persona.body")}</DialogDescription>
        </DialogHeader>
        <div
          className="bg-muted/40 max-h-72 overflow-y-auto rounded-lg border px-4 py-3 text-sm whitespace-pre-wrap"
          data-id="persona-learned-text"
        >
          {text}
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
      </DialogContent>
    </Dialog>
  );
};
