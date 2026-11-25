/**
 * The thumbs under a reply in a chat: `MessageFeedback` with the chat's
 * place for long text, so a note past `USER_TEXT_INLINE_MAX` is saved as
 * pasted text where this chat's composer saves a long paste.
 */
import {
  MessageFeedback as Feedback,
  type MessageFeedbackProps,
} from "#renderer/components/message-feedback";

import { saveLongText } from "../composer/attachments";
import { useOptionalChatView } from "./context";

export const ChatMessageFeedback = (props: MessageFeedbackProps) => {
  const view = useOptionalChatView();
  return (
    <Feedback
      {...props}
      {...(view != null &&
        (view.runtime.host.uploadFile != null ||
          view.composer.attachmentsBase != null) && {
          saveLong: (text: string) =>
            saveLongText(
              text,
              view.runtime.host,
              view.composer.attachmentsBase,
              view.composer.attachmentContext
            ),
        })}
    />
  );
};
