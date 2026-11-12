/**
 * The two ends of a chat continued in another (continue-chat.ts): the new
 * chat opens on a small "Continued from" link to the old one, and the old
 * one ends on a "Continued in" link to each chat that carries it on. Drawn by
 * wrapping the route's `decorateMessage`, like the run reports.
 */
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { useLiveQuery } from "@tanstack/react-db";
import { CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { type Decorate, rowEnd } from "#renderer/components/run-report";
import { useCollections } from "#renderer/data/db";
import { AppLink } from "#renderer/lib/navigation/app-link";

export interface ContinuationLinks {
  /** The chat this one continues, when it is still there. */
  from: Pick<SessionRow, "id" | "label"> | null;
  /** This chat is a task handed off from `from`, which goes on beside it. */
  handoff?: boolean;
  /** The chats that continue this one, oldest first. */
  into: ReadonlyArray<Pick<SessionRow, "id" | "label">>;
}

export const useContinuationLinks = (
  row:
    | Pick<SessionRow, "id" | "continuedFrom" | "continuationKind">
    | null
    | undefined
): ContinuationLinks => {
  const collections = useCollections();
  const id = row?.id ?? null;
  const { data: into } = useLiveQuery({
    queryKey: ["continued-in", id],
    query: (q) =>
      id == null
        ? undefined
        : q
            .from({ s: collections.sessions })
            // A handoff is drawn where it was made (its tool card), not at the end.
            .fn.where(
              ({ s }) =>
                s.continuedFrom === id && s.continuationKind !== "handoff"
            ),
  });
  const from =
    row?.continuedFrom == null
      ? null
      : (collections.sessions.get(row.continuedFrom) ?? null);
  return {
    from,
    ...(row?.continuationKind === "handoff" ? { handoff: true } : {}),
    into: (into ?? []).toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    ),
  };
};

const ContinuationLink = ({
  to,
  direction,
  handoff = false,
}: {
  to: Pick<SessionRow, "id" | "label">;
  direction: "from" | "into";
  handoff?: boolean;
}) => {
  const { t } = useTranslation();
  const label = to.label.trim() === "" ? t("sessions.untitled") : to.label;
  return (
    <div
      data-slot="continuation-link"
      data-direction={direction}
      className="text-muted-foreground mx-auto my-2 flex w-full max-w-[min(640px,90%)] items-center gap-1.5 text-xs"
    >
      <CornerDownRight aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">
        {direction === "from"
          ? handoff
            ? t("sessions.continuation.handedOffFrom")
            : t("sessions.continuation.from")
          : t("sessions.continuation.into")}
      </span>
      <AppLink
        to="/sessions/$sessionId"
        params={{ sessionId: to.id }}
        className="truncate font-medium underline"
      >
        {label}
      </AppLink>
    </div>
  );
};

/** `decorate` with the link back above the first message and the links on under the last. */
export const withContinuationLinks = (
  decorate: Decorate,
  links: ContinuationLinks
): Decorate => {
  if (links.from == null && links.into.length === 0) return decorate;
  return (message, context) => {
    const inner = decorate(message, context);
    if (inner?.hidden === true) return inner;
    // A shown row may fold several stored messages; it is keyed by its host.
    const host =
      context.messages[context.index]?.id === message.id
        ? context.index
        : context.messages.findIndex((row) => row.id === message.id);
    if (host < 0) return inner;
    const first = host === 0 && links.from != null;
    const last =
      rowEnd(context.messages, host) === context.messages.length - 1 &&
      !context.runActive &&
      links.into.length > 0;
    if (!first && !last) return inner;
    return {
      ...inner,
      ...(first
        ? {
            before: (
              <>
                <ContinuationLink
                  to={links.from!}
                  direction="from"
                  handoff={links.handoff === true}
                />
                {inner?.before}
              </>
            ),
          }
        : {}),
      ...(last
        ? {
            after: (
              <>
                {inner?.after}
                {links.into.map((to) => (
                  <ContinuationLink key={to.id} to={to} direction="into" />
                ))}
              </>
            ),
          }
        : {}),
    };
  };
};

/**
 * Above a continuation's start composer: which chat the summary comes from,
 * and a way to start without it.
 */
export const ContinuationStartLine = ({
  sessionId,
  onDrop,
}: {
  sessionId: string;
  onDrop(): void;
}) => {
  const { t } = useTranslation();
  const collections = useCollections();
  const source = collections.sessions.get(sessionId);
  const label =
    source == null || source.label.trim() === ""
      ? t("sessions.untitled")
      : source.label;
  return (
    <div
      data-slot="continuation-start"
      className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs"
    >
      <CornerDownRight aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {t("sessions.continuation.startsFrom", { label })}
      </span>
      <button
        type="button"
        data-action="drop-continuation"
        className="shrink-0 underline"
        onClick={onDrop}
      >
        {t("sessions.continuation.drop")}
      </button>
    </div>
  );
};
