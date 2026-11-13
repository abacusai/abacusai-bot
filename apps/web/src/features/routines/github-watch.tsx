/**
 * The GitHub watcher in the app (main's github-watch.ts does the reading):
 * the card on the Routines landing, its setup dialog, and the line in a
 * session's PR tab that turns it on for that repo. Each event has one
 * action, Fix it (Review for a new PR), which opens a session in the repo's
 * project with the task in the message box.
 */
import type {
  GithubWatchConfig,
  GithubWatchEvent,
  GithubWatchView,
} from "@abacus-ai/contract/contract/github";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  githubEventSubject,
  githubEventText,
} from "@abacus-ai/contract/github-watch";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, Lock, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMutation } from "#renderer/data/query-client";
import type { AppClient } from "#renderer/data/transport/types";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Checkbox } from "#renderer/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import { Switch } from "#renderer/ui/switch";

import { useAlwaysOnPlan } from "./always-on";

const EVENTS_SHOWN = 8;
/** Re-read while shown: a check runs every minute in main. */
const REFRESH_MS = 30_000;

const funnel = (
  client: AppClient,
  step: FunnelStep,
  detail?: string,
  once?: true
) =>
  void client.system
    .funnelStep({
      step,
      ...(detail != null ? { detail } : {}),
      ...(once ? { once } : {}),
    })
    .catch(() => undefined);

