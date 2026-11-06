/**
 * Which channels have a bot's message the user has not opened yet: the
 * time each channel was last looked at, kept in this browser's storage
 * (nothing the host needs to know), against the channel's last message.
 */
import type { ChannelSummary } from "@abacus-ai/contract/channels";
import { Store, useStore } from "@tanstack/react-store";

const KEY = "abacusai-bot:channels.seen";

const read = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw == null ? {} : JSON.parse(raw);
    return parsed != null && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
};

const seenStore = new Store<Record<string, number>>(read());

/** The channel was looked at with its messages up to `at`. */
export const markChannelSeen = (channelId: string, at: number): void => {
  if ((seenStore.state[channelId] ?? 0) >= at) return;
  seenStore.setState((state) => ({ ...state, [channelId]: at }));
  try {
    localStorage.setItem(KEY, JSON.stringify(seenStore.state));
  } catch {
    // Storage may be unavailable: the dots then reset with the page.
  }
};

/** A bot wrote last, after the channel was last looked at. */
const isUnread = (
  channel: Pick<ChannelSummary, "id" | "last">,
  seen: Readonly<Record<string, number>>
): boolean =>
  channel.last != null &&
  channel.last.author.kind === "bot" &&
  channel.last.at > (seen[channel.id] ?? 0);

export const useUnreadChannels = (
  channels: readonly ChannelSummary[]
): ReadonlySet<string> => {
  const seen = useStore(seenStore);
  return new Set(
    channels.filter((channel) => isUnread(channel, seen)).map((c) => c.id)
  );
};
