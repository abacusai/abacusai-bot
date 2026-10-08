/**
 * The host connection, as the browser shows it (spec 09 D4). Sign-in and tier
 * refusals replace the app (`ConnectScreen`), a full web host the busy page
 * (`LimitScreen`), a failed connection the retry page (`FailedScreen`). A
 * first visit shows the setup checklist (`SetupScreen`) until the host opens;
 * a returning user gets the shell at once with a small pill (`HostStatus`).
 */
import { useSelector } from "@tanstack/react-store";
import { CheckIcon } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";
import { defaultLook } from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import { webSignInHref } from "#renderer/lib/navigation/web-sign-in";
import { holdTheme } from "#renderer/lib/theme";
import { Button } from "#renderer/ui/button";
import { Spinner } from "#renderer/ui/spinner";

import {
  ConnectError,
  hostConnection,
  restartHost,
  retryHostNow,
  type ConnectStage,
} from "./services";

const kindOf = (error?: Error | null) =>
  error ? (error instanceof ConnectError ? error.kind : "connection") : null;

/**
 * Which full screen a failure takes, for both places that show one. Retrying
 * a connection means the running loop's next attempt (`retry-now`) when one
 * runs behind the page, and a reload when none does.
 */
export type FailureScreen =
  | { kind: "refused" }
  | { kind: "limit" }
  | { kind: "failed"; retry: "reload" | "retry-now" }
  | { kind: "banner" }
  | null;

export const failureScreen = (
  error: Error | null | undefined,
  loopRunning: boolean
): FailureScreen => {
  switch (kindOf(error)) {
    case null:
      return null;
    case "signin":
    case "tier":
      return { kind: "refused" };
    case "limit":
      return { kind: "limit" };
    case "connection":
      return { kind: "failed", retry: loopRunning ? "retry-now" : "reload" };
    case "reload":
      return { kind: "failed", retry: "reload" };
    case "version":
      return { kind: "banner" };
  }
};

