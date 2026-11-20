/**
 * `bot_help`'s card: a button to the place in the app the answer names
 * ("Open Settings → Models → Google Gemini"). The place comes from the same
 * contract function the main process words the answer with, from the call's
 * own topic and name, so the button and the reply agree; text the model
 * writes never picks a route.
 */
import {
  botHelpPlace,
  type BotHelpPlace,
  botHelpRequest,
} from "@abacus-ai/contract/bot-help";
import { parsePartialJSON } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { Compass } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useOptionalDb } from "#renderer/data/db";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";

import { toolInput } from "./normalize";

export const BotHelpCard = ({ place }: { place: BotHelpPlace }) => {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const path = place.path
    .map((label) => (label.key != null ? t(label.key) : label.text))
    .join(" → ");
  return (
    <div
      data-slot="bot-help"
      data-to={place.to}
      className="bg-card my-2 flex w-full max-w-[520px] items-center gap-2 rounded-xl border p-3"
    >
      <Compass aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">{path}</span>
      <Button
        size="sm"
        onClick={() =>
          void navigate({
            to: place.to,
            ...(place.params != null ? { params: place.params } : {}),
            ...(place.search != null ? { search: place.search } : {}),
            transition: "nav-forward",
            // A place built at run time from the contract's routes.
          } as never)
        }
      >
        {t("chat.botHelp.open")}
      </Button>
    </div>
  );
};

/** The tool row: the place the call's topic and name lead to; nothing for an overview or a control in this chat. */
export const BotHelpToolCard = ({ part }: ToolProps<unknown>) => {
  const db = useOptionalDb();
  const input = toolInput(part, parsePartialJSON);
  const { topic, name } = botHelpRequest(input.topic, input.name);
  if (part.input == null || topic == null) return null;
  const bots = (db?.collections.bots.toArray ?? []).map((bot) => ({
    id: bot.id,
    name: bot.name,
  }));
  const place = botHelpPlace(topic, name, bots);
  return place == null ? null : <BotHelpCard place={place} />;
};
