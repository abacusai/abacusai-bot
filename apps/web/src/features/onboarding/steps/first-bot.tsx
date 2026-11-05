/**
 * The first-run screen: what to do first, each pick starting work at once.
 * After a Gmail sign-in it shows the Chief of Staff's first inbox pass instead.
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
import { BUILD_STARTER_IDS } from "#renderer/lib/build-starters";
import { cn } from "#renderer/lib/cn";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import {
  GITHUB_CONNECTOR_ID,
  type FirstBotState,
  type FirstChoice,
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
}: {
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
  action: ReactNode;
  primary?: boolean;
  children?: ReactNode;
  slot: string;
}) => (
  <div
    data-first-choice={slot}
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
  chatApp,
  github,
}: {
  ctx: StepContext;
  first: FirstBotState;
  bot: BotRow | null;
  /** The bot is still in the collection (or is a gallery preview). */
  present: boolean;
  heading: Ref<HTMLHeadingElement>;
  inbox: InboxPass;
  /** The chat app linked during onboarding: its card leads. */
  chatApp: HomeChannel | null;
  github: GithubChoice;
}) => {
  const { t, busy, props, perform } = ctx;
  const [goal, setGoal] = useState("");
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
  const buildCard = (primary: boolean, title: string) => (
    <ChoiceCard
      slot="build"
      primary={primary}
      icon={<Code2 aria-hidden className="size-5" />}
      title={title}
      body={t("onboarding.firstRun.build.body")}
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
      <div className="flex flex-wrap gap-2 pl-13">
        {BUILD_STARTER_IDS.map((id) => (
          <Button
            key={id}
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={busy}
            onClick={() =>
              pick(
                "first_choice_build",
                {
                  kind: "build",
                  prompt: t(`sessions.start.build.${id}.prompt`),
                },
                id.replaceAll("-", "_")
              )
            }
          >
            {t(`sessions.start.build.${id}.name`)}
          </Button>
        ))}
      </div>
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
                : props.complete({ to: "new-session" }, { tour: true })
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
  if (first.state === "ready" && bot) {
    const name = bot.name;
    const look = resolveLook({
      name,
      avatarShape: bot.avatarShape,
      avatarColor: bot.avatarColor,
    });
    const openBot = () =>
      void perform(() => props.choose({ kind: "bot", botId: bot.id }));
    const avatar = <BotAvatar animate look={look} size={40} mood="wink" />;
    const empty = inbox.state === "done" && inbox.drafts === 0;
    return (
      <>
        <StepTitle ref={heading}>
          {inbox.state === "reading"
            ? t("onboarding.firstRun.inbox.readingTitle")
            : inbox.state === "stopped"
              ? t("onboarding.firstRun.inbox.stoppedTitle", { name })
              : empty
                ? t("onboarding.firstRun.inbox.emptyTitle")
                : t("onboarding.firstRun.inbox.title")}
        </StepTitle>
        {inbox.state === "done" && (
          <StepBody className="mt-1.5 max-w-[520px]">
            {t("onboarding.firstRun.inbox.subtitle", { name })}
          </StepBody>
        )}
        <div
          className="mt-6 flex w-full max-w-[560px] flex-col gap-2.5"
          aria-live="polite"
        >
          {empty && buildCard(true, t("onboarding.firstRun.build.title"))}
          <div
            data-first-choice="inbox"
            data-primary={!empty}
            className={cn(
              "onboarding-card flex items-center gap-3 rounded-[14px] py-3 pr-3 pl-4",
              !empty && "onboarding-card-primary"
            )}
          >
            {avatar}
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
              primary={!empty && inbox.state !== "reading"}
              disabled={busy || !present}
              onClick={openBot}
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
          {!empty &&
            buildCard(false, t("onboarding.firstRun.inbox.buildTitle"))}
          {tour(bot.id)}
        </div>
      </>
    );
  }
  const chatAppCard = chatApp != null && (
    <ChoiceCard
      slot="chat-app"
      primary
      icon={<MessageCircle aria-hidden className="size-5" />}
      title={t("onboarding.firstRun.chatApp.title", {
        app: HOME_CHANNEL_NAMES[chatApp],
      })}
      body={t("onboarding.firstRun.chatApp.body")}
      action={
        <CardAction
          primary
          disabled={busy}
          onClick={() =>
            pick(
              "first_choice_whatsapp",
              { kind: "chat-app", app: chatApp },
              chatApp
            )
          }
        >
          {t("onboarding.firstRun.chatApp.open")}
        </CardAction>
      }
    />
  );
  // GitHub connected on the step before leads, as a linked chat app does.
  const githubLeads = chatApp == null && github === "start";
  const githubCard = github != null && (
    <ChoiceCard
      slot="github"
      primary={githubLeads}
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
          <CardAction
            primary={githubLeads}
            disabled={busy}
            onClick={startGithub}
          >
            {t(
              github === "start"
                ? "onboarding.firstRun.github.start"
                : "onboarding.firstRun.github.connect"
            )}
          </CardAction>
        )
      }
    />
  );
  const submitGoal = () => {
    const words = goal.trim();
    if (words.length === 0) return;
    pick("first_choice_freetext", { kind: "goal", goal: words });
  };
  return (
    <>
      <StepTitle ref={heading}>{t("onboarding.firstRun.title")}</StepTitle>
      <StepBody className="mt-1.5 max-w-[520px]">
        {t("onboarding.firstRun.subtitle")}
      </StepBody>
      <div className="mt-6 flex w-full max-w-[560px] flex-col gap-2.5">
        {chatAppCard}
        {githubLeads && githubCard}
        {buildCard(
          chatApp == null && !githubLeads,
          t("onboarding.firstRun.build.title")
        )}
        {!githubLeads && githubCard}
        <ChoiceCard
          slot="research"
          icon={<FileText aria-hidden className="size-5" />}
          title={t("onboarding.firstRun.research.title")}
          body={t("onboarding.firstRun.research.body")}
          action={
            <CardAction
              primary={false}
              disabled={busy}
              onClick={() =>
                pick("first_choice_research", { kind: "research" })
              }
            >
              {t("onboarding.firstRun.research.cta")}
            </CardAction>
          }
        />
        <ChoiceCard
          slot="images"
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
              primary={false}
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
        {tour(null)}
      </div>
    </>
  );
};
