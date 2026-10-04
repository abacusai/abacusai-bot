import { useTranslation } from "react-i18next";

import { ConnectError, type ConnectStage } from "./services";
export const ConnectScreen = ({
  stage,
  error,
  restart,
}: {
  stage: ConnectStage;
  error?: Error;
  restart(): void;
}) => {
  const { t } = useTranslation();
  return (
    <main
      className="flex h-screen flex-col items-center justify-center gap-4"
      role="status"
    >
      <p>{error?.message ?? t(`web.connect.${stage}`)}</p>
      {error instanceof ConnectError && error.kind === "signin" && (
        <a
          href={`/chatllm/signin?redirectUrl=${encodeURIComponent("/bot/" + location.hash)}`}
        >
          {t("web.connect.signin")}
        </a>
      )}
      {error instanceof ConnectError && error.kind === "tier" && (
        <a href="/chatllm">{t("web.connect.upgrade")}</a>
      )}
      {error &&
        (!(error instanceof ConnectError) || error.kind === "connection") && (
          <button onClick={() => location.reload()}>
            {t("shell.boot.reload")}
          </button>
        )}
      {error instanceof ConnectError && error.kind === "version" && (
        <button onClick={restart}>{t("web.connect.restart")}</button>
      )}
    </main>
  );
};
