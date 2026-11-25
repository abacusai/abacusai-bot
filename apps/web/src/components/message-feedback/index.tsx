import type { TurnFeedbackOutcome } from "@abacus-ai/contract/contracts";
import { USER_TEXT_INLINE_MAX } from "@abacus-ai/contract/transcript/user-text";
/**
 * Two feedback buttons in the action bar, with an optional comment, sent as
 * `agent.feedback`. A second click on a rating the server holds sends
 * `clear`; on one that failed to send, it sends it again. A failed `clear`
 * puts the held rating back, so the pressed thumb, the open form and the
 * status line always describe the same rating. Offered only with an Abacus
 * account (the route decides) and never on the live run (the decorations
 * decide).
 *
 * The same controls appear in a reply's hover menu and in its right-click
 * menu, so the rating, the comment and the send status live in a small
 * store keyed by `id` (the reply's feedback segment): whichever menu rated
 * the reply, the other shows it pressed and its outcome.
 *
 * With `reader` (a chat the user can write in), main also hands the comment
 * to the chat's agent as their reply to that message (service-host
 * `deliverFeedbackComment`), so the box says who reads it. Without it (a
 * bot's chat with someone else, a routine run) the copy is the team's. The
 * agent gets the comment whole; past `USER_TEXT_INLINE_MAX` it is saved as a
 * pasted-text file (`saveLong`), as the composer saves a long paste, and the
 * agent reads that file while the team gets the words.
 */
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { createContext, use, useId, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Textarea } from "#renderer/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

type Rating = "up" | "down";

/**
 * Saves a note past `USER_TEXT_INLINE_MAX` as pasted text where the chat's
 * composer saves a long paste (its path, or null where it could not). A chat
 * provides it where it can save a file; elsewhere such a note is refused.
 */
export const LongNoteSaverContext = createContext<
  ((text: string) => Promise<string | null>) | null
>(null);

/** Shared look of the turn/message action buttons (Copy, thumbs): 28px, muted. */
export const ACTION_BUTTON_CLASS =
  "text-muted-foreground hover:text-foreground hover:bg-muted aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15 aria-pressed:[&_svg]:fill-current";
export const ACTION_ICON_CLASS = "size-4";
export const ACTION_ICON_STROKE = 1.75;

export interface MessageFeedbackProps {
  /** The reply's feedback segment; absent, the controls keep their own state. */
  id?: string;
  /** The chat's agent, which reads the comment too; `name` absent: "the agent". */
  reader?: { name?: string };
  /**
   * Saves a note past `USER_TEXT_INLINE_MAX` as pasted text where the chat's
   * composer saves a long paste; its path, or null where there is no place.
   */
  saveLong?(text: string): Promise<string | null>;
  send(
    rating: Rating | "clear",
    comment?: string,
    commentFile?: string
  ): Promise<TurnFeedbackOutcome>;
}

type Status =
  | "idle"
  | "sending"
  | "sent"
  | "not-synced"
  | "failed"
  /** A note past the inline bound could not be saved as a file: nothing was sent. */
  | "not-saved";

interface FeedbackState {
  /** The rating shown pressed: the one sent, being sent or failed to send. */
  rating: Rating | null;
  /** The rating the server holds, after the last send that landed. */
  held: Rating | null;
  comment: string;
  status: Status;
}

const IDLE: FeedbackState = {
  rating: null,
  held: null,
  comment: "",
  status: "idle",
};
const states = new Map<string, FeedbackState>();
const listeners = new Map<string, Set<() => void>>();
/** Told of every reply's change, for whole-thread questions. */
const anyListeners = new Set<() => void>();

const readState = (id: string): FeedbackState => states.get(id) ?? IDLE;
const writeState = (id: string, patch: Partial<FeedbackState>): void => {
  states.set(id, { ...readState(id), ...patch });
  for (const listener of listeners.get(id) ?? []) listener();
  for (const listener of anyListeners) listener();
};
const subscribeState = (id: string, listener: () => void): (() => void) => {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
};

/** A reply of `threadId` holds a thumb (keys are `<thread>:<segment>`). */
const threadHasThumb = (threadId: string): boolean => {
  for (const [key, state] of states)
    if (state.rating != null && key.startsWith(`${threadId}:`)) return true;
  return false;
};

const subscribeAny = (listener: () => void): (() => void) => {
  anyListeners.add(listener);
  return () => anyListeners.delete(listener);
};

/** Whether the user thumbed any reply of `threadId`, kept current. */
export const useThreadHasThumb = (threadId: string): boolean => {
  const read = (): boolean => threadHasThumb(threadId);
  return useSyncExternalStore(subscribeAny, read, read);
};

/** Tests: forget every reply's feedback state. */
export const clearFeedbackStates = (): void => {
  states.clear();
};

