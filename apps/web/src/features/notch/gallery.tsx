import "./notch.css";
import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import { NotchSurface, NotchHeader, NotchBody } from "./frame";
import type { NotchPresentation } from "./presenter";
import { shapeFor } from "./shape";
import { hasCamera } from "./spacing";
/** Canvas state specimens. Native behavior is verified separately in the Electron suite. */
export const NotchGallery = ({ state: fixture }: { state: string }) => {
  const mode = fixture.startsWith("capsule-")
    ? "capsule"
    : fixture.startsWith("notch-")
      ? "notch"
      : "plain";
  const state = mode === "plain" ? fixture : fixture.slice(mode.length + 1);
  const { t } = useTranslation();
  const expanded = [
    "approval",
    "truncated",
    "question",
    "reply",
    "reply-readonly",
    "call",
    "hovered",
  ].includes(state);
  const kind =
    state === "approval"
      ? "approval"
      : state === "question"
        ? "question"
        : state === "call"
          ? "reply"
          : ["hidden", "hovered", "quiet", "reaction", "several"].includes(
                state
              )
            ? "idle"
            : state === "truncated"
              ? "approval"
              : state === "reply-readonly"
                ? "reply"
                : state;
  const [draft, setDraft] = useState("");
  const [bodySize, setBodySize] = useState<{
    fixture: string;
    height: number;
  } | null>(null);
  const layout: NotchLayout = {
    displayId: 0,
    mode,
    notch: mode === "notch" ? { width: 185, height: 33 } : null,
    growth: "down",
    maxShape: { width: 560, height: 240 },
  };
  const route: NotchPresentation["route"] =
    state === "call"
      ? "/call"
      : kind === "approval" || kind === "question"
        ? "/approval/$id"
        : kind === "reply"
          ? "/reply/$id"
          : kind === "working"
            ? "/working"
            : kind === "done"
              ? "/done"
              : kind === "failed"
                ? "/failed"
                : "/idle";
  const baseShape = shapeFor(
    { route, expanded, quietUntil: state === "quiet" ? "08:00" : null },
    layout
  );
  const shape = {
    ...baseShape,
    height:
      expanded && bodySize?.fixture === fixture
        ? Math.min(
            layout.maxShape.height,
            baseShape.compactHeight + bodySize.height
          )
        : baseShape.height,
  };
  return (
    <div className="grid min-h-[calc(100dvh-180px)] place-items-center">
      <div className="max-w-full overflow-x-auto">
        <NotchSurface
          layout={layout}
          shape={state === "hidden" ? { width: 0, height: 0 } : shape}
          reduced
          expanded={expanded}
          role="region"
          aria-label={t("notch.a11y.region")}
        >
          <NotchHeader
            layout={layout}
            reduced
            left={
              <div className="notch-wing">
                <BotAvatar
                  size={20}
                  look={resolveLook({
                    name: "Chief of Staff",
                    avatarShape: "mochi",
                    avatarColor: "blue",
                  })}
                  mood={
                    state === "reaction"
                      ? "wink"
                      : state === "working"
                        ? "working"
                        : state === "approval"
                          ? "waiting"
                          : "idle"
                  }
                />
                {state === "several" &&
                  expanded &&
                  ["green", "purple"].map((color) => (
                    <BotAvatar
                      key={color}
                      size={20}
                      look={resolveLook({
                        name: color,
                        avatarShape: "mochi",
                        avatarColor: color as "green",
                      })}
                    />
                  ))}
                <span
                  className={
                    !expanded && kind === "idle" && state !== "quiet"
                      ? "sr-only"
                      : "notch-label truncate"
                  }
                >
                  {expanded &&
                  ["approval", "truncated", "question"].includes(state)
                    ? "Chief of Staff"
                    : state === "quiet"
                      ? t("notch.quiet.until", { time: "08:00" })
                      : t(
                          hasCamera(layout) && kind === "idle"
                            ? "shell.status.ready"
                            : `notch.wings.${kind}`
                        )}
                </span>
              </div>
            }
            right={
              <div className="notch-wing justify-end">
                {expanded ? (
                  <Button
                    variant="ghost"
                    size={hasCamera(layout) ? "icon" : "default"}
                    aria-label={t("notch.actions.open")}
                  >
                    {hasCamera(layout) ? (
                      <ExternalLink aria-hidden />
                    ) : (
                      t("notch.actions.open")
                    )}
                  </Button>
                ) : (
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-white/40"
                  />
                )}
              </div>
            }
          />
          {expanded && (
            <NotchBody
              shape={shape}
              reduced
              headerHeight={shape.compactHeight}
              onHeight={(height) =>
                setBodySize((previous) =>
                  previous?.fixture === fixture && previous.height === height
                    ? previous
                    : { fixture, height }
                )
              }
            >
              <div className="grid gap-3">
                <h2>
                  {state === "call"
                    ? t("notch.listening.title")
                    : t(`notch.wings.${kind}`)}
                </h2>
                {state === "approval" || state === "truncated" ? (
                  <>
                    <p className="my-3 whitespace-pre-wrap">
                      git status
                      <br />
                      /workspace/project
                    </p>
                    {state === "approval" && (
                      <Button>{t("chat.permission.action.allow")}</Button>
                    )}
                    {state === "truncated" && (
                      <p>{t("notch.approval.reviewOnly")}</p>
                    )}
                    <Button variant="ghost">
                      {t("notch.approval.review")}
                    </Button>
                  </>
                ) : state === "question" ? (
                  <>
                    <p className="my-3">{t("notch.approval.answerInApp")}</p>
                    <Button>{t("notch.approval.answerInApp")}</Button>
                  </>
                ) : state === "reply" ? (
                  <div className="flex gap-2">
                    <Input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      className="min-w-0 flex-1"
                      aria-label={t("notch.reply.placeholder")}
                      placeholder={t("notch.reply.placeholder")}
                    />
                    <Button
                      disabled={!draft.trim()}
                      onClick={() => setDraft("")}
                    >
                      {t("chat.composer.send")}
                    </Button>
                  </div>
                ) : state === "call" ? (
                  <>
                    <div className="notch-wave" aria-hidden="true">
                      {[12, 24, 32, 20, 12].map((height, i) => (
                        <span key={i} style={{ height }} />
                      ))}
                    </div>
                    <Button>{t("notch.listening.end")}</Button>
                  </>
                ) : state === "hovered" ? (
                  <div className="flex gap-2">
                    <Button>{t("notch.actions.message")}</Button>
                    <Button>{t("notch.actions.call")}</Button>
                    <Button>{t("notch.actions.pause")}</Button>
                  </div>
                ) : state === "reply-readonly" ? (
                  <p className="mt-4">{t("chat.composer.channelBot")}</p>
                ) : (
                  <p>{t(`notch.${state}.title`)}</p>
                )}
              </div>
            </NotchBody>
          )}
        </NotchSurface>
        <p className="text-muted-foreground mt-6 text-center text-sm">
          {t("notch.a11y.region")}
        </p>
      </div>
    </div>
  );
};
