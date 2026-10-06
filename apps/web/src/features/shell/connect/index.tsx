/**
 * The host connection, as the browser shows it (spec 09 D4). Sign-in and tier
 * refusals replace the app (`ConnectScreen`), a full web host the busy page
 * (`LimitScreen`); every other
 * stage and error is a slim banner over the running shell (`HostStatus`),
 * with the same copy and actions.
 */
import { useSelector } from "@tanstack/react-store";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";
import { defaultLook } from "#renderer/lib/bots/avatar";
import { webSignInHref } from "#renderer/lib/navigation/web-sign-in";
import { Button } from "#renderer/ui/button";

import {
  ConnectError,
  hostConnection,
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
    return <a href={webSignInHref()}>{t("phase5.signIn")}</a>;
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
  if (kindOf(error) === "limit") return <LimitScreen />;
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

/**
 * The web host is out of room (the free hosts are at capacity): a full page
 * with the sleeping bot, a way to keep going in the desktop app, and a retry.
 */
export const LimitScreen = () => {
  const { t } = useTranslation();
  return (
    <main
      data-slot="host-limit"
      className="bg-background text-foreground fixed inset-0 z-50 flex min-h-dvh flex-col items-center justify-center overflow-y-auto px-6 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex w-full max-w-[400px] flex-col items-center gap-6 text-center">
        <BotAvatar
          look={defaultLook("AbacusAI Bot")}
          mood="asleep"
          size={112}
        />
        <div className="flex flex-col gap-3">
          <h1 className="text-[26px] leading-8 font-semibold tracking-tight text-balance">
            {t("web.connect.busyTitle")}
          </h1>
          <p className="text-muted-foreground text-[15px] leading-[22px] text-pretty">
            {t("web.connect.busyBody")}
          </p>
        </div>
        <div className="flex w-full flex-col gap-3">
          <Button
            size="lg"
            className="h-12 w-full rounded-full text-base"
            nativeButton={false}
            render={
              <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener" />
            }
          >
            {t("web.connect.busyDownload")}
          </Button>
          <Button
            size="lg"
            variant="secondary"
            className="h-12 w-full rounded-full text-base"
            onClick={() => location.reload()}
          >
            {t("web.connect.retry")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("web.connect.busyNote")}
        </p>
      </div>
    </main>
  );
};

/** The shell's view of `hostConnection`: nothing while a socket is open. */
export const HostStatus = () => {
  const { t } = useTranslation();
  const { stage, error, attempting } = useSelector(
    hostConnection,
    (state) => state
  );
  const kind = kindOf(error);
  if (kind === "signin" || kind === "tier" || kind === "limit")
    return <ConnectScreen stage={stage} error={error} />;
  if (stage === "open") return null;
  return (
    <div
      data-slot="host-status"
      role="status"
      className="bg-muted text-muted-foreground fixed inset-x-0 top-0 z-40 flex items-center justify-center gap-3 px-4 py-1 text-xs"
    >
      <span>{t(`web.connect.${stage}`)}</span>
      {error && <span className="text-foreground">{error.message}</span>}
      <ConnectAction
        error={error}
        restart={restartHost}
        attempting={attempting}
      />
    </div>
  );
};
