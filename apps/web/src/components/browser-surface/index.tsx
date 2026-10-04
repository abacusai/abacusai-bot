import { useSelector, type Store } from "@tanstack/react-store";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BrowserRuntimeLease } from "@abacus-ai/contract/contracts";
interface Presenter {
  captures: Store<Record<string, string>>;
  owner: Store<string | null>;
  refresh(): Promise<void>;
  activate(id: string): Promise<void>;
  register(candidate: {
    id: string;
    lease: BrowserRuntimeLease;
    bounds(): { x: number; y: number; width: number; height: number };
    visible(): boolean;
    blocked(): boolean;
  }): () => void;
}
export const BrowserSurface = ({
  lease,
  presenter,
  blocked,
  visible,
}: {
  lease: BrowserRuntimeLease;
  presenter: Presenter;
  blocked: (rect: DOMRect) => boolean;
  visible: boolean;
}) => {
  const { t } = useTranslation();
  const { conversationKey, resourceId, generation } = lease;
  const [id] = useState(() => `surface:${crypto.randomUUID()}`);
  const node = useRef<HTMLDivElement>(null);
  const live = useRef({ visible, blocked });
  useEffect(() => {
    live.current = { visible, blocked };
  }, [visible, blocked]);
  const owner = useSelector(presenter.owner, (s) => s);
  const capture = useSelector(presenter.captures, (s) => s[id]);
  useEffect(() => {
    const unregister = presenter.register({
      id,
      lease: { conversationKey, resourceId, generation },
      bounds: () => {
        const r = node.current!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      visible: () =>
        live.current.visible &&
        !!node.current &&
        node.current.getBoundingClientRect().width > 0,
      blocked: () =>
        !node.current ||
        document.visibilityState === "hidden" ||
        !!document.activeViewTransition ||
        live.current.blocked(node.current.getBoundingClientRect()),
    });
    const refresh = () => void presenter.refresh();
    const observer = new ResizeObserver(refresh);
    if (node.current) observer.observe(node.current);
    window.addEventListener("resize", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, 500);
    let frame = 0;
    let last = "";
    const watch = () => {
      const signature =
        String(!!document.activeViewTransition) +
        String(
          node.current &&
            live.current.blocked(node.current.getBoundingClientRect())
        ) +
        String(live.current.visible);
      if (signature !== last) {
        last = signature;
        refresh();
      }
      frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);
    return () => {
      unregister();
      observer.disconnect();
      clearInterval(interval);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [conversationKey, resourceId, generation, presenter, id]);
  useEffect(() => {
    void presenter.refresh();
  }, [visible, presenter]);
  return (
    <div
      ref={node}
      role="region"
      aria-label={t("sessions.browser.title")}
      className="bg-muted relative min-h-0 flex-1 overflow-hidden rounded-lg"
      tabIndex={0}
      onPointerDown={() => void presenter.activate(id)}
      onFocus={() => void presenter.activate(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void presenter.activate(id);
      }}
    >
      {capture ? (
        <img
          src={capture}
          alt=""
          className="absolute inset-0 size-full object-fill"
        />
      ) : null}
      {owner !== id ? (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {t("sessions.browser.activate")}
        </div>
      ) : null}
    </div>
  );
};
