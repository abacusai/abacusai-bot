/**
 * The first-run screen: what to do first, each pick starting work at once.
 * After a Gmail sign-in the Chief of Staff's first inbox pass leads the same list.
 */
import { HOME_CHANNEL_NAMES, type HomeChannel } from "@abacus-ai/contract/bots";
import type { BotRow } from "@abacus-ai/contract/contract";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  ArrowUp,
  Code2,
  FileText,
  GitBranch,
  ImageIcon,
  MessageCircle,
} from "lucide-react";
import { useState, type ComponentProps, type ReactNode, type Ref } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { Spinner } from "#renderer/components/spinner";
import { resolveLook } from "#renderer/lib/bots/avatar";
import {
  GITHUB_CONNECTOR_ID,
  PROJECT_TABS,
  type ProjectStarter,
  type ProjectTab,
  projectsIn,
} from "#renderer/lib/build-starters";
import { cn } from "#renderer/lib/cn";
import { PROJECT_ICONS } from "#renderer/lib/project-icons";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#renderer/ui/tabs";

import {
  type FirstBotState,
  type FirstChoice,
  type FirstRunCard,
  firstRunCards,
  type GithubChoice,
  type InboxPass,
} from "../first-bot";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepLink, StepLinks, StepTitle } from "./kit";

/** Long enough for a real ask, short enough to stay a whole mission. */
const GOAL_MAX = 1500;

/** A card's button: filled when the card leads, outlined otherwise. */
const CardAction = ({
  primary,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  primary: boolean;
}) =>
  primary ? (
    <StepButton className={cn("h-9 px-4", className)} {...props} />
  ) : (
    <Button
      variant="outline"
      className={cn("h-9 px-4 text-sm", className)}
      {...props}
    />
  );

const ChoiceCard = ({
  icon,
  title,
  body,
  action,
  primary = false,
  children,
  slot,
  app,
}: {
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
  action: ReactNode;
  primary?: boolean;
  children?: ReactNode;
  slot: string;
  /** The chat app a `chat-app` card opens. */
  app?: HomeChannel;
}) => (
  <div
    data-first-choice={slot}
    data-app={app}
    data-primary={primary}
    className={cn(
      "onboarding-card flex flex-col gap-3 rounded-[14px] py-3 pr-3 pl-4",
      primary && "onboarding-card-primary"
    )}
  >
    <div className="flex items-center gap-3">
      <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
          {title}
        </span>
        <span className="onboarding-quiet block">{body}</span>
      </span>
      {action}
    </div>
    {children}
  </div>
);

