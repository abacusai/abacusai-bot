import "./notch.css";
import { MotionConfig } from "motion/react";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { cueForNotice, permissionCueKey } from "#renderer/lib/attention/cues";
import { runErrorCopy } from "#renderer/lib/attention/error-copy";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { useMotionPreference } from "#renderer/lib/motion";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { runFinishedFeed } from "#renderer/lib/run-finished";
import { createSoundPlayer } from "#renderer/lib/sound";
import { useDictation } from "#renderer/lib/voice/use-dictation";
import {
  NotchContext,
  useNotch,
  type NotchRouterContext,
} from "#renderer/notch-context";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import type { OpenTarget } from "@abacus-ai/contract/contract";

import { NotchDirector, shapeSettled } from "./director";
import { notchDrafts as drafts } from "./drafts";
import { NotchSurface, NotchHeader, NotchBody } from "./frame";
import { followNotchEvents, useNotchInputs } from "./inputs";
import { ListeningControls } from "./listening";
import {
  presentNotch,
  botForSession,
  type NotchPresentation,
} from "./presenter";
import { shapeFor } from "./shape";
import { permissionLineageKey, type Snooze } from "./snooze";
export { NotchDirector } from "./director";
const ReplyAcceptedContext = createContext<
  (id: string, runId?: string) => void
>(() => {});
const choosePresentation = (
  automatic: NotchPresentation,
  manual: NotchPresentation | null,
  preview: boolean,
  mainFocused: boolean
): NotchPresentation =>
  automatic.quietUntil
    ? automatic
    : preview
      ? {
          ...automatic,
          route: "/idle",
          identity: "preview",
          expanded: false,
          hidden: false,
        }
      : manual && !mainFocused
        ? manual
        : automatic;
