/**
 * The review tab when there is no pull request to show: the integration is
 * off, `gh` is missing or signed out, the branch has none yet, or the
 * checkout is not on GitHub. Each says what fixes it.
 */
import type { GithubStatus } from "@abacus-ai/contract/contract/github";
import {
  CircleAlert,
  GitPullRequest,
  GitPullRequestArrow,
  KeyRound,
  Settings,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#renderer/ui/empty";

import { useOpenExternal } from "./pr-presentation";

export const GH_INSTALL_URL = "https://cli.github.com";

const PrNotice = ({
  icon: Icon,
  title,
  description,
  commands = [],
  children,
}: {
  icon: typeof GitPullRequest;
  title: string;
  description?: string;
  /** Shell commands that fix it, shown as code. */
  commands?: readonly string[];
  children?: ReactNode;
}) => (
  <Empty data-slot="pr-notice" className="size-full">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <Icon aria-hidden />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      {description ? <EmptyDescription>{description}</EmptyDescription> : null}
    </EmptyHeader>
    {commands.length || children ? (
      <EmptyContent>
        {commands.length ? (
          <div className="flex flex-col items-center gap-1">
            {commands.map((command) => (
              <code
                key={command}
                className="bg-muted rounded-md px-2 py-0.5 font-mono text-xs"
              >
                {command}
              </code>
            ))}
          </div>
        ) : null}
        {children ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            {children}
          </div>
        ) : null}
      </EmptyContent>
    ) : null}
  </Empty>
);

const SettingsButton = () => {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() =>
        void navigate({
          to: "/settings/environment",
          search: { focus: "githubIntegration" },
          transition: "settings-in",
        })
      }
    >
      <Settings />
      {t("sessions.pr.state.settings")}
    </Button>
  );
};

const RetryButton = ({ onRetry, busy }: { onRetry(): void; busy: boolean }) => {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>
      {t("sessions.pr.state.retry")}
    </Button>
  );
};

export const PrDisabled = () => {
  const { t } = useTranslation();
  return (
    <PrNotice
      icon={GitPullRequest}
      title={t("sessions.pr.state.disabled.title")}
      description={t("sessions.pr.state.disabled.detail")}
    >
      <SettingsButton />
    </PrNotice>
  );
};

export const PrNone = ({ branch }: { branch: string | null }) => {
  const { t } = useTranslation();
  return (
    <PrNotice
      icon={GitPullRequestArrow}
      title={
        branch
          ? t("sessions.pr.state.none.title", { branch })
          : t("sessions.pr.state.none.detached")
      }
      description={
        branch
          ? t("sessions.pr.state.none.detail")
          : t("sessions.pr.state.none.detachedDetail")
      }
      commands={branch ? ["gh pr create"] : []}
    />
  );
};

export const PrUnsupported = () => {
  const { t } = useTranslation();
  return (
    <PrNotice
      icon={GitPullRequest}
      title={t("sessions.pr.state.unsupported.title")}
      description={t("sessions.pr.state.unsupported.detail")}
    />
  );
};

/** `gh` can't answer: not installed, signed out, or failing. */
export const PrUnavailable = ({
  status,
  onRetry,
  retrying,
}: {
  status: Pick<GithubStatus, "state" | "message" | "userFacing">;
  onRetry(): void;
  retrying: boolean;
}) => {
  const { t } = useTranslation();
  const open = useOpenExternal();
  if (status.state === "disabled") return <PrDisabled />;
  const retry = <RetryButton onRetry={onRetry} busy={retrying} />;
  if (status.state === "missing")
    return (
      <PrNotice
        icon={Terminal}
        title={t("sessions.pr.state.missing.title")}
        description={t("sessions.pr.state.missing.detail")}
        commands={["gh auth login"]}
      >
        <Button size="sm" onClick={() => open(GH_INSTALL_URL)}>
          {t("sessions.pr.state.install")}
        </Button>
        {retry}
        <SettingsButton />
      </PrNotice>
    );
  if (status.state === "unauthenticated")
    return (
      <PrNotice
        icon={KeyRound}
        title={t("sessions.pr.state.unauthenticated.title")}
        description={t("sessions.pr.state.unauthenticated.detail")}
        commands={["gh auth login"]}
      >
        {retry}
        <SettingsButton />
      </PrNotice>
    );
  return (
    <PrNotice
      icon={CircleAlert}
      title={t("sessions.pr.state.error.title")}
      // gh's own words only when main marked them a sentence for the user.
      description={
        status.userFacing === true && status.message != null
          ? status.message
          : t("sessions.pr.state.error.detail")
      }
    >
      {retry}
      <SettingsButton />
    </PrNotice>
  );
};