export const FirstBotStep = ({
  ctx,
  first,
  bot,
  present,
  heading,
  inbox,
  chatApps,
  github,
}: {
  ctx: StepContext;
  first: FirstBotState;
  bot: BotRow | null;
  /** The bot is still in the collection (or is a gallery preview). */
  present: boolean;
  heading: Ref<HTMLHeadingElement>;
  inbox: InboxPass;
  /** The chat apps linked during onboarding, the last one first. */
  chatApps: readonly HomeChannel[];
  github: GithubChoice;
}) => {
  const { t, busy, props, perform } = ctx;
  const [goal, setGoal] = useState("");
  const [tab, setTab] = useState<ProjectTab>("popular");
  const funnel = (step: FunnelStep, detail?: string) =>
    props.transport.client.system.funnelStep({
      step,
      ...(detail != null ? { detail } : {}),
    });
  const [connecting, setConnecting] = useState(false);
  // The sign-in starts inside the click, or the browser blocks its tab.
  const startGithub = () =>
    void perform(async () => {
      const signIn =
        github === "connect" ? props.connect?.(GITHUB_CONNECTOR_ID) : null;
      setConnecting(signIn != null);
      const signedIn = signIn?.finally(() => setConnecting(false));
      await funnel("first_choice_github");
      // Backing out of the sign-in leaves the screen to pick again.
      if (signedIn != null && (await signedIn)?.ok !== true) return;
      await props.choose({ kind: "github" });
    });
  const pick = (step: FunnelStep, choice: FirstChoice, detail?: string) =>
    void perform(async () => {
      await funnel(step, detail);
      await props.choose(choice);
    });
  const pickProject = (project: ProjectStarter) =>
    project.kind === "build"
      ? pick(
          "first_choice_build",
          {
            kind: "build",
            prompt: t(`sessions.start.build.${project.id}.prompt`),
          },
          project.id.replaceAll("-", "_")
        )
      : pick(
          "first_choice_template",
          { kind: "template", templateId: project.templateId },
          project.id.replaceAll("-", "_")
        );
  const showTab = (next: ProjectTab) => {
    setTab(next);
    void funnel("first_project_category", next).catch(() => undefined);
  };
  const buildCard = (
    primary: boolean,
    title: string,
    projects: readonly ProjectStarter[]
  ) => (
    <ChoiceCard
      key="build"
      slot="build"
      primary={primary}
      icon={<Code2 aria-hidden className="size-5" />}
      title={title}
      body={t("onboarding.firstRun.projects.body")}
      action={
        <CardAction
          primary={primary}
          disabled={busy}
          onClick={() =>
            pick("first_choice_build", { kind: "build", prompt: null }, "open")
          }
        >
          {t("onboarding.firstRun.build.cta")}
        </CardAction>
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = PROJECT_TABS.find((id) => id === value);
          if (next != null) showTab(next);
        }}
        className="gap-2.5"
      >
        <TabsList
          aria-label={t("onboarding.firstRun.projects.label")}
          className="no-scrollbar w-full max-w-full justify-start overflow-x-auto"
        >
          {PROJECT_TABS.map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              data-project-category={id}
              className="flex-none px-2.5 text-[13px]"
            >
              {t(`onboarding.firstRun.projects.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent
          value={tab}
          className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1"
        >
          {projects.map((project) => {
            const Icon = PROJECT_ICONS[project.id] ?? Code2;
            return (
              <Button
                key={project.id}
                variant="secondary"
                data-project={project.id}
                data-project-kind={project.kind}
                disabled={busy}
                className="h-auto min-h-16 items-start justify-start gap-2.5 rounded-xl px-3 py-2.5 text-start whitespace-normal"
                onClick={() => pickProject(project)}
              >
                <Icon
                  aria-hidden
                  className="text-primary mt-0.5 size-4 shrink-0"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] leading-snug font-medium">
                    {t(`sessions.start.build.${project.id}.name`)}
                  </span>
                  <span className="text-foreground/70 text-xs leading-snug font-normal">
                    {t(`sessions.start.build.${project.id}.detail`)}
                  </span>
                </span>
              </Button>
            );
          })}
        </TabsContent>
      </Tabs>
    </ChoiceCard>
  );
  const tour = (botId: string | null) => (
    <StepLinks className="mt-3 justify-center">
      {[
        <StepLink
          key="tour"
          disabled={busy}
          onClick={() =>
            void perform(() =>
              botId != null
                ? props.complete({ to: "bot-tour", botId })
                : props.choose({ kind: "tour" })
            )
          }
        >
          {t("tour.replay")}
        </StepLink>,
      ]}
    </StepLinks>
  );
  if (first.state === "pending" || first.state === "idle")
    return (
      <div className="mt-6">
        <Spinner />
      </div>
    );
  if (first.state === "removed")
    return (
      <>
        <StepTitle ref={heading}>{t("onboarding.pages.removed")}</StepTitle>
        <div className="mt-4">
          <StepButton
            disabled={busy}
            onClick={() =>
              void perform(() => props.complete({ to: "new-bot" }))
            }
          >
            {t("onboarding.connectorsContinue")}
          </StepButton>
        </div>
      </>
    );
  const submitGoal = () => {
    const words = goal.trim();
    if (words.length === 0) return;
    pick("first_choice_freetext", { kind: "goal", goal: words });
  };
  const cosBot = first.state === "ready" ? bot : null;
  const empty = inbox.state === "done" && inbox.drafts === 0;
  const inboxCard = (primary: boolean) => {
    if (cosBot == null) return null;
    const name = cosBot.name;
    const look = resolveLook({
      name,
      avatarShape: cosBot.avatarShape,
      avatarColor: cosBot.avatarColor,
    });
    return (
      <div
        key="inbox"
        data-first-choice="inbox"
        data-primary={primary}
        className={cn(
          "onboarding-card flex items-center gap-3 rounded-[14px] py-3 pr-3 pl-4",
          primary && "onboarding-card-primary"
        )}
      >
        <BotAvatar animate look={look} size={40} mood="wink" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {!present
              ? t("onboarding.pages.removed")
              : inbox.state === "done" && !empty
                ? t("onboarding.firstRun.inbox.count", {
                    count: inbox.drafts,
                  })
                : empty
                  ? t("onboarding.firstRun.inbox.keepTitle")
                  : name}
          </span>
          <span className="onboarding-quiet block">
            {inbox.state === "reading"
              ? t("onboarding.firstRun.inbox.readingBody")
              : inbox.state === "stopped"
                ? t("onboarding.firstRun.inbox.stoppedBody")
                : empty
                  ? t("onboarding.firstRun.inbox.keepBody", { name })
                  : t("onboarding.firstRun.inbox.countBody")}
          </span>
        </span>
        {inbox.state === "reading" && <Spinner />}
        <CardAction
          primary={primary && inbox.state !== "reading"}
          disabled={busy || !present}
          onClick={() =>
            void perform(() => props.choose({ kind: "bot", botId: cosBot.id }))
          }
        >
          {inbox.state === "reading"
            ? t("onboarding.firstRun.inbox.watch")
            : inbox.state === "stopped"
              ? t("onboarding.firstRun.inbox.open")
              : empty
                ? t("onboarding.firstRun.inbox.keepCta")
                : t("onboarding.firstRun.inbox.review")}
        </CardAction>
      </div>
    );
  };
  const chatAppCard = (app: HomeChannel, primary: boolean) => (
    <ChoiceCard
      key={`chat-app-${app}`}
      slot="chat-app"
      app={app}
      primary={primary}
      icon={<MessageCircle aria-hidden className="size-5" />}
      title={t("onboarding.firstRun.chatApp.title", {
        app: HOME_CHANNEL_NAMES[app],
      })}
      body={t("onboarding.firstRun.chatApp.body")}
      action={
        <CardAction
          primary={primary}
          disabled={busy}
          onClick={() =>
            pick("first_choice_whatsapp", { kind: "chat-app", app }, app)
          }
        >
          {t("onboarding.firstRun.chatApp.open")}
        </CardAction>
      }
    />
  );
  const githubCard = (choice: "connect" | "start", primary: boolean) => (
    <ChoiceCard
      key="github"
      slot="github"
      primary={primary}
      icon={<GitBranch aria-hidden className="size-5" />}
      title={t("onboarding.firstRun.github.title")}
      body={t("onboarding.firstRun.github.body")}
      action={
        connecting ? (
          <CardAction
            primary={false}
            onClick={() => props.cancelConnect?.(GITHUB_CONNECTOR_ID)}
          >
            {t("phase5.cancel")}
          </CardAction>
        ) : (
          <CardAction primary={primary} disabled={busy} onClick={startGithub}>
            {t(
              choice === "start"
                ? "onboarding.firstRun.github.start"
                : "onboarding.firstRun.github.connect"
            )}
          </CardAction>
        )
      }
    />
  );
  const card = ({
    card,
    primary,
  }: {
    card: FirstRunCard;
    primary: boolean;
  }) => {
    switch (card.slot) {
      case "inbox":
        return inboxCard(primary);
      case "build":
        return buildCard(
          primary,
          // Under an inbox with drafts, a project is the other thing to do.
          cosBot != null && !primary
            ? t("onboarding.firstRun.projects.otherTitle")
            : t("onboarding.firstRun.projects.title"),
          // Beside a Chief of Staff, the inbox is already being read.
          projectsIn(tab, cosBot != null ? ["morning-inbox"] : [])
        );
      case "github":
        return githubCard(card.github, primary);
      case "chat-app":
        return chatAppCard(card.app, primary);
      case "research":
        return (
          <ChoiceCard
            key="research"
            slot="research"
            primary={primary}
            icon={<FileText aria-hidden className="size-5" />}
            title={t("onboarding.firstRun.research.title")}
            body={t("onboarding.firstRun.research.body")}
            action={
              <CardAction
                primary={primary}
                disabled={busy}
                onClick={() =>
                  pick("first_choice_research", { kind: "research" })
                }
              >
                {t("onboarding.firstRun.research.cta")}
              </CardAction>
            }
          />
        );
      case "images":
        return (
          <ChoiceCard
            key="images"
            slot="images"
            primary={primary}
            icon={<ImageIcon aria-hidden className="size-5" />}
            title={
              <>
                {t("onboarding.firstRun.images.title")}
                <Badge variant="secondary">
                  {t("onboarding.firstRun.images.plan")}
                </Badge>
              </>
            }
            body={t("onboarding.firstRun.images.body")}
            action={
              <CardAction
                primary={primary}
                disabled={busy}
                onClick={() =>
                  pick(
                    "first_choice_images",
                    { kind: "images" },
                    props.facts.payingTier ? "paid" : "free"
                  )
                }
              >
                {t("onboarding.firstRun.images.cta")}
              </CardAction>
            }
          />
        );
    }
  };
  const cards = firstRunCards({
    inbox: cosBot == null ? null : empty ? "quiet" : "lead",
    chatApps,
    github,
  });
  return (
    <>
      <StepTitle ref={heading}>
        {cosBot == null
          ? t("onboarding.firstRun.title")
          : inbox.state === "reading"
            ? t("onboarding.firstRun.inbox.readingTitle")
            : inbox.state === "stopped"
              ? t("onboarding.firstRun.inbox.stoppedTitle", {
                  name: cosBot.name,
                })
              : empty
                ? t("onboarding.firstRun.inbox.emptyTitle")
                : t("onboarding.firstRun.inbox.title")}
      </StepTitle>
      {(cosBot == null || inbox.state === "done") && (
        <StepBody className="mt-1.5 max-w-[520px]">
          {cosBot == null
            ? t("onboarding.firstRun.subtitle")
            : t("onboarding.firstRun.inbox.subtitle", { name: cosBot.name })}
        </StepBody>
      )}
      <div
        className="mt-6 flex w-full max-w-[560px] flex-col gap-2.5"
        aria-live={cosBot != null ? "polite" : undefined}
      >
        {cards.map(card)}
        <form
          className="mt-1 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitGoal();
          }}
        >
          <Input
            value={goal}
            maxLength={GOAL_MAX}
            aria-label={t("onboarding.firstRun.goal.label")}
            placeholder={t("onboarding.firstRun.goal.placeholder")}
            className="h-10 rounded-[12px] px-3 text-sm md:text-sm"
            onChange={(event) => setGoal(event.target.value)}
          />
          <Button
            type="submit"
            size="icon"
            className="size-10 shrink-0 rounded-[12px]"
            aria-label={t("onboarding.firstRun.goal.send")}
            disabled={busy || goal.trim().length === 0}
          >
            <ArrowUp aria-hidden />
          </Button>
        </form>
        {tour(cosBot?.id ?? null)}
      </div>
    </>
  );
};
