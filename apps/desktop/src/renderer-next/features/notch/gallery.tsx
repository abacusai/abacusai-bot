import "./notch.css";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#next/components/bot-avatar";
import { resolveLook } from "#next/lib/bots/avatar";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
/** Canvas state specimens. Native behavior is verified separately in the Electron suite. */
export const NotchGallery = ({ state }: { state: string }) => {
  const { t } = useTranslation();
  const expanded = state !== "idle" && state !== "working";
  const kind =
    state === "approval"
      ? "approval"
      : state === "question"
        ? "question"
        : state === "call"
          ? "reply"
          : state;
  return (
    <div className="grid min-h-[620px] place-items-center">
      <div>
        <div
          className="notch-shape"
          data-mode="plain"
          style={{ width: expanded ? 440 : 280, height: expanded ? 210 : 40 }}
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
                  state === "working"
                    ? "working"
                    : state === "approval"
                      ? "waiting"
                      : "idle"
                }
              />
              <span>{t(`notch.wings.${kind}`)}</span>
            </div>
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
              {state === "approval" ? (
                <>
                  <p className="my-3 whitespace-pre-wrap">
                    git status
                    <br />
                    /workspace/project
                  </p>
                  <Button>{t("chat.permission.action.allow")}</Button>
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