export const useGithubWatch = () => {
  const { transport } = useAppContext();
  return useQuery({
    ...transport.orpc.github.watch.queryOptions({ input: {} }),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
};

const useSetGithubWatch = () => {
  const { transport } = useAppContext();
  const cache = useQueryClient();
  return useMutation(
    transport.orpc.github.setWatch.mutationOptions({
      onSuccess: (view) =>
        cache.setQueryData(
          transport.orpc.github.watch.queryKey({ input: {} }),
          view
        ),
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
};

/** `owner/name` from a pull request's URL on github.com. */
export const repoOfPrUrl = (url: string): string | null =>
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? null;

/** Turn the watcher on, change its repos, or turn it off. */
export const GithubWatchDialog = ({
  view,
  initialRepos,
  onClose,
}: {
  view: GithubWatchView;
  /** Repos ticked when it is off (the PR tab's own repo). */
  initialRepos?: string[];
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const save = useSetGithubWatch();
  const on = view.config.on;
  const [repos, setRepos] = useState<string[]>(() =>
    on
      ? view.config.repos
      : (initialRepos ??
        view.candidates.slice(0, 3).map((candidate) => candidate.repo))
  );
  const [phoneFix, setPhoneFix] = useState(on ? view.config.phoneFix : true);
  const submit = (config: GithubWatchConfig) =>
    save.mutate(config, { onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="rounded-2xl p-5 sm:max-w-[520px]"
        data-testid="github-watch-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("githubWatch.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("githubWatch.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-muted-foreground mb-1 text-xs font-medium">
              {t("githubWatch.dialog.repos")}
            </legend>
            {view.candidates.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t("githubWatch.dialog.noRepos")}
              </p>
            ) : (
              view.candidates.map((candidate) => (
                <label
                  key={candidate.repo}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={repos.includes(candidate.repo)}
                    onCheckedChange={(checked) =>
                      setRepos((current) =>
                        checked
                          ? [...current, candidate.repo]
                          : current.filter((repo) => repo !== candidate.repo)
                      )
                    }
                  />
                  <span className="min-w-0 truncate">{candidate.repo}</span>
                </label>
              ))
            )}
          </fieldset>
          <label className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm">
                <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                  <Lock aria-hidden className="size-3.5" />
                  {t("githubWatch.dialog.fullAccess")}
                </span>{" "}
                {t("githubWatch.dialog.phoneFix")}
              </span>
              <span className="text-muted-foreground text-xs leading-snug">
                {t("githubWatch.dialog.phoneFixHint")}
              </span>
            </div>
            <Switch
              checked={phoneFix}
              onCheckedChange={(checked) => setPhoneFix(checked)}
              aria-label={t("githubWatch.dialog.phoneFix")}
            />
          </label>
          <p className="text-muted-foreground text-xs">
            {view.lanes.length > 0
              ? t("githubWatch.dialog.where", {
                  lanes: view.lanes.join(", "),
                })
              : t("githubWatch.dialog.whereApp")}
          </p>
        </div>
        <DialogFooter className="gap-2">
          {on && (
            <Button
              variant="ghost"
              className="me-auto"
              disabled={save.isPending}
              onClick={() =>
                submit({ on: false, repos: [], phoneFix: view.config.phoneFix })
              }
            >
              {t("githubWatch.dialog.turnOff")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t("githubWatch.dialog.cancel")}
          </Button>
          <Button
            disabled={repos.length === 0 || save.isPending}
            onClick={() => submit({ on: true, repos, phoneFix })}
            data-testid="github-watch-save"
          >
            {t(on ? "githubWatch.dialog.save" : "githubWatch.dialog.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** One event and its action. */
const GithubEventRow = ({ event }: { event: GithubWatchEvent }) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const words = (key: string, values?: Record<string, string | number>) =>
    t(key, values);
  const when = new Date(event.at).toLocaleString(i18n.language, {
    dateStyle: "short",
    timeStyle: "short",
  });
  const openSession = (sessionId: string) =>
    void navigate({
      to: "/sessions/$sessionId",
      params: { sessionId },
      transition: "nav-forward",
    });
  const action = () => {
    if (event.workspaceId == null) return;
    funnel(transport.client, "github_watch_fix", "app");
    void navigate({
      to: "/sessions/new",
      search: {
        workspace: event.workspaceId,
        prompt: event.prompt,
        offer: event.id,
      },
      transition: "nav-forward",
    });
  };
  return (
    <li
      className="flex items-start gap-3 py-3"
      data-testid="github-watch-event"
    >
      <span
        aria-hidden
        className={
          event.kind === "ci"
            ? "mt-1.5 size-2 shrink-0 rounded-full bg-red-500"
            : event.kind === "review"
              ? "mt-1.5 size-2 shrink-0 rounded-full bg-blue-500"
              : "bg-muted-foreground/50 mt-1.5 size-2 shrink-0 rounded-full"
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <a
          href={event.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium hover:underline"
        >
          {githubEventText(event, words)}
        </a>
        {event.kind === "review" && event.detail.length > 0 && (
          <span className="text-muted-foreground truncate text-xs">
            “{event.detail}”
          </span>
        )}
        <span className="text-muted-foreground text-xs">
          {event.whileAway ? `${when} · ${t("githubWatch.line.away")}` : when}
        </span>
        {event.workspaceId == null && (
          <span className="text-muted-foreground text-xs">
            {t("githubWatch.card.noProject")}
          </span>
        )}
      </div>
      {event.fix.state !== "none" && event.fix.sessionId != null ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSession(event.fix.sessionId!)}
        >
          {t(
            event.fix.state === "running"
              ? "githubWatch.card.fixing"
              : "githubWatch.card.openFix"
          )}
        </Button>
      ) : event.workspaceId != null ? (
        <Button
          size="sm"
          variant={event.kind === "ci" ? "default" : "outline"}
          onClick={action}
          aria-label={`${t(event.kind === "pr" ? "githubWatch.card.review" : "githubWatch.card.fix")}: ${githubEventSubject(event)}`}
        >
          {t(
            event.kind === "pr"
              ? "githubWatch.card.review"
              : "githubWatch.card.fix"
          )}
        </Button>
      ) : null}
    </li>
  );
};

/** On a free plan, under events found after the computer was off: Basic watches all day. */
const GithubAlwaysOnLine = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  useEffect(() => {
    funnel(transport.client, "github_watch_upsell_shown");
  }, [transport.client]);
  return (
    <div className="bg-muted/60 flex items-center gap-3 rounded-xl px-3 py-2 text-xs">
      <span className="flex-1">{t("githubWatch.card.upsell")}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          funnel(transport.client, "github_watch_upsell_tapped");
          void openUpgrade(transport.client, "app_routines");
        }}
      >
        <Sparkles aria-hidden />
        {t("githubWatch.card.upsellAction")}
      </Button>
    </div>
  );
};

const PROBLEM_KEYS = {
  "no-token": "githubWatch.problem.noToken",
  disabled: "githubWatch.problem.disabled",
  "rate-limited": "githubWatch.problem.rateLimited",
} as const;

/**
 * The Routines landing's GitHub card: the way to turn the watcher on when
 * the user has a project on GitHub, and what it found once it is on.
 */
export const GithubWatchCard = () => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const query = useGithubWatch();
  const plan = useAlwaysOnPlan();
  const [editing, setEditing] = useState(false);
  const view = query.data;
  const offered =
    view != null && (view.config.on || view.candidates.length > 0);
  useEffect(() => {
    if (offered && view?.config.on !== true)
      funnel(transport.client, "github_watch_offered", "routines", true);
  }, [offered, view?.config.on, transport.client]);
  if (view == null || !offered) return null;
  const events = view.events.slice(0, EVENTS_SHOWN);
  const away = plan === "free" && events.some((event) => event.whileAway);
  return (
    <section
      aria-label={t("githubWatch.card.title")}
      data-testid="github-watch-card"
      className="bg-background flex w-full flex-col gap-3 rounded-2xl border p-4 text-start"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[10px]"
        >
          <GitPullRequest className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm font-medium">
            {t(
              view.config.on
                ? "githubWatch.card.watching"
                : "githubWatch.card.title"
            )}
          </h2>
          <p className="text-muted-foreground text-xs leading-snug">
            {view.config.on
              ? view.checkedAt != null
                ? t("githubWatch.card.repos", {
                    repos: view.config.repos.join(", "),
                    time: new Date(view.checkedAt).toLocaleTimeString(
                      i18n.language,
                      { timeStyle: "short" }
                    ),
                  })
                : view.config.repos.join(", ")
              : t("githubWatch.card.description")}
          </p>
          {view.config.on && view.problem != null && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t(PROBLEM_KEYS[view.problem])}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={view.config.on ? "outline" : "default"}
          onClick={() => setEditing(true)}
          data-testid="github-watch-open"
        >
          {t(
            view.config.on ? "githubWatch.card.edit" : "githubWatch.card.start"
          )}
        </Button>
      </div>
      {view.config.on &&
        (events.length === 0 ? (
          <p className="text-muted-foreground ps-11 text-xs">
            {t("githubWatch.card.empty")}
          </p>
        ) : (
          <ul className="divide-y ps-11">
            {events.map((event) => (
              <GithubEventRow key={event.id} event={event} />
            ))}
          </ul>
        ))}
      {away && <GithubAlwaysOnLine />}
      {editing && (
        <GithubWatchDialog view={view} onClose={() => setEditing(false)} />
      )}
    </section>
  );
};

/** The PR tab's line: watch this pull request's repo (and so this PR). */
export const GithubWatchPrLine = ({ prUrl }: { prUrl: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const query = useGithubWatch();
  const save = useSetGithubWatch();
  const [setup, setSetup] = useState(false);
  const repo = repoOfPrUrl(prUrl);
  const view = query.data;
  const shown = repo != null && view != null;
  useEffect(() => {
    if (shown) funnel(transport.client, "github_watch_offered", "pr_tab", true);
  }, [shown, transport.client]);
  if (!shown) return null;
  const watching = view.config.on && view.config.repos.includes(repo);
  return (
    <label
      className="bg-muted/50 mx-3 my-2 flex items-center gap-3 rounded-lg px-3 py-2 text-xs"
      data-testid="github-watch-pr-line"
    >
      <span className="flex-1">{t("githubWatch.pr.line")}</span>
      <Switch
        checked={watching}
        disabled={save.isPending}
        onCheckedChange={(checked) => {
          if (checked && !view.config.on) {
            setSetup(true);
            return;
          }
          const repos = checked
            ? [...view.config.repos, repo]
            : view.config.repos.filter((entry) => entry !== repo);
          save.mutate({
            on: repos.length > 0,
            repos,
            phoneFix: view.config.phoneFix,
          });
        }}
        aria-label={t("githubWatch.pr.line")}
      />
      {setup && (
        <GithubWatchDialog
          view={view}
          initialRepos={[repo]}
          onClose={() => setSetup(false)}
        />
      )}
    </label>
  );
};
