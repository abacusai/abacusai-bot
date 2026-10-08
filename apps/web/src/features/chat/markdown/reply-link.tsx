import {
  previewTarget,
  type LinkPreview,
} from "@abacus-ai/contract/contract/links";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithRef,
  type ReactElement,
} from "react";

import { usePrefs } from "#renderer/data/db/prefs";
import { durations, useMotionPreference } from "#renderer/lib/motion";
import { useAppContext } from "#renderer/lib/use-app-context";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#renderer/ui/hover-card";
import { Skeleton } from "#renderer/ui/skeleton";

import { useChatView } from "../kit/context";
import { useHost } from "../store/selectors";
import { messageLinks } from "./links";

const parsed = new WeakMap<UIMessage, string[]>();
export const eligibleLinks = (
  message: UIMessage,
  messages: readonly UIMessage[]
): string[] => {
  if (
    message.role !== "assistant" ||
    !messages
      .filter((m) => m.role === "assistant")
      .slice(-15)
      .some((m) => m.id === message.id)
  )
    return [];
  const cached = parsed.get(message);
  if (cached) return cached;
  const urls = [
    ...new Set(
      message.parts.flatMap((part) =>
        part.type === "text" &&
        (part as { metadata?: { abacus?: { kind?: unknown } } }).metadata
          ?.abacus?.kind == null
          ? messageLinks(part.content)
          : []
      )
    ),
  ]
    .slice(0, 5)
    .filter(previewTarget);
  parsed.set(message, urls);
  return urls;
};

let active: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};
const openCard = (id: string | null) => {
  active = id;
  listeners.forEach((notify) => notify());
};

export const PreviewContent = ({ preview }: { preview: LinkPreview }) => {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const hostname = new URL(preview.finalUrl).hostname;
  return (
    <>
      {preview.imageDataUri && failedImage !== preview.imageDataUri ? (
        <img
          src={preview.imageDataUri}
          alt=""
          className="aspect-video max-h-[140px] w-full rounded-t-lg object-cover"
          onError={() => setFailedImage(preview.imageDataUri!)}
        />
      ) : null}
      <div className="flex flex-col gap-1.5 p-3">
        <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          {preview.faviconDataUri ? (
            <img
              src={preview.faviconDataUri}
              alt=""
              className="size-3.5 rounded-[3px]"
            />
          ) : (
            <Globe aria-hidden className="size-3.5" />
          )}
          <span className="truncate">{hostname}</span>
        </span>
        <span className="line-clamp-2 text-xs font-medium">
          {preview.title}
        </span>
        {preview.description ? (
          <span className="text-muted-foreground line-clamp-3 text-xs">
            {preview.description}
          </span>
        ) : null}
      </div>
    </>
  );
};

type Anchor = ReactElement<ComponentPropsWithRef<"a">>;
export const ReplyLink = ({
  anchor,
  message,
  bare,
}: {
  anchor: Anchor;
  message: UIMessage;
  bare: boolean;
}) => {
  const { session } = useChatView();
  const messages = useHost(session, (s) => s.messages);
  const prefs = usePrefs();
  const { transport } = useAppContext();
  const ref = useRef<HTMLAnchorElement>(null);
  const [near, setNear] = useState(false);
  const [boundary, setBoundary] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>();
  const id = useId();
  const opened = useSyncExternalStore(
    subscribe,
    () => active === id,
    () => false
  );
  const reduced = useMotionPreference() === "reduced";
  const url = new URL(anchor.props.href!);
  url.hash = "";
  const allowed =
    prefs.showLinkPreviews !== false &&
    eligibleLinks(message, messages).includes(url.href);
  const query = useQuery({
    ...transport.orpc.links.preview.queryOptions({ input: { url: url.href } }),
    enabled: allowed && (near || opened),
    staleTime: 3_600_000,
    gcTime: 3_600_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const el = ref.current;
    if (!allowed || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      {
        root: el.closest('[data-slot="message-scroller-viewport"]'),
        rootMargin: "300px 0px",
      }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [allowed, url.href]);
  useEffect(
    () => () => {
      if (active === id) openCard(null);
    },
    [id]
  );
  useLayoutEffect(() => {
    if (!opened) return;
    const layout = ref.current?.closest('[data-slot="chat-layout"]');
    const composer = layout?.querySelector('[data-slot="composer-dock"]');
    const measure = () => {
      const top = composer?.getBoundingClientRect().top;
      setBoundary(
        top && top > 0
          ? {
              x: 0,
              y: 0,
              width: window.innerWidth,
              height: Math.max(0, top - 8),
            }
          : undefined
      );
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : undefined;
    if (composer) observer?.observe(composer);
    if (layout) observer?.observe(layout);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [opened]);
  if (!allowed || query.data === null || query.isError) return anchor;
  const preview = query.data;
  const fallback =
    url.hostname + (url.pathname === "/" ? "" : url.pathname.slice(0, 48));
  const caption = bare ? preview?.title || fallback : anchor.props.children;
  const trigger = cloneElement(anchor, {
    className: "reply-inline-link",
    "aria-label": `${preview?.title || fallback} — ${url.hostname}`,
    "data-copy-url": anchor.props.href,
    children: (
      <>
        {preview?.faviconDataUri ? (
          <img
            src={preview.faviconDataUri}
            alt=""
            aria-hidden
            className="reply-link-icon"
          />
        ) : (
          <Globe aria-hidden className="reply-link-icon" />
        )}
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={bare ? preview?.title || fallback : "label"}
            className="reply-link-caption"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : durations.childFade / 1000 }}
          >
            {caption}
          </motion.span>
        </AnimatePresence>
      </>
    ),
  } as ComponentPropsWithRef<"a">);
  return (
    <HoverCard
      open={opened}
      onOpenChange={(value, details) => {
        if (details.reason === "trigger-press") return;
        if (value) openCard(id);
        else if (active === id) openCard(null);
      }}
    >
      <HoverCardTrigger
        ref={ref}
        delay={250}
        closeDelay={120}
        render={trigger}
      />
      <HoverCardContent
        collisionBoundary={boundary}
        side="top"
        align="start"
        sideOffset={8}
        className="reply-link-popup max-h-[var(--available-height)] w-[min(320px,calc(100vw-24px))] overflow-y-auto p-0"
        style={{
          animationDuration: reduced ? "0ms" : `${durations.childFade}ms`,
        }}
      >
        {preview ? (
          cloneElement(anchor, {
            className:
              "block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
            children: <PreviewContent preview={preview} />,
          })
        ) : (
          <div className="p-3" data-slot="reply-link-loading" aria-hidden>
            <Skeleton className="h-3 w-48 motion-reduce:animate-none" />
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
};
