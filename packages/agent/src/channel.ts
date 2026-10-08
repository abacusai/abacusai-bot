/**
 * What the chat a session talks through can do, so tool descriptions, tool
 * results and prompts say only what is true there: an app chat has a Browser
 * pane and a preview pane; WhatsApp has neither, but takes images, files and
 * links. A leaf module: the desktop's main process reads it too
 * (`@abacus-ai/agent/channel`).
 */
export interface ChannelCapabilities {
  /** The user can open this session's browser in a pane and act in it. */
  pane: boolean;
  /** Images can go to the chat (`send_media`). */
  media: boolean;
  /** Other files can go to the chat as documents. */
  documents: boolean;
  /** The chat can carry one-time links the user opens to do a step. */
  oneTimeLinks: boolean;
}

/** A chat in the app, with its Browser pane. */
export const APP_CHANNEL: ChannelCapabilities = {
  pane: true,
  media: false,
  documents: false,
  oneTimeLinks: false,
};

/** The user's WhatsApp number. */
export const WHATSAPP_CHANNEL: ChannelCapabilities = {
  pane: false,
  media: true,
  documents: true,
  oneTimeLinks: true,
};

/** How `browser_task`'s description ends: what to do with a run stopped for the user. */
export function browserHandoffDescription(
  channel: ChannelCapabilities
): string {
  return channel.pane
    ? "Tell the user to open the Browser pane in this chat and do that step; when they say it is " +
        "done, call this tool again with continue_from_last: true and their message as the task; " +
        "the same sub-agent carries on from the same page with everything it already found."
    : "The user cannot see this browser: they act only through this chat, one-time links " +
        "(vault_request) and approval pages (payment_approval, signin_approval). Do what the result says next " +
        "that way; when they have done it, call this tool again with continue_from_last: true " +
        "and their message as the task.";
}

/** The note on a run's result when it stopped at a step only the user can do. */
export function browserStopNote(channel: ChannelCapabilities): string {
  return channel.pane
    ? "(The browser is left on that page. Tell the user to open the Browser pane in this chat, " +
        "do the step above, and reply here. Then call browser_task with continue_from_last: true and " +
        "their reply as the task; the same sub-agent continues with everything it has found.)"
    : "(The run stopped at a step only the user can do. They cannot see this browser and act only " +
        "through this chat, one-time links and approval pages: a login, card or code goes through a " +
        "vault_request link, a payment through payment_approval, a sign-in with a saved login through " +
        "signin_approval, anything else as a question here. " +
        "Never ask for a password or card details in the chat. Once it is done, call browser_task with " +
        "continue_from_last: true and their reply as the task. If none of that can do the step, tell " +
        "them how far it got and that they finish it on the site themselves.)";
}
