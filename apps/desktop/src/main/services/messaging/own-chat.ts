import { HOME_CHANNELS, type HomeChannel } from "@abacus-ai/contract/bots";
import {
  APP_OF_SELF_LANE,
  type MessagingPlatformId,
  SELF_LANE_FOR_APP,
  selfLaneOf,
} from "@abacus-ai/contract/messaging";

import type { MessagingConnector } from "./connector";

/**
 * "Who is me", in one place: every path to the user's own chat, in the order
 * a message to them tries. An app's preferred path first (the shared bot's DM
 * on Telegram and Discord, the self chat on WhatsApp), then the same app's
 * other path (personal Telegram's Saved Messages, outbound only), then
 * another app's own chat.
 */

/** One way to reach the user's own chat. */
export interface OwnChatPath {
  platform: MessagingPlatformId;
  chatId: string;
  /** The app asked for, when this path is another app's: its own were all down. */
  downApp: HomeChannel | null;
}

export interface OwnChatSource {
  connector: (id: MessagingPlatformId) => MessagingConnector | undefined;
  /** The lane can take a message now. */
  up: (id: MessagingPlatformId) => boolean;
}

/** The chat app a platform belongs to; null for one that is none. */
export const appOfPlatform = (id: MessagingPlatformId): HomeChannel | null => {
  const lane = selfLaneOf(id);
  return lane != null ? APP_OF_SELF_LANE[lane] : null;
};

/** The user's own chat ids on an app, preferred first, up or not. */
export const ownChatsOn = (
  app: HomeChannel,
  source: Pick<OwnChatSource, "connector">
): Array<{ platform: MessagingPlatformId; chatId: string }> => {
  const lane = SELF_LANE_FOR_APP[app];
  const personal = app as MessagingPlatformId;
  const rows: Array<{ platform: MessagingPlatformId; chatId: string }> = [];
  const add = (platform: MessagingPlatformId, chatId: string | null): void => {
    if (chatId != null && chatId.length > 0) rows.push({ platform, chatId });
  };
  add(lane, source.connector(lane)?.selfChatId?.() ?? null);
  if (personal !== lane)
    add(personal, source.connector(personal)?.selfChatId?.() ?? null);
  // Outbound only: never the inbound gate's "me", so the app never answers it.
  add(personal, source.connector(personal)?.ownChatForSend?.() ?? null);
  return rows;
};

/**
 * The first path to the user's own chat that is up right now: `platform`'s
 * app, then the others (`preferApp` first). Null when none is up.
 */
export const pickOwnChat = (
  platform: MessagingPlatformId,
  source: OwnChatSource,
  options: {
    preferApp?: HomeChannel | null;
    /** A lane whose notice this is: never carried by itself. */
    exclude?: MessagingPlatformId;
    crossApp?: boolean;
  } = {}
): OwnChatPath | null => {
  const asked = appOfPlatform(platform);
  const live = (app: HomeChannel) =>
    ownChatsOn(app, source).find(
      (row) => row.platform !== options.exclude && source.up(row.platform)
    );
  if (asked != null) {
    const own = live(asked);
    if (own != null) return { ...own, downApp: null };
  }
  if (options.crossApp === false) return null;
  const others = HOME_CHANNELS.filter((app) => app !== asked).sort(
    (a, b) => Number(b === options.preferApp) - Number(a === options.preferApp)
  );
  for (const app of others) {
    const other = live(app);
    if (other != null) return { ...other, downApp: asked };
  }
  return null;
};