export const MessageFeedback = ({
  id,
  reader,
  saveLong: ownSaveLong,
  send,
}: MessageFeedbackProps) => {
  const chatSaveLong = use(LongNoteSaverContext);
  const saveLong = ownSaveLong ?? chatSaveLong ?? undefined;
  const { t } = useTranslation();
  // Who reads the comment besides the team: the chat's agent, by name when it has one.
  const name = reader?.name;
  const own = useId();
  const key = id ?? own;
  const { rating, held, comment, status } = useSyncExternalStore(
    (listener) => subscribeState(key, listener),
    () => readState(key),
    () => readState(key)
  );

  const submit = (next: Rating | "clear", text?: string): void => {
    writeState(key, {
      rating: next === "clear" ? null : next,
      status: "sending",
    });
    const fail = (failure: "not-synced" | "failed" | "not-saved"): void =>
      writeState(key, {
        status: failure,
        // The server still holds what a failed clear meant to withdraw.
        ...(next === "clear" && { rating: readState(key).held }),
      });
    // Past the inline bound the agent reads the note from its file and the
    // team gets its start; it is never sent inline. No file, nothing sent.
    const over = text != null && text.length > USER_TEXT_INLINE_MAX;
    const words = over ? text.slice(0, USER_TEXT_INLINE_MAX) : text;
    const sent: Promise<TurnFeedbackOutcome | "not-saved"> =
      over && reader != null
        ? (saveLong?.(text) ?? Promise.resolve(null))
            .catch(() => null)
            .then((commentFile): Promise<TurnFeedbackOutcome | "not-saved"> =>
              commentFile == null
                ? Promise.resolve("not-saved")
                : send(next, words, commentFile)
            )
        : send(next, words);
    sent
      .then((outcome) => {
        if (outcome === "not-saved") {
          fail("not-saved");
          return;
        }
        if (outcome.ok)
          writeState(key, {
            status: "sent",
            held: next === "clear" ? null : next,
          });
        else fail(outcome.reason === "not-synced" ? "not-synced" : "failed");
      })
      .catch(() => fail("failed"));
  };

  const unsent =
    status === "failed" || status === "not-synced" || status === "not-saved";
  const typed = comment.trim() || undefined;
  const over = reader != null && (typed?.length ?? 0) > USER_TEXT_INLINE_MAX;
  // A file is made only where this chat can save one; elsewhere the box refuses.
  const asFile = over && saveLong != null;
  const tooLong = over && saveLong == null;

  const rate = (next: Rating): void => {
    if (status === "sending") return;
    if (rating === next && held === next) submit("clear");
    else if (rating === next)
      submit(next, typed); // retry the failed send
    else submit(next);
  };

  return (
    <div data-slot="message-feedback" className="flex items-center gap-0.5">
      <Popover>
        {(
          [
            ["up", ThumbsUp, "bots.chat.feedback.helpful"],
            ["down", ThumbsDown, "bots.chat.feedback.notHelpful"],
          ] as const
        ).map(([value, Icon, label]) => (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className={ACTION_BUTTON_CLASS}
                      aria-label={t(label)}
                      aria-pressed={rating === value}
                      data-status={status}
                      onClick={() => rate(value)}
                    />
                  }
                />
              }
            >
              <Icon
                aria-hidden
                className={ACTION_ICON_CLASS}
                strokeWidth={ACTION_ICON_STROKE}
              />
            </TooltipTrigger>
            <TooltipContent>{t(label)}</TooltipContent>
          </Tooltip>
        ))}
        <PopoverContent align="start" className="flex w-64 flex-col gap-2">
          {rating != null && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!tooLong) submit(rating, typed);
              }}
            >
              <Textarea
                aria-label={t("bots.chat.feedback.tellUsMore")}
                placeholder={
                  reader == null
                    ? t(
                        rating === "up"
                          ? "bots.chat.feedback.placeholderUp"
                          : "bots.chat.feedback.placeholderDown"
                      )
                    : name == null
                      ? t(
                          rating === "up"
                            ? "bots.chat.feedback.placeholderUpAgent"
                            : "bots.chat.feedback.placeholderDownAgent"
                        )
                      : t(
                          rating === "up"
                            ? "bots.chat.feedback.placeholderUpNamed"
                            : "bots.chat.feedback.placeholderDownNamed",
                          { name }
                        )
                }
                value={comment}
                onChange={(event) =>
                  writeState(key, { comment: event.target.value })
                }
                className="max-h-48 min-h-16 text-xs"
              />
              {asFile && (
                <p
                  data-slot="feedback-as-file"
                  className="text-muted-foreground text-xs"
                >
                  {t("bots.chat.feedback.longAsFile")}
                </p>
              )}
              {tooLong && (
                <p
                  data-slot="feedback-too-long"
                  role="alert"
                  className="text-destructive text-xs"
                >
                  {t("bots.chat.feedback.tooLong")}
                </p>
              )}
              {reader != null && (
                <p
                  data-slot="feedback-reader"
                  className="text-muted-foreground text-xs"
                >
                  {name == null
                    ? t("bots.chat.feedback.readerAgent")
                    : t("bots.chat.feedback.readerNamed", { name })}
                </p>
              )}
              <Button
                type="submit"
                size="sm"
                className="self-end"
                // After a failed send, an empty comment still retries the rating.
                disabled={
                  status === "sending" || tooLong || (typed == null && !unsent)
                }
              >
                {t("bots.chat.feedback.send")}
              </Button>
            </form>
          )}
          <p
            role="status"
            className={cn(
              "text-xs",
              status === "failed" ||
                status === "not-synced" ||
                status === "not-saved"
                ? "text-foreground"
                : "text-muted-foreground",
              (status === "idle" || status === "sending") && "sr-only"
            )}
          >
            {status === "sent"
              ? t("bots.chat.feedback.sent")
              : status === "not-synced"
                ? t("bots.chat.feedback.notSynced")
                : status === "failed"
                  ? t("bots.chat.feedback.failed")
                  : status === "not-saved"
                    ? t("bots.chat.feedback.longNotSaved")
                    : ""}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
};
