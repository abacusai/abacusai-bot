import { toast } from "#renderer/ui/toast";
type Notice = { title: string; body: string; dedupeKey?: string };
const id = crypto.randomUUID();
const peers = new Map<string, number>();
const seen = new Map<string, number>();
let channel: BroadcastChannel | undefined;
let election: Promise<void> | undefined;
const leader = () => {
  const now = Date.now();
  for (const [peer, at] of peers) if (now - at > 6000) peers.delete(peer);
  return [id, ...peers.keys()].sort()[0] === id;
};
const deliver = (notice: Notice) => {
  if (!leader()) return;
  const key = notice.dedupeKey ?? `${notice.title}\n${notice.body}`;
  if (Date.now() - (seen.get(key) ?? -Infinity) < 60_000) return;
  seen.set(key, Date.now());
  for (const [key, at] of seen) if (Date.now() - at > 60_000) seen.delete(key);
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  )
    new Notification(notice.title, { body: notice.body, tag: key });
  else toast.add({ title: notice.title, description: notice.body });
};
export const browserNotify = async (notice: Notice): Promise<void> => {
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("abacus.notifications");
    channel.onmessage = ({
      data,
    }: MessageEvent<{ type: string; id: string; notice?: Notice }>) => {
      if (data.type === "peer") peers.set(data.id, Date.now());
      if (data.type === "hello") channel?.postMessage({ type: "peer", id });
      if (data.type === "notice" && data.notice) deliver(data.notice);
    };
    channel.postMessage({ type: "hello", id });
    channel.postMessage({ type: "peer", id });
    setInterval(() => channel?.postMessage({ type: "peer", id }), 2000);
    election = new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  await election;
  channel?.postMessage({ type: "notice", id, notice });
  deliver(notice);
};