export const NotchShell = ({
  context,
  navigate,
  children,
}: {
  context: NotchRouterContext;
  navigate(p: NotchPresentation): Promise<void>;
  children: ReactNode;
}) => {
  const { transport, chat, db, prepareChat } = context;
  const { t } = useTranslation();
  const reduced = useMotionPreference() === "reduced";
  const [layout, setLayout] = useState(context.layout);
  const [app, setApp] = useState({ mainFocused: false });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(document.hasFocus());
  const [dictationError, setDictationError] = useState<
    "microphone" | "transcription" | null
  >(null);
  const [unlocked, setUnlocked] = useState(false);
  const [reaction, setReaction] = useState<{
    sessionId: string;
    botId?: string | null;
    until: number;
  } | null>(null);
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(
      () => setReaction(null),
      Math.max(0, reaction.until - Date.now())
    );
    return () => clearTimeout(timer);
  }, [reaction]);
  const [preview, setPreview] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const [acks, setAcks] = useState<ReadonlySet<string>>(new Set());
  const heldSessions = useRef(
    new Map<string, ReturnType<typeof chat.session>>()
  );
  const [snoozes, setSnoozes] = useState<ReadonlyMap<string, Snooze>>(
    new Map()
  );
  const lineageFor = (id: string) => {
    const descriptor =
      heldSessions.current.get(id)?.hostStore.state.store.state.permissions
        .items[0];
    return descriptor
      ? permissionLineageKey(descriptor.metadata.abacus.lineage)
      : undefined;
  };
  const inputs = useNotchInputs(transport, app, hovered, acks, snoozes);
  const [manual, setManual] = useState<NotchPresentation | null>(null);
  const automatic = presentNotch(inputs, inputs.now ?? 0);
  const target = choosePresentation(
    automatic,
    manual,
    preview,
    app.mainFocused
  );
  const [shown, setShown] = useState(target);
  const [bodySize, setBodySize] = useState<{
    identity: string;
    height: number;
  } | null>(null);
  const requestedShape = shapeFor(target, layout);
  if (target.expanded && bodySize?.identity === target.identity)
    requestedShape.height = Math.min(
      layout.maxShape.height,
      requestedShape.compactHeight + bodySize.height
    );
  const [shape, setShape] = useState<{ width: number; height: number }>(() =>
    shapeFor(target, layout)
  );
  const node = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const current = useRef({ reduced, navigate, inputs, shown, layout });
  useEffect(() => {
    current.current = { reduced, navigate, inputs, shown, layout };
  }, [reduced, navigate, inputs, shown, layout]);
  const audio = useRef(false);
  const player = useRef<ReturnType<typeof createSoundPlayer> | null>(null);
  const director = useRef<NotchDirector | null>(null);
  useEffect(() => {
    const value = new NotchDirector({
      load: async (id, signal) => {
        await prepareChat?.();
        signal.throwIfAborted();
        const session = chat.session(id);
        heldSessions.current.set(id, session);
        return session.load({ signal });
      },
      retire: (id) => {
        heldSessions.current.get(id)?.retire();
        heldSessions.current.delete(id);
      },
      setShape: (s, signal) => transport.client.notch.setShape(s, { signal }),
      navigate: (p) => current.current.navigate(p),
      audio: () => audio.current,
      renderedSize: () => {
        const rect = node.current?.getBoundingClientRect();
        return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
      },
      settle: (from, to, signal) =>
        node.current
          ? shapeSettled(
              node.current,
              from,
              to,
              current.current.reduced,
              signal
            )
          : Promise.resolve(),
      commit: (p, s) => {
        setShown(p);
        setShape(s);
      },
    });
    director.current = value;
    return () => {
      value.dispose();
      director.current = null;
    };
  }, [chat, transport, prepareChat]);
  const signature = `${target.identity}:${target.expanded}:${target.hidden}:${target.remaining}:${target.quietUntil}:${bodySize?.identity === target.identity ? bodySize.height : ""}:${layout.mode}:${layout.notch?.width}:${layout.notch?.height}:${layout.notch?.x}:${unlocked}:${target.queue.map((item) => item.descriptorId ?? item.runId ?? item.sessionId).join(",")}`;
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    void director.current
      ?.present(target, requestedShape)
      .catch((error) => console.warn("[notch] presentation failed", error));
  }, [signature, target, requestedShape, director]);
  useEffect(() => {
    director.current?.lock(hovered || focused);
  }, [hovered, focused, director]);
  useEffect(() => {
    const abort = new AbortController();
    void followNotchEvents(
      transport,
      (event) => {
        if (event.type === "layout") setLayout(event.layout);
        else if (event.type === "app")
          setApp({ mainFocused: event.mainFocused });
        else if (event.type === "reaction")
          setReaction({ sessionId: event.sessionId, until: Date.now() + 600 });
        else if (event.type === "shortcut") setHovered(true);
        else if (event.type === "preview") {
          setPreview(true);
          clearTimeout(previewTimer.current);
          previewTimer.current = setTimeout(() => setPreview(false), 3000);
        }
      },
      abort.signal
    );
    const focus = () => setFocused(document.hasFocus());
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    void transport.client.window.ready({ barrier: "subscriptions" });
    player.current = createSoundPlayer({
      isThreadVisible: () => false,
      isWindowFocused: () => false,
      prefs: () => current.current.inputs.prefs.sounds,
      now: Date.now,
      onUnlocked: () => {
        audio.current = true;
        setUnlocked(true);
      },
      claim: (cueId, threadId) =>
        transport.client.window
          .claimCue({ cueId, threadId })
          .then((result) => result.play),
    });
    const stop = runFinishedFeed(transport).subscribe((notice) => {
      const cue = cueForNotice(notice, { checkInRoutineIds: new Set() });
      if (cue && audio.current)
        player.current?.play(cue.kind, {
          threadId: notice.threadId,
          dedupeKey: cue.dedupeKey,
          botId:
            notice.owner?.botId ??
            current.current.inputs.routines.find(
              (routine) => routine.id === notice.routineId
            )?.botId ??
            null,
        });
    });
    return () => {
      abort.abort();
      stop();
      clearTimeout(previewTimer.current);
      clearTimeout(hoverTimer.current);
      clearTimeout(leaveTimer.current);
      player.current?.dispose();
      director.current?.dispose();
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
    };
  }, [transport, director]);
  const previousWaiting = useRef<Map<string, string> | null>(null);
  const previousAsks = useRef<Set<string> | null>(null);
  useEffect(() => {
    const next = new Set(inputs.asks.map((ask) => ask.id));
    if (previousAsks.current)
      for (const ask of inputs.asks)
        if (!previousAsks.current.has(ask.id) && audio.current) {
          const session = inputs.sessions.find(
            (session) => session.id === ask.sessionId
          );
          player.current?.play("needs-you", {
            threadId: ask.sessionId,
            dedupeKey: ask.id,
            botId: session ? botForSession(session, inputs.routines) : null,
          });
        }
    previousAsks.current = next;
  }, [inputs.asks, inputs.sessions, inputs.routines]);
  useEffect(() => {
    const next = new Map<string, string>();
    for (const session of inputs.sessions) {
      if (session.turn?.phase !== "waiting_permission") continue;
      const summary = inputs.summaries.get(session.id);
      if (!summary) continue;
      const key = permissionCueKey(summary);
      next.set(session.id, key);
      if (
        previousWaiting.current !== null &&
        previousWaiting.current.get(session.id) !== key &&
        audio.current
      )
        player.current?.play("needs-you", {
          threadId: session.id,
          dedupeKey: key,
          botId: botForSession(session, current.current.inputs.routines),
        });
    }
    previousWaiting.current = next;
  }, [inputs.sessions, inputs.summaries]);
  const faceStyle = useSharedElementName(
    shown.faces[0]?.botId ? `bot-identity-${shown.faces[0].botId}` : null
  );
  const open = () => {
    const p = current.current.shown;
    const session = db.collections.sessions.get(p.sessionId ?? "");
    if (!session) return;
    const target: OpenTarget = session.routineId
      ? {
          kind: "routine-run",
          routineId: session.routineId,
          sessionId: session.id,
        }
      : session.owner
        ? {
            kind: "bot",
            botId: session.owner.botId,
            sessionId: session.owner.role === "sender" ? session.id : undefined,
          }
        : { kind: "session", sessionId: session.id };
    void transport.client.notch.openInApp(target).then(() => {
      if (p.attention?.runId)
        setAcks(
          (state) => new Set([...state, p.attention!.runId!].slice(-500))
        );
      setHovered(false);
      setManual(null);
    });
  };
  const messageOperation = useRef<{
    generation: number;
    abort: AbortController;
  } | null>(null);
  const messageGeneration = useRef(0);
  useEffect(() => {
    if (!automatic.quietUntil) return;
    ++messageGeneration.current;
    messageOperation.current?.abort.abort();
    clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
    clearTimeout(leaveTimer.current);
    // Quiet policy must clear the local view before native focus IPC settles.
    // eslint-disable-next-line react/set-state-in-effect
    setManual(null);
    setHovered(false);
    setFocused(false);
    void transport.client.notch.focus({ focus: false }).catch(() => undefined);
  }, [automatic.quietUntil, transport]);
  const replyAccepted = (id: string, runId?: string) => {
    if (runId) setAcks((state) => new Set([...state, runId].slice(-500)));
    setReaction({
      sessionId: id,
      botId: current.current.shown.attention?.botId,
      until: Date.now() + 600,
    });
    if (current.current.shown.sessionId !== id) return;
    setManual(null);
    setHovered(false);
    setFocused(false);
    const compact = {
      ...current.current.shown,
      route: "/idle" as const,
      identity: `submitted:${id}`,
      sessionId: null,
      attention: null,
      expanded: false,
    };
    void director.current
      ?.present(compact, shapeFor(compact, layout))
      .catch(() => undefined);
    director.current?.lock(false);
    void transport.client.notch.focus({ focus: false });
  };

  useEffect(
    () => () => {
      messageGeneration.current++;
      messageOperation.current?.abort.abort();
    },
    []
  );
  const message = async (botId: string, call = false) => {
    messageOperation.current?.abort.abort();
    const generation = ++messageGeneration.current;
    const abort = new AbortController();
    messageOperation.current = { generation, abort };
    const timer = setTimeout(() => abort.abort(), 8000);
    const check = () => {
      if (abort.signal.aborted || generation !== messageGeneration.current)
        throw new DOMException("Superseded", "AbortError");
    };
    await (async () => {
      const handle = await transport.client.bots.openChat(
        { botId },
        { signal: abort.signal }
      );
      check();
      await prepareChat?.();
      check();
      await chat.session(handle.sessionId).load({ signal: abort.signal });
      check();
      const attention = {
        kind: "reply" as const,
        sessionId: handle.sessionId,
        since: Date.now(),
        botId,
        canReply: true,
      };
      setManual({
        ...current.current.shown,
        route: call ? "/call" : "/reply/$id",
        sessionId: handle.sessionId,
        identity: `manual:${handle.sessionId}:${call}`,
        expanded: true,
        hidden: false,
        attention,
        faces: [{ botId, mood: "idle" }],
        queue: [attention],
      });
      setHovered(true);
      await transport.client.notch.focus(
        { focus: true },
        { signal: abort.signal }
      );
      check();
    })().finally(() => {
      clearTimeout(timer);
      if (messageOperation.current?.generation === generation)
        messageOperation.current = null;
    });
  };
  const endCall = (text?: string, error?: "microphone" | "transcription") => {
    setDictationError(error ?? null);
    if (text && manual?.sessionId) {
      const prior = drafts.get(manual.sessionId) ?? "";
      drafts.set(manual.sessionId, `${prior}${prior ? " " : ""}${text}`);
    }
    if (manual)
      setManual({
        ...manual,
        route: "/reply/$id",
        identity: `manual:${manual.sessionId}:reply`,
      });
  };
  const snooze = () => {
    const key = current.current.shown.attention?.descriptorId;
    const runId = current.current.shown.attention?.runId;
    if (runId) setAcks((state) => new Set([...state, runId].slice(-500)));
    const attention = current.current.shown.attention;
    if (key && attention) {
      const connector = attention.kind === "connector-ask";
      const lineage = connector ? key : lineageFor(attention.sessionId);
      if (lineage)
        setSnoozes(
          (state) =>
            new Map(
              [
                ...state,
                [
                  lineage,
                  {
                    lineage,
                    summaryKey: key,
                    sessionId: attention.sessionId,
                    expiresAt: Date.now() + 600_000,
                    connector,
                  },
                ] as const,
              ].slice(-500)
            )
        );
    }
    setHovered(false);
    void transport.client.notch.focus({ focus: false });
  };
  return (
    <NotchContext
      value={{
        ...context,
        layout,
        presentation: shown,
        open,
        snooze,
        focused,
        message,
        endCall,
        dictationError,
      }}
    >
      <ReplyAcceptedContext value={replyAccepted}>
        <MotionConfig reducedMotion={reduced ? "always" : "user"}>
          <div
            style={
              layout.growth === "up"
                ? { position: "absolute", bottom: 32, left: 24, right: 24 }
                : {
                    paddingInline: 24,
                    transform: `translateX(${layout.offsetX ?? 0}px)`,
                  }
            }
          >
            <NotchSurface
              ref={node}
              layout={layout}
              shape={shape}
              reduced={reduced}
              expanded={shown.expanded}
              role="region"
              aria-label={t("notch.a11y.region")}
              aria-live="off"
              style={{ visibility: shown.hidden ? "hidden" : "visible" }}
              onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const inside =
                  event.clientX >= rect.left &&
                  event.clientX <= rect.right &&
                  event.clientY >= rect.top &&
                  event.clientY <= rect.bottom;
                if (!inside) return;
                clearTimeout(leaveTimer.current);
                if (!pointerInside.current) {
                  pointerInside.current = true;
                  void transport.client.notch.setInteractive({
                    interactive: true,
                  });
                }
                if (inside && !hovered && !hoverTimer.current) {
                  hoverTimer.current = setTimeout(() => {
                    hoverTimer.current = undefined;
                    setHovered(true);
                  }, 120);
                }
              }}
              onPointerLeave={() => {
                pointerInside.current = false;
                clearTimeout(hoverTimer.current);
                hoverTimer.current = undefined;
                clearTimeout(leaveTimer.current);
                void transport.client.notch.setInteractive({
                  interactive: false,
                });
                leaveTimer.current = setTimeout(() => {
                  setHovered(false);
                  if (manual?.route !== "/call") setManual(null);
                }, 300);
              }}
              onPointerDown={() => {
                player.current?.unlock();
                queueMicrotask(() => {
                  const value = player.current?.unlocked() ?? false;
                  audio.current = value;
                  setUnlocked(value);
                });
              }}
            >
              <NotchHeader
                reduced={reduced}
                layout={layout}
                left={
                  <div className="notch-wing" style={faceStyle}>
                    {shown.faces.map((face, i) => {
                      const bot = inputs.bots.find((b) => b.id === face.botId);
                      return (
                        <BotAvatar
                          key={face.botId ?? i}
                          size={20}
                          look={resolveLook({
                            name: bot?.name ?? "Abacus",
                            avatarShape: bot?.avatarShape ?? "mochi",
                            avatarColor: bot?.avatarColor ?? "blue",
                          })}
                          mood={
                            reaction &&
                            (reaction.botId
                              ? reaction.botId === face.botId
                              : reaction.sessionId === shown.sessionId)
                              ? "wink"
                              : face.mood
                          }
                          label={bot?.name ?? "AbacusAI Bot"}
                        />
                      );
                    })}
                    <span
                      className="notch-label truncate"
                      title={
                        shown.quietUntil
                          ? t("notch.quiet.until", { time: shown.quietUntil })
                          : t(`notch.wings.${shown.attention?.kind ?? "idle"}`)
                      }
                    >
                      {shown.route === "/approval/$id" &&
                      shown.expanded &&
                      !shown.quietUntil
                        ? (inputs.bots.find(
                            (bot) => bot.id === shown.attention?.botId
                          )?.name ?? "AbacusAI Bot")
                        : shown.quietUntil
                          ? t("notch.quiet.until", { time: shown.quietUntil })
                          : t(
                              shown.route === "/call"
                                ? "notch.listening.title"
                                : `notch.wings.${shown.attention?.kind ?? "idle"}`
                            )}
                    </span>
                  </div>
                }
                right={
                  <div className="notch-wing">
                    {!shown.sessionId && !shown.expanded && (
                      <span
                        aria-hidden
                        className="ml-auto size-1.5 rounded-full bg-white/40"
                      />
                    )}
                    {shown.remaining > 0 && <span>{shown.remaining}</span>}
                    {shown.sessionId && (
                      <Button onClick={open}>{t("notch.actions.open")}</Button>
                    )}
                    {shown.attention?.kind === "failed" && (
                      <Button aria-label={t("common.close")} onClick={snooze}>
                        ×
                      </Button>
                    )}
                  </div>
                }
              />
              {shown.expanded && (
                <NotchBody
                  headerHeight={layout.notch?.height ?? 36}
                  shape={shape}
                  reduced={reduced}
                  onHeight={(height) =>
                    setBodySize((previous) =>
                      previous?.identity === shown.identity &&
                      previous.height === height
                        ? previous
                        : { identity: shown.identity, height }
                    )
                  }
                >
                  {children}
                </NotchBody>
              )}
              <span className="sr-only" aria-live={focused ? "polite" : "off"}>
                {focused
                  ? t(
                      shown.attention?.kind === "failed"
                        ? runErrorCopy(shown.attention.errorCode)
                        : `notch.wings.${shown.attention?.kind ?? "idle"}`
                    )
                  : ""}
              </span>
            </NotchSurface>
          </div>
        </MotionConfig>
      </ReplyAcceptedContext>
    </NotchContext>
  );
};
export const CompactView = () => {
  const { presentation } = useNotch();
  const { t } = useTranslation();
  return <h2>{t(`notch.wings.${presentation.attention?.kind ?? "idle"}`)}</h2>;
};
export const ReplyView = ({
  text,
  submit,
}: {
  text: string;
  submit(text: string): Promise<{ kind: string }>;
}) => {
  const { presentation, transport, dictationError } = useNotch();
  const id = presentation.sessionId ?? "";
  const accepted = use(ReplyAcceptedContext);
  const { t } = useTranslation();
  const [draft, setDraft] = useState(drafts.get(id) ?? "");
  const [error, setError] = useState(false);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const voice = useDictation(transport, id, (text) => {
    setDraft((value) => {
      const next = `${value}${value ? " " : ""}${text}`;
      drafts.set(id, next);
      return next;
    });
  });
  const send = async () => {
    if (!draft.trim() || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const outcome = await submit(draft);
      if (outcome.kind === "started" || outcome.kind === "queued") {
        setDraft("");
        drafts.delete(id);
        accepted(id, presentation.attention?.runId);
      } else setError(true);
    } catch {
      setError(true);
    }
    inFlight.current = false;
    setSending(false);
  };
  return (
    <div className="notch-reply">
      <p className="line-clamp-3">{text}</p>
      {dictationError && (
        <p role="alert">
          {t(
            dictationError === "microphone"
              ? "workspace.voice.errors.permission-denied"
              : "workspace.voice.errors.transcription-failed"
          )}
        </p>
      )}
      {presentation.attention?.canReply && (
        <Input
          aria-label={t("notch.reply.placeholder")}
          placeholder={t("notch.reply.placeholder")}
          value={draft}
          disabled={sending}
          onFocus={() => void transport.client.notch.focus({ focus: true })}
          onChange={(event) => {
            setDraft(event.target.value);
            drafts.set(id, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
            if (event.key === "Escape")
              void transport.client.notch.focus({ focus: false });
          }}
        />
      )}
      {presentation.attention?.canReply && (
        <Button
          variant="ghost"
          disabled={
            voice.state === "starting" || voice.state === "transcribing"
          }
          onClick={() =>
            voice.state === "recording" ? void voice.end() : void voice.start()
          }
        >
          {t(
            voice.state === "recording"
              ? "notch.listening.end"
              : voice.state === "transcribing"
                ? "notch.listening.transcribing"
                : "chat.composer.dictate"
          )}
        </Button>
      )}
      {voice.state === "recording" && (
        <Button variant="ghost" onClick={voice.cancel}>
          {t("common.cancel")}
        </Button>
      )}
      {voice.state === "error" && (
        <p role="alert">{t("notch.listening.error")}</p>
      )}
      {error && <p role="alert">{t("notch.reply.failed")}</p>}
      {presentation.attention?.canReply && (
        <Button disabled={sending || !draft.trim()} onClick={() => void send()}>
          {t("chat.composer.send")}
        </Button>
      )}
    </div>
  );
};

export { IdleView } from "./idle";
export const CallView = () => {
  const { transport, presentation, endCall } = useNotch();
  const voice = useDictation(transport, presentation.sessionId ?? "", (text) =>
    endCall(text)
  );
  const previousVoiceState = useRef(voice.state);
  useEffect(() => {
    if (voice.state === "error")
      endCall(undefined, voice.error ?? "transcription");
    else if (
      voice.state === "idle" &&
      ["recording", "transcribing"].includes(previousVoiceState.current)
    )
      endCall();
    previousVoiceState.current = voice.state;
  }, [voice.state, voice.error, endCall]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void voice.start();
  }, [voice]);
  return (
    <ListeningControls
      state={voice.state}
      level={voice.level}
      end={() => void voice.end()}
      cancel={() => {
        voice.cancel();
        endCall();
      }}
    />
  );
};

export const ConnectorAskView = () => {
  const { open, snooze } = useNotch();
  const { t } = useTranslation();
  return (
    <div>
      <h2>{t("notch.wings.connector-ask")}</h2>
      <div className="mt-4 flex gap-2">
        <Button onClick={open}>{t("notch.actions.open")}</Button>
        <Button variant="ghost" onClick={snooze}>
          {t("notch.approval.notNow")}
        </Button>
      </div>
    </div>
  );
};

export type { NotchPresentation } from "./presenter";