const ConnectAction = ({
  error,
  restart,
}: {
  error?: Error | null;
  restart(): void;
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
  return null;
};

/** The page's own words for a refusal: an error's text is for the console. */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  signin: "signedOut",
  tier: "tierRequired",
  version: "hostOutdated",
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
  useEffect(() => {
    if (error) console.warn("[connect] host refused", error);
  }, [error]);
  // No connection loop runs behind this screen.
  const screen = failureScreen(error, false);
  if (screen?.kind === "limit") return <LimitScreen />;
  if (screen?.kind === "failed")
    return <FailedScreen error={error} retry={() => location.reload()} />;
  return (
    <main
      className="bg-background text-foreground fixed inset-0 z-50 flex h-screen flex-col items-center justify-center gap-4"
      role="status"
    >
      <p>
        {t(`web.connect.${REFUSAL_TEXT[kindOf(error) ?? "none"] ?? stage}`)}
      </p>
      <ConnectAction error={error} restart={restart} />
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
          animate
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

/** Holds the light theme while mounted; releasing it restores what was under it. */
const useLightOnly = (): void => {
  useEffect(() => holdTheme("light"), []);
};

const SETUP_STEPS = [
  { key: "stepStarting", progress: "33%" },
  { key: "stepInstalling", progress: "66%" },
  { key: "stepConnecting", progress: "92%" },
] as const;

/** Every stage's setup step, exhaustively. */
const SETUP_STEP_OF = {
  starting: 0,
  installing: 1,
  updating: 1,
  connecting: 2,
  reconnecting: 2,
  open: 2,
} as const satisfies Record<ConnectStage, 0 | 1 | 2>;

/** A first visit: the host is being set up, a full page with its steps. */
export const SetupScreen = ({ stage }: { stage: ConnectStage }) => {
  const { t } = useTranslation();
  useLightOnly();
  const current = SETUP_STEP_OF[stage];
  return (
    <main
      data-slot="host-setup"
      role="status"
      className="bg-background text-foreground fixed inset-0 z-50 flex min-h-dvh flex-col items-center justify-center overflow-y-auto px-6 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex w-full max-w-[400px] flex-col items-center gap-8 text-center">
        <BotAvatar
          animate
          look={defaultLook("AbacusAI Bot")}
          mood="idle"
          size={112}
        />
        <div className="flex flex-col gap-3">
          <h1 className="text-[26px] leading-8 font-semibold tracking-tight text-balance">
            {t("web.connect.setupTitle")}
          </h1>
          <p className="text-muted-foreground text-[15px] leading-[22px] text-pretty">
            {t("web.connect.setupBody")}
          </p>
        </div>
        <div className="flex w-full flex-col gap-5">
          <ol className="flex flex-col gap-3 text-left text-[15px]">
            {SETUP_STEPS.map((step, index) => (
              <li
                key={step.key}
                data-state={
                  index < current
                    ? "done"
                    : index === current
                      ? "current"
                      : "pending"
                }
                className={cn(
                  "flex items-center gap-3",
                  index > current && "text-muted-foreground"
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {index < current ? (
                    <CheckIcon
                      aria-hidden
                      className="size-5 text-emerald-600"
                      strokeWidth={2.5}
                    />
                  ) : index === current ? (
                    <Spinner aria-hidden className="size-5" />
                  ) : (
                    <span className="border-border size-4 rounded-full border-2" />
                  )}
                </span>
                {t(`web.connect.${step.key}`)}
              </li>
            ))}
          </ol>
          <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-700 ease-out"
              style={{ width: SETUP_STEPS[current].progress }}
            />
          </div>
        </div>
      </div>
    </main>
  );
};

/**
 * The host could not be reached: the sleeping bot and a retry. The error's
 * own text is for the console, never the page.
 */
export const FailedScreen = ({
  error,
  retry,
  attempting = false,
}: {
  error?: Error | null;
  retry(): void;
  attempting?: boolean;
}) => {
  const { t } = useTranslation();
  useLightOnly();
  useEffect(() => {
    if (error) console.warn("[connect] host unreachable", error);
  }, [error]);
  return (
    <main
      data-slot="host-failed"
      role="alert"
      className="bg-background text-foreground fixed inset-0 z-50 flex min-h-dvh flex-col items-center justify-center overflow-y-auto px-6 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex w-full max-w-[400px] flex-col items-center gap-6 text-center">
        <BotAvatar
          animate
          look={defaultLook("AbacusAI Bot")}
          mood="asleep"
          size={112}
        />
        <div className="flex flex-col gap-3">
          <h1 className="text-[26px] leading-8 font-semibold tracking-tight text-balance">
            {t("web.connect.failedTitle")}
          </h1>
          <p className="text-muted-foreground text-[15px] leading-[22px] text-pretty">
            {t("web.connect.failedBody")}
          </p>
        </div>
        <div className="flex w-full flex-col items-center gap-4">
          <Button
            size="lg"
            className="h-12 w-full rounded-full text-base"
            onClick={retry}
            disabled={attempting}
          >
            {attempting && <Spinner aria-hidden />}
            {t("web.connect.tryAgain")}
          </Button>
          <a
            href={DESKTOP_DOWNLOAD_URL}
            target="_blank"
            rel="noopener"
            className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
          >
            {t("web.connect.desktopInstead")}
          </a>
        </div>
      </div>
    </main>
  );
};

/** The pill's words for every stage, exhaustively. */
const PILL_LABEL = {
  starting: "waking",
  installing: "waking",
  updating: "updating",
  connecting: "connecting",
  reconnecting: "reconnecting",
  open: "waking",
} as const satisfies Record<ConnectStage, string>;

/** A returning user's shell, while the host wakes: a pill at the top. */
export const StatusPill = ({ stage }: { stage: ConnectStage }) => {
  const { t } = useTranslation();
  return (
    <div
      data-slot="host-status"
      role="status"
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <span className="bg-background text-muted-foreground border-border flex items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-xs">
        <Spinner aria-hidden className="size-3.5" />
        {t(`web.connect.${PILL_LABEL[stage]}`)}
      </span>
    </div>
  );
};

/** The shell's view of `hostConnection`: nothing while a socket is open. */
export const HostStatus = () => {
  const { t } = useTranslation();
  const { stage, error, attempting, firstVisit } = useSelector(
    hostConnection,
    (state) => state
  );
  // The connection loop runs behind the shell.
  const screen = failureScreen(error, true);
  if (screen?.kind === "refused" || screen?.kind === "limit")
    return <ConnectScreen stage={stage} error={error} />;
  if (screen?.kind === "failed")
    return (
      <FailedScreen
        error={error}
        retry={
          screen.retry === "retry-now" ? retryHostNow : () => location.reload()
        }
        attempting={screen.retry === "retry-now" && attempting}
      />
    );
  if (stage === "open") return null;
  if (screen?.kind === "banner")
    return (
      <div
        data-slot="host-status"
        role="status"
        className="bg-muted text-muted-foreground fixed inset-x-0 top-0 z-40 flex items-center justify-center gap-3 px-4 py-1 text-xs"
      >
        <span>{t(`web.connect.${stage}`)}</span>
        <ConnectAction error={error} restart={restartHost} />
      </div>
    );
  if (firstVisit) return <SetupScreen stage={stage} />;
  return <StatusPill stage={stage} />;
};
