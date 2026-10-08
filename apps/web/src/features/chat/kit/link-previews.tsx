import type { LinkPreview } from "@abacus-ai/contract/contract/links";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Globe, X } from "lucide-react";
import { motion, type Transition } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { useMotionPreference, motionFor, springs } from "#renderer/lib/motion";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Item, ItemContent } from "#renderer/ui/item";
import { Skeleton } from "#renderer/ui/skeleton";

import { messageLinks } from "../markdown/links";
import { ChatLink } from "../markdown/markdown";
import { useHost } from "../store/selectors";
import { useChatView } from "./context";

const parsed = new WeakMap<UIMessage, string[]>();
const linksOf = (message: UIMessage) => {
  const cached = parsed.get(message);
  if (cached) return cached;
  const urls =
    message.role !== "assistant"
      ? []
      : [
          ...new Set(
            message.parts.flatMap((part) => {
              if (
                part.type !== "text" ||
                (part as { metadata?: { abacus?: { kind?: unknown } } })
                  .metadata?.abacus?.kind != null
              )
                return [];
              return messageLinks(part.content);
            })
          ),
        ];
  parsed.set(message, urls);
  return urls;
};

const storageKey = "reply-preview-dismissals-v1";
const readDismissals = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string").slice(-500)
      : [];
  } catch {
    return [];
  }
};

export const PreviewCard = ({
  preview,
  dismiss,
}: {
  preview: LinkPreview;
  dismiss(): void;
}) => {
  const { t } = useTranslation();
  const hostname = new URL(preview.finalUrl).hostname;
  return (
    <div
      className="relative h-28 w-full min-w-0"
      data-slot="link-preview"
      data-selection-chrome=""
    >
      <Item
        variant="muted"
        size="sm"
        className="h-full flex-nowrap pr-9"
        render={<ChatLink href={preview.url} title={preview.finalUrl} />}
      >
        <ItemContent className="min-w-0 gap-1">
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
            {preview.faviconDataUri ? (
              <img
                src={preview.faviconDataUri}
                alt=""
                className="size-4 shrink-0"
              />
            ) : (
              <Globe aria-hidden className="size-4 shrink-0" />
            )}
            <span className="truncate">
              {preview.siteName === hostname
                ? hostname
                : `${preview.siteName} · ${hostname}`}
            </span>
          </span>
          <span className="line-clamp-2 text-xs font-medium">
            {preview.title}
          </span>
          {preview.description ? (
            <span className="text-muted-foreground line-clamp-2 text-[11px] max-[440px]:hidden">
              {preview.description}
            </span>
          ) : null}
        </ItemContent>
        {preview.imageDataUri ? (
          <img
            src={preview.imageDataUri}
            alt=""
            className="size-16 shrink-0 rounded-md object-cover max-[380px]:size-14"
          />
        ) : null}
      </Item>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1 right-1"
        aria-label={t("chat.links.dismiss", { hostname })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={dismiss}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
};

const Preview = ({
  url,
  enabled,
  dismiss,
}: {
  url: string;
  enabled: boolean;
  dismiss(): void;
}) => {
  const { transport } = useAppContext();
  const query = useQuery({
    ...transport.orpc.links.preview.queryOptions({ input: { url } }),
    enabled,
    staleTime: 3_600_000,
    gcTime: 3_600_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const preference = useMotionPreference();
  const failed = query.isError || query.data === null;
  const loading = (!enabled && query.data === undefined) || query.isLoading;
  return (
    <motion.div
      initial={false}
      animate={{ height: failed ? 0 : 112, opacity: failed ? 0 : 1 }}
      transition={motionFor<Transition>(preference, springs.surface, {
        duration: 0,
      })}
      className="overflow-hidden"
    >
      {failed ? null : loading ? (
        <div
          className="bg-muted/50 h-28 rounded-md p-3"
          data-slot="link-preview-loading"
          aria-hidden
        >
          <Skeleton className="mb-2 h-3 w-24 motion-reduce:animate-none" />
          <Skeleton className="mb-2 h-4 w-3/4 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
        </div>
      ) : query.data ? (
        <PreviewCard preview={query.data} dismiss={dismiss} />
      ) : null}
    </motion.div>
  );
};

export const LinkPreviews = ({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) => {
  const { session, threadId } = useChatView();
  const prefs = usePrefs();
  const messages = useHost(session, (s) => s.messages);
  const root = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissals);
  const enabled = prefs.showLinkPreviews !== false;
  const seen = new Set<string>();
  for (const previous of messages) {
    if (previous.id === message.id) break;
    // A URL owns a slot in its first reply, even when that slot was dismissed.
    linksOf(previous)
      .filter((url) => !seen.has(url))
      .slice(0, 2)
      .forEach((url) => seen.add(url));
  }
  const urls = linksOf(message)
    .filter((url) => !seen.has(url))
    .slice(0, 2);
  const signature = urls.join("\0");
  useEffect(() => {
    const el = root.current;
    if (
      !el ||
      !enabled ||
      streaming ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      {
        root: el.closest('[data-slot="message-scroller-viewport"]'),
        rootMargin: "300px 0px",
      }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, streaming, signature]);
  if (!enabled || streaming || !urls.length) return null;
  return (
    <div
      ref={root}
      className="flex w-full max-w-[520px] flex-col gap-2 select-none"
      data-slot="link-previews"
    >
      {urls.map((url) => {
        const key = `${threadId}\0${message.id}\0${url}`;
        return dismissed.includes(key) ? null : (
          <Preview
            key={url}
            url={url}
            enabled={near}
            dismiss={() => {
              const next = [
                ...readDismissals().filter((item) => item !== key),
                key,
              ].slice(-500);
              setDismissed(next);
              try {
                localStorage.setItem(storageKey, JSON.stringify(next));
              } catch {
                /* Session dismissal still works without storage. */
              }
            }}
          />
        );
      })}
    </div>
  );
};
