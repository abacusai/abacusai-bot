import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import {
  Bug,
  Gamepad2,
  GitPullRequest,
  Globe,
  PieChart,
  Plane,
  Plus,
  ShoppingBag,
  Sparkles,
  Table2,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { SendError } from "#renderer/components/send-error";
import { useDb } from "#renderer/data/db";
import { isListedSession } from "#renderer/data/db/filters";
import { usePrefs } from "#renderer/data/db/prefs";
import { isDiskFullError } from "#renderer/data/query-client";
import type { Transport } from "#renderer/data/transport";
import { StreakChip } from "#renderer/features/streak/streak-chip";
import { defaultLook } from "#renderer/lib/bots/avatar";
import {
  BUILD_STARTER_IDS,
  CODE_STARTER_IDS,
  GITHUB_CONNECTOR_ID,
} from "#renderer/lib/build-starters";
import {
  draftStore,
  updateDraft,
} from "#renderer/lib/continuity/composer-drafts";
import { formatChatStamp } from "#renderer/lib/format/chat-stamp";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";

import {
  CodingRoutinesRow,
  useCodingRoutinesOffered,
} from "../../routines/coding-routines";
import { SessionContextTray } from "../context/context-tray";
import {
  useGitState,
  useSessionsTransport,
  useWorkspace,
} from "../data/queries";
import { SESSION_STARTERS } from "../starters";
import { SendHint } from "./send-hint";
import {
  startDraftStore,
  startSession,
  optimisticSession,
  endFirstTaskHint,
  hasStartPrompt,
  takeStartPrompt,
  type SubmissionEnvelope,
} from "./start-session";
/** Phone starter cards lead with an icon, the way native quick prompts do. */
const STARTER_ICONS: Record<string, LucideIcon> = {
  "review-pull-requests": GitPullRequest,
  "design-an-infographic": PieChart,
  "build-a-store": ShoppingBag,
  "process-a-spreadsheet": Table2,
  "restyle-a-repo": Wand2,
  "find-flights": Plane,
  "portfolio-site": Globe,
  "shop-page": ShoppingBag,
  "simple-game": Gamepad2,
  "fix-a-bug": Bug,
  "add-a-feature": Plus,
  "review-my-prs": GitPullRequest,
};
/** The start page's grid: three across, two rows. */
const STARTER_SLOTS = 6;
/**
 * The start page's funnel, per draft: what waited in the box when it showed and
 * the starter last tapped, so a send says whether it was the example, a starter,
 * an edit or the user's own words.
 */
const funnelDrafts = new Map<
  string,
  { example: string; starter: string | null; edited: boolean }
>();
/**
 * Prompts the app sent for a draft by itself (the paid welcome's first task),
 * by draft id: their send is "auto", never the user's own words or an edit.
 */
const autoSent = new Map<string, string>();
/** Drafts whose first-run hint at Send was reported shown: once each. */
const hintShown = new Set<string>();
/** Fire-and-forget: a lost beacon must never block the page. */
const reportFunnel = (
  client: Transport["client"],
  step: FunnelStep,
  detail: string
) => void client.system.funnelStep({ step, detail }).catch(() => undefined);
const sentText = (envelope: SubmissionEnvelope): string =>
  envelope.parts
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("")
    .trim();

/** Sends a queued prompt as soon as the composer could; a failure leaves it in the box. */
export const QueuedPrompt = ({
  threadId,
  ready,
  forwardedProps,
  submit,
}: {
  threadId: string;
  ready: boolean;
  forwardedProps: Record<string, unknown>;
  submit(envelope: SubmissionEnvelope): Promise<void>;
}) => {
  useEffect(() => {
    if (!ready) return;
    const text = takeStartPrompt(threadId);
    if (text == null) return;
    autoSent.set(threadId.replace(/^draft:/, ""), text);
    void submit({
      runId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      parts: [{ type: "text", content: text }],
      forwardedProps,
    }).catch(() => updateDraft(threadId, (draft) => ({ ...draft, text })));
  }, [ready, threadId, forwardedProps, submit]);
  return null;
};
export interface StartComposerBinding {
  threadId: string;
  workspaceId: string | null;
  root: string | null;
  context: ReactNode;
  submit(envelope: SubmissionEnvelope): Promise<void>;
  blocked: boolean;
  pending: boolean;
  attachmentContext(): Promise<{ workspaceId: string; sessionId: string }>;
}
export const SessionStartPage = ({
  workspaceId,
  renderComposer,
  handoff,
  prefill,
  hintHeld = false,
}: {
  workspaceId: string | null;
  renderComposer: (binding: StartComposerBinding) => ReactNode;
  handoff: (id: string, envelope: SubmissionEnvelope) => Promise<void>;
  prefill: (id: string, text: string) => void;
  /** Another guide holds the screen (the welcome tour): the hint at Send waits. */
  hintHeld?: boolean;
}) => {
  const { t, i18n } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const { data: recent } = useLiveQuery(db.collections.sessions);
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const draft = useSelector(startDraftStore, (s) => s);
  const workspace = useWorkspace(draft.workspaceId ?? workspaceId ?? "");
  const pathStatus = useQuery({
    ...transport.orpc.workspaces.checkPath.queryOptions({
      input: { workspaceId: draft.workspaceId ?? workspaceId ?? "" },
    }),
    enabled: !!(draft.workspaceId ?? workspaceId),
    refetchOnWindowFocus: true,
  });
  const connectors = useQuery(
    transport.orpc.connectors.statuses.queryOptions({ input: {} })
  );
  const [now] = useState(() => Date.now());
  const [resume] = useState(() => draft.envelope !== null);
  const [inFlight] = useState(() => new Set<string>());
  const [pending, setPending] = useState(resume);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (draft.stage === "draft" && draft.workspaceId === null && workspaceId)
      startDraftStore.setState((s) => ({ ...s, workspaceId }));
  }, [workspaceId, draft.workspaceId, draft.stage]);
  const send = (envelope?: SubmissionEnvelope) =>
    startSession(
      {
        db,
        client: transport.client,
        handoff,
        navigate: (id) =>
          navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: id },
            transition: "nav-forward",
          }),
      },
      envelope
    )
      .catch((e) => {
        setError(isDiskFullError(e) ? t("errors.diskFull") : String(e));
        throw e;
      })
      .finally(() => {
        inFlight.delete("submit");
        setPending(false);
      });
  const client = transport.client;
  const submit = async (envelope: SubmissionEnvelope) => {
    if (inFlight.has("submit")) return;
    inFlight.add("submit");
    const seen = funnelDrafts.get(draft.id);
    const auto = autoSent.get(draft.id);
    autoSent.delete(draft.id);
    if (seen || auto != null) {
      funnelDrafts.delete(draft.id);
      const text = sentText(envelope);
      reportFunnel(
        client,
        "start_sent",
        auto != null && text === auto.trim()
          ? "auto"
          : seen?.example && text === seen.example.trim()
            ? "example"
            : seen?.starter && text === seen.starter.trim()
              ? "starter"
              : seen?.example || seen?.starter
                ? "edited"
                : "own"
      );
    }
    endFirstTaskHint(draft.id);
    setPending(true);
    setError(null);
    await send(envelope);
  };
  const resumeStart = useEffectEvent(() => {
    if (inFlight.has("submit")) return;
    inFlight.add("submit");
    queueMicrotask(() => void send().catch(() => {}));
  });
  useEffect(() => {
    if (resume) resumeStart();
  }, [resume]);
  // Onboarding's picks open with their sample in the box: the cursor waits there.
  const opensOnExample = draft.starters != null;
  useEffect(() => {
    if (!opensOnExample) return;
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea')
        ?.focus()
    );
    return () => cancelAnimationFrame(frame);
  }, [opensOnExample]);
  const id = `draft:${draft.id}`;
  useEffect(() => {
    if (draft.stage !== "draft" || funnelDrafts.has(draft.id)) return;
    const example = draftStore.state[id]?.text ?? "";
    funnelDrafts.set(draft.id, { example, starter: null, edited: false });
    // A first task the app sends itself may already be on its way.
    const auto = hasStartPrompt(id) || autoSent.has(draft.id);
    reportFunnel(
      client,
      "start_page_shown",
      `${draft.starters ?? "none"}_${auto ? "auto" : example ? "example" : "blank"}`
    );
    // The map entry keeps it to once per draft.
  }, [draft.id, draft.stage, draft.starters, id, client]);
  const boxText = useSelector(draftStore, (s) => s[id]?.text ?? "");
  useEffect(() => {
    const seen = funnelDrafts.get(draft.id);
    // Words of their own (or none): the sample is no longer what Send would send.
    if (seen != null && boxText !== seen.example) endFirstTaskHint(draft.id);
    if (
      seen == null ||
      seen.edited ||
      boxText === seen.example ||
      boxText === seen.starter
    )
      return;
    seen.edited = true;
    reportFunnel(client, "start_prompt_edited", draft.starters ?? "none");
    // `edited` keeps it to once per draft.
  }, [boxText, draft.id, draft.starters, client]);
  const hinting =
    draft.firstTask === true &&
    draft.stage === "draft" &&
    !hintHeld &&
    !pending;
  useEffect(() => {
    if (!hinting || hintShown.has(draft.id)) return;
    hintShown.add(draft.id);
    reportFunnel(client, "send_hint_shown", draft.starters ?? "none");
  }, [hinting, draft.id, draft.starters, client]);
  const buildStarters = BUILD_STARTER_IDS.map((starterId) => ({
    id: starterId,
    name: t(`sessions.start.build.${starterId}.name`),
    detail: t(`sessions.start.build.${starterId}.detail`),
    prompt: t(`sessions.start.build.${starterId}.prompt`),
  }));
  const codeStarters = CODE_STARTER_IDS.map((starterId) => ({
    id: starterId,
    name: t(`sessions.start.code.${starterId}.name`),
    detail: t(`sessions.start.code.${starterId}.detail`),
    prompt: t(`sessions.start.code.${starterId}.prompt`),
  }));
  const sessionStarters = SESSION_STARTERS.map((starter) => ({
    ...starter,
    name: t(`sessions.start.starters.${starter.id}.name`),
    detail: t(`sessions.start.starters.${starter.id}.detail`),
  }));
  const coding =
    draft.starters === "code" ||
    connectors.data?.[GITHUB_CONNECTOR_ID]?.state === "connected";
  const starters =
    draft.starters === "build"
      ? buildStarters
      : coding
        ? [
            ...codeStarters,
            // Its coding counterpart is already here, and works without a repository open.
            ...sessionStarters.filter((s) => s.id !== "review-pull-requests"),
          ].slice(0, STARTER_SLOTS)
        : sessionStarters;
  // Routines that keep this project healthy: a git project, past the first
  // task (value before routines), and never beside the build picks.
  const gitState = useGitState({ workspaceId: draft.workspaceId ?? "" });
  const routinesOffered = useCodingRoutinesOffered();
  const projectName =
    workspace?.label || workspace?.path?.split(/[\\/]/).pop() || null;
  const codingProject =
    routinesOffered &&
    draft.workspaceId != null &&
    projectName != null &&
    gitState?.gitAvailable === true &&
    draft.stage === "draft" &&
    draft.firstTask !== true &&
    draft.starters !== "build"
      ? { workspaceId: draft.workspaceId, name: projectName }
      : null;
  const context = draft.workspaceId ? (
    <SessionContextTray
      workspaceId={draft.workspaceId}
      worktree={draft.worktree}
      onWorkspace={
        draft.stage === "draft"
          ? (workspaceId) =>
              startDraftStore.setState((s) => ({ ...s, workspaceId }))
          : undefined
      }
      onWorktree={(worktree) =>
        startDraftStore.setState((s) => ({ ...s, worktree }))
      }
    />
  ) : null;
  return (
    <div
      data-slot="sessions-start"
      className="phone:justify-end phone:px-0 phone:pt-6 phone:pb-3 relative isolate flex size-full min-h-0 flex-col items-center justify-center px-6 py-8"
    >
      <div aria-hidden className="phone-glow phone:block hidden" />
      {/* Phones read bottom-up like a native agent screen: headline, a
          swipeable row of starters, then the composer under the thumb. */}
      <div className="phone:gap-5 flex w-full max-w-(--composer-max-w) flex-col gap-6">
        <div className="flex justify-center">
          <BotAvatar
            animate
            look={defaultLook("AbacusAI")}
            expression="curious"
            size={48}
          />
        </div>
        <h1 className="phone-rise phone:px-5 phone:text-start phone:text-[32px] phone:leading-[38px] phone:tracking-tight text-center text-[28px] leading-9 font-semibold">
          {t("sessions.start.heading")}
        </h1>
        <StreakChip />
        <div
          className="phone-rise phone:order-4 phone:px-3 phone:[&_[data-slot=composer]>.z-10]:min-h-[128px]"
          style={{ "--rise-i": 3 } as CSSProperties}
        >
          <SendError error={error} />
          <SendHint
            active={hinting}
            starters={draft.starters}
            onDismiss={() => {
              endFirstTaskHint(draft.id);
              reportFunnel(
                client,
                "send_hint_dismissed",
                draft.starters ?? "none"
              );
            }}
          />
          <div onChangeCapture={() => setError(null)}>
            {renderComposer({
              threadId: id,
              attachmentContext: async () => {
                const current = startDraftStore.state;
                if (!current.workspaceId)
                  throw new Error("Select a workspace before uploading files");
                await db.collections.sessions.preload();
                const existing = db.collections.sessions.get(current.id);
                if (existing && existing.workspaceId !== current.workspaceId)
                  throw new Error(
                    "Session identity belongs to another workspace"
                  );
                if (!existing)
                  await db.collections.sessions.insert(
                    optimisticSession(current)
                  ).isPersisted.promise;
                return {
                  workspaceId: current.workspaceId,
                  sessionId: current.id,
                };
              },
              workspaceId: draft.workspaceId,
              root: workspace?.path ?? null,
              context,
              submit,
              pending,
              blocked: !draft.workspaceId || pathStatus.data?.exists === false,
            })}
          </div>
        </div>
        {!prefs.sidebar.pinned &&
        workspace &&
        (recent ?? []).some(
          (s) => isListedSession(s) && s.workspaceId === workspace.id
        ) ? (
          <div className="phone:order-2 phone:px-3">
            <h2 className="phone:px-2 text-sm">
              {t("sessions.start.recent", {
                workspace:
                  workspace.label || workspace.path?.split(/[\\/]/).pop(),
              })}
            </h2>
            {(recent ?? [])
              .filter(
                (s) => isListedSession(s) && s.workspaceId === workspace?.id
              )
              .toSorted(
                (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
              )
              .slice(0, 4)
              .map((s) => (
                <AppLink
                  key={s.id}
                  to="/sessions/$sessionId"
                  params={{ sessionId: s.id }}
                  className="flex justify-between rounded-lg p-2 text-sm"
                >
                  <span>{s.label || t("sessions.untitled")}</span>
                  <time dateTime={s.updatedAt}>
                    {formatChatStamp(
                      Date.parse(s.updatedAt),
                      now,
                      i18n.language,
                      t("sessions.yesterday")
                    )}
                  </time>
                </AppLink>
              ))}
          </div>
        ) : null}
        <div className="phone:order-3">
          <p
            className="phone-rise text-foreground/75 phone:px-5 mb-2 text-xs"
            style={{ "--rise-i": 1 } as CSSProperties}
          >
            {t("sessions.start.try")}
          </p>
          <div className="phone:flex phone:snap-x phone:snap-mandatory phone:overflow-x-auto phone:px-5 phone:scroll-px-5 no-scrollbar grid grid-cols-3 gap-2">
            {starters.map((starter, index) => (
              <Button
                key={starter.id}
                aria-disabled={pending}
                variant="secondary"
                style={{ "--rise-i": index + 1 } as CSSProperties}
                className="phone-rise phone:h-[132px] phone:w-[156px] phone:shrink-0 phone:snap-start phone:justify-between phone:rounded-[22px] phone:border phone:border-foreground/[0.08] phone:bg-foreground/[0.045] phone:backdrop-blur-xl phone:p-3.5 phone:font-medium h-auto min-h-20 flex-col items-start gap-2 rounded-2xl p-3 text-start whitespace-normal"
                onClick={() => {
                  if (pending) return;
                  setError(null);
                  prefill(id, starter.prompt);
                  const seen = funnelDrafts.get(draft.id);
                  if (seen) seen.starter = starter.prompt;
                  if (!codeStarters.some((code) => code.id === starter.id))
                    reportFunnel(client, "start_starter_tapped", starter.id);
                  if (codeStarters.some((code) => code.id === starter.id))
                    void transport.client.system
                      .funnelStep({
                        step: "code_starter_tapped",
                        detail: starter.id,
                      })
                      .catch(() => undefined);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLTextAreaElement>(
                        '[data-slot="composer"] textarea'
                      )
                      ?.focus()
                  );
                }}
              >
                {(() => {
                  const Icon = STARTER_ICONS[starter.id] ?? Sparkles;
                  return (
                    <Icon
                      aria-hidden
                      className="text-muted-foreground phone:block hidden size-4"
                    />
                  );
                })()}
                <span className="flex flex-col gap-1">
                  <span>{starter.name}</span>
                  <span className="text-foreground/75 phone:line-clamp-2 text-xs font-normal">
                    {starter.detail}
                  </span>
                </span>
              </Button>
            ))}
          </div>
          {codingProject != null && (
            <div className="mt-4">
              <CodingRoutinesRow
                workspaceId={codingProject.workspaceId}
                projectName={codingProject.name}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
