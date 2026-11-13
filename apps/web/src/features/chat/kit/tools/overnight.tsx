/**
 * `overnight_task`'s card: the work the user booked from the next step's moon
 * button, with when it will be ready (contract overnight.ts). A refused
 * booking draws nothing: the reply says why.
 */
import { bookedReadyAt } from "@abacus-ai/contract/overnight";
import { parsePartialJSON } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { Moon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { normalizeTool } from "./normalize";

export const OvernightToolCard = ({ part, result }: ToolProps<unknown>) => {
  const { t, i18n } = useTranslation();
  if (result == null) return null;
  const tool = normalizeTool(
    part,
    result,
    {},
    { runActive: false },
    parsePartialJSON
  );
  if (tool.status === "failed" || tool.status === "refused") return null;
  const readyAt = bookedReadyAt(tool.text);
  if (readyAt == null) return null;
  // A weekday and a time: a booking is never more than a day ahead.
  const when = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(readyAt);
  return (
    <div
      data-slot="overnight-booked"
      className="my-2 flex w-full max-w-[520px] items-start gap-2.5 rounded-xl border border-dashed px-3 py-2.5"
    >
      <Moon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {t("chat.overnight.booked", { when })}
        </span>
        <span className="text-muted-foreground text-sm">
          {t("chat.overnight.bookedLine")}
        </span>
      </div>
    </div>
  );
};
