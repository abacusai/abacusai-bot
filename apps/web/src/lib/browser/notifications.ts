import type { NotificationMetadata } from "@abacus-ai/contract/contract/system";

import { toast } from "#renderer/ui/toast";
type Notice = {
  title: string;
  body: string;
  dedupeKey?: string;
  metadata?: NotificationMetadata;
};
const id = crypto.randomUUID();
const peers = new Map<string, number>();
const seen = new Map<string, number>();
let channel: BroadcastChannel | undefined;
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 250));
export const installBrowserAttention = () => {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("abacusai-bot:attention");
  channel.onmessage = ({
    data,
  }: MessageEvent<{ type: string; id: string }>) => {
    peers.set(data.id, Date.now());
    if (data.type === "hello" || data.type === "claim")
      channel?.postMessage({ type: "peer", id });
  };
  channel.postMessage({ type: "hello", id });
};
/** Fresh peer discovery on every claim tolerates suspended tabs and expired
 * heartbeats. Web Locks plus origin storage makes delivery exclusive even
 * when a waking tab hasn't received the channel exchange yet. */
export const claimBrowserAttention = async (
  key: string,
  ttl = 2000
): Promise<boolean> => {
  installBrowserAttention();
  const claim = () => {
    const now = Date.now();
    let stored: Record<string, number> = {};
    try {
      stored = JSON.parse(
        localStorage.getItem("abacusai-bot:attention") ?? "{}"
      );
    } catch {
      /* In-memory fallback. */
    }
    const at = Math.max(seen.get(key) ?? -Infinity, stored[key] ?? -Infinity);
    if (now - at < ttl) return false;
    seen.set(key, now);
    stored[key] = now;
    for (const [old, time] of Object.entries(stored))
      if (now - time > 60_000) delete stored[old];
    for (const [old, time] of seen) if (now - time > 60_000) seen.delete(old);
    try {
      localStorage.setItem("abacusai-bot:attention", JSON.stringify(stored));
    } catch {
      /* In-memory fallback. */
    }
    return true;
  };
  if (navigator.locks)
    return navigator.locks.request("abacusai-bot:attention", claim);
  if (channel) {
    channel.postMessage({ type: "claim", id });
    await delay();
    const now = Date.now();
    for (const [peer, at] of peers) if (now - at > 1000) peers.delete(peer);
    if ([id, ...peers.keys()].sort()[0] !== id) return false;
  }
  return claim();
};
export const requestNotificationPermission = (): void => {
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  )
    void Notification.requestPermission();
};
export const browserNotify = async (notice: Notice): Promise<void> => {
  const key = notice.dedupeKey ?? `${notice.title}\n${notice.body}`;
  if (
    !(await claimBrowserAttention(
      `notice:${key}`,
      notice.dedupeKey ? 60_000 : 2000
    ))
  )
    return;
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    const notification = new Notification(notice.title, {
      body: notice.body,
      tag: key,
    });
    notification.onclick = () => {
      window.focus();
      window.dispatchEvent(
        new CustomEvent("abacusai-bot:notification-clicked", {
          detail: notice.metadata,
        })
      );
      notification.close();
    };
  } else toast.add({ title: notice.title, description: notice.body });
};
