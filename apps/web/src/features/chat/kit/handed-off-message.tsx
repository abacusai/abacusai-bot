/**
 * A handed-off chat's first message (`hand_off_session`): the app's note,
 * never the user's words. Drawn as "Handed off from" its source, linked while
 * that chat is there, with the brief the source's agent wrote underneath.
 */
import type { HandOffTag, UserTextTags } from "@abacus-ai/contract/agent-types";
import type { UIMessage } from "@tanstack/ai-client";
import { useLiveQuery } from "@tanstack/react-db";
import { CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { AppLink } from "#renderer/lib/navigation/app-link";

import { Markdown } from "../markdown/markdown";

/** The hand-off this message carries, if it is one. */
export const handOffOf = (message: UIMessage): HandOffTag | null => {
  if (message.role !== "user") return null;
  const operator = (
    message.metadata as { abacus?: { userText?: UserTextTags } } | undefined
  )?.abacus?.userText?.operator;
  return operator?.kind === "handoff" && operator.handoff != null
    ? operator.handoff
    : null;
};

export const HandedOffMessage = ({ handoff }: { handoff: HandOffTag }) => {
  const { t } = useTranslation();
  const collections = useCollections();
  const { data } = useLiveQuery({
    queryKey: ["handed-off-from", handoff.fromSessionId],
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .fn.where(({ s }) => s.id === handoff.fromSessionId),
  });
  const source = data?.[0];
  const label =
    source == null
      ? null
      : source.label.trim() === ""
        ? t("sessions.untitled")
        : source.label;
  return (
    <div data-slot="handed-off" className="flex flex-col gap-1.5 py-1">
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        <CornerDownRight aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">
          {t("sessions.continuation.handedOffFrom")}
        </span>
        {source != null && label != null ? (
          <AppLink
            to="/sessions/$sessionId"
            params={{ sessionId: source.id }}
            className="text-foreground min-w-0 truncate font-medium hover:underline"
          >
            {label}
          </AppLink>
        ) : null}
      </div>
      <div className="bg-card w-full max-w-[min(640px,100%)] rounded-xl border px-3 py-2 text-sm">
        <Markdown content={handoff.brief} role="assistant" untrusted />
      </div>
    </div>
  );
};
