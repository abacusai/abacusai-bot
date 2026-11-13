/**
 * The session's pull request, read and reviewed through the user's own
 * `gh` (spec 04 §14.3): header, checks, description, reviewers, labels,
 * files with their diffs, the conversation, and a review composer while
 * the PR is open. When there is nothing to show it says what would fix it.
 */
import type { CheckoutRef } from "@abacus-ai/contract/contract/checkout";
import type { PrDetail } from "@abacus-ai/contract/contract/github";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { errorText } from "#renderer/lib/use-app-context";
import { Skeleton } from "#renderer/ui/skeleton";

import { GithubWatchPrLine } from "../../routines/github-watch";
import {
  useCheckoutQueries,
  useGithubIntegration,
  useSessionsTransport,
} from "../data/queries";
import { PrChecks } from "./pr-checks";
import { PrConversation } from "./pr-conversation";
import { PrFileDiff, PrFiles } from "./pr-files";
import { PrHeader } from "./pr-header";
import { PrLabels, PrReviewers } from "./pr-people";
import { PrReviewForm } from "./pr-review-form";
import { PrSection } from "./pr-section";
import { PrDisabled, PrNone, PrUnavailable, PrUnsupported } from "./pr-states";

export const PrTab = ({
  row,
  renderMarkdown,
}: {
  row: SessionRow;
  renderMarkdown(text: string): ReactNode;
}) =>
  useGithubIntegration() ? (
    <PrTabContent row={row} renderMarkdown={renderMarkdown} />
  ) : (
    <PrDisabled />
  );

const PrTabContent = ({
  row,
  renderMarkdown,
}: {
  row: SessionRow;
  renderMarkdown(text: string): ReactNode;
}) => {
  const transport = useSessionsTransport();
  const checkout = { workspaceId: row.workspaceId, sessionId: row.id };
  const result = useQuery(useCheckoutQueries(checkout).pullRequest(checkout));
  const [retrying, setRetrying] = useState(false);
  // A fresh probe first: `gh` may have been installed or signed in since.
  const retry = () => {
    setRetrying(true);
    void transport.client.github
      .status({ refresh: true })
      .catch(() => undefined)
      .then(() => result.refetch())
      .finally(() => setRetrying(false));
  };
  if (result.isPending) return <PrLoading />;
  if (result.isError)
    return (
      <PrUnavailable
        status={{ state: "error", message: errorText(result.error) }}
        onRetry={retry}
        retrying={retrying}
      />
    );
  const data = result.data;
  switch (data.kind) {
    case "ok":
      return (
        <PrDetailView
          // Another PR on this branch starts with a fresh view.
          key={data.pr.number}
          pr={data.pr}
          checkout={checkout}
          readAt={result.dataUpdatedAt}
          renderMarkdown={renderMarkdown}
        />
      );
    case "none":
      return <PrNone branch={data.branch} />;
    case "unsupported":
      return <PrUnsupported />;
    case "unavailable":
      return (
        <PrUnavailable
          status={data.status}
          onRetry={retry}
          retrying={retrying}
        />
      );
  }
};

const PrLoading = () => {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t("sessions.pr.loading")}
      data-slot="pr-loading"
      className="flex size-full min-w-0 flex-col gap-2 p-3"
    >
      <Skeleton className="h-3.5 w-3/5" />
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="mt-3 h-3 w-4/5" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
};

const PrDetailView = ({
  pr,
  checkout,
  readAt,
  renderMarkdown,
}: {
  pr: PrDetail;
  checkout: CheckoutRef;
  readAt: number;
  renderMarkdown(text: string): ReactNode;
}) => {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const file = pr.files.find((f) => f.path === path);
  return (
    <div data-slot="pr-tab" className="flex size-full min-h-0 flex-col">
      <PrHeader pr={pr} />
      {pr.state === "OPEN" ? <GithubWatchPrLine prUrl={pr.url} /> : null}
      {file ? (
        <div className="min-h-0 flex-1">
          <PrFileDiff
            checkout={checkout}
            number={pr.number}
            url={pr.url}
            file={file}
            onBack={() => setPath(null)}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain">
          {pr.checks.length ? <PrChecks pr={pr} /> : null}
          <PrSection title={t("sessions.pr.description")}>
            {pr.body.trim() ? (
              <div className="min-w-0 text-[13px]">
                {renderMarkdown(pr.body)}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t("sessions.pr.noDescription")}
              </p>
            )}
          </PrSection>
          <PrReviewers pr={pr} />
          <PrLabels labels={pr.labels} />
          <PrFiles files={pr.files} onOpen={setPath} />
          <PrConversation
            pr={pr}
            now={readAt}
            renderMarkdown={renderMarkdown}
          />
        </div>
      )}
      {pr.state === "OPEN" ? (
        <PrReviewForm checkout={checkout} number={pr.number} />
      ) : null}
    </div>
  );
};
