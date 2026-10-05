/**
 * The host connection, as the browser shows it (spec 09 D4): the stage, or
 * why the host is out of reach with the action that remedies it.
 */
import { useTranslation } from "react-i18next";

import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";

import {
  ConnectError,
  restartHost,
  retryHostNow,
  type ConnectStage,
} from "./services";

const kindOf = (error?: Error | null) =>
  error ? (error instanceof ConnectError ? error.kind : "connection") : null;

const ConnectAction = ({
  error,
  restart,
  attempting = false,
}: {
  error?: Error | null;
  restart(): void;
  attempting?: boolean;
}) => {
  const { t } = useTranslation();
  const kind = kindOf(error);
  if (kind === "signin")
    return (
      <a
        href={`/chatllm/signin?redirectUrl=${encodeURIComponent("/bot/" + location.hash)}`}
      >
        {t("phase5.signIn")}
      </a>
    );
  if (kind === "tier") return <a href="/chatllm">{t("web.connect.upgrade")}</a>;
  if (kind === "limit")
    return (
      <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener">
        {t("web.connect.download")}
      </a>
    );
  if (kind === "version")
    return <button onClick={restart}>{t("web.connect.restart")}</button>;
  if (kind === "reload")
    return (
      <button onClick={() => location.reload()}>
        {t("shell.boot.reload")}
      </button>
    );
  if (kind === "connection")
    return (
      <button onClick={retryHostNow} disabled={attempting}>
        {t("web.connect.retry")}
      </button>
    );
  return null;
};

export const ConnectScreen = ({
  stage,
  error,
  restart = restartHost,
}: {
  stage: ConnectStage;
  error?: Error | null;
  restart?(): void;
}) => {
  const { t } = useTranslation();
  return (
    <main
      className="bg-background text-foreground fixed inset-0 z-50 flex h-screen flex-col items-center justify-center gap-4"
      role="status"
    >
      <p>{error?.message ?? t(`web.connect.${stage}`)}</p>
      {kindOf(error) === "connection" ? (
        <button onClick={() => location.reload()}>
          {t("shell.boot.reload")}
        </button>
      ) : (
        <ConnectAction error={error} restart={restart} />
      )}
    </main>
  );
};
