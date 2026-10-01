import "./notch.css";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import { notchOutline } from "./outline";
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
  return (
    <div className="grid min-h-[620px] place-items-center">
      <div>
        <div
          className="notch-shape"
          data-mode={mode}
          role="region"
          aria-label={t("notch.a11y.region")}
          style={{
            clipPath: mode === "notch" ? notchOutline() : undefined,
            width:
              state === "hidden"
                ? 0
                : expanded
                  ? 540
                  : mode === "notch"
                    ? 480
                    : 280,
            height: state === "hidden" ? 0 : expanded ? 210 : 40,
          }}
        >
          <div className="notch-wings" style={{ height: 40 }}>
            <div className="notch-wing">
              <BotAvatar
                size={24}
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
              <span className="truncate">
                {expanded &&
                ["approval", "truncated", "question"].includes(state)
                  ? "Chief of Staff"
                  : state === "quiet"
                    ? t("notch.quiet.until", { time: "08:00" })
                    : t(`notch.wings.${kind}`)}
              </span>
            </div>
            {mode === "notch" && (
              <div style={{ width: 200, flexShrink: 0 }} aria-hidden="true" />
            )}
            <div className="notch-wing justify-end">
              <Button variant="ghost">{t("notch.actions.open")}</Button>
            </div>
          </div>
          {expanded && (
            <div className="notch-body">
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
                  <Button variant="ghost">{t("notch.approval.review")}</Button>
                </>
              ) : state === "question" ? (
                <>
                  <p className="my-3">{t("notch.approval.answerInApp")}</p>
                  <Button>{t("notch.approval.answerInApp")}</Button>
                </>
              ) : state === "reply" ? (
                <Input
                  className="mt-4"
                  aria-label={t("notch.reply.placeholder")}
                  placeholder={t("notch.reply.placeholder")}
                />
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
          )}
        </div>
        <p className="text-muted-foreground mt-6 text-center text-sm">
          {t("notch.a11y.region")}
        </p>
      </div>
    </div>
  );
};
