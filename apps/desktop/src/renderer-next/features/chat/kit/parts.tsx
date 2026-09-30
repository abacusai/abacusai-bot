/**
 * Part widgets (spec 02 §5.3): text dispatched on `metadata.abacus.kind`
 * (transport C.3's migrated segment kinds; live text never sets it),
 * thinking, image, video, document and the unknown-part fallback.
 */
import type { PartProps } from "@tanstack/ai-react/ui";
import { Brain, ChevronRight, FileText, Globe, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "#next/ui/attachment";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#next/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "#next/ui/marker";

import { Markdown } from "../markdown/markdown";
import { useChatView } from "./context";
import { useMessageScope } from "./message-scope";
import { NoticeRow } from "./status/status";

type Loose = Record<string, unknown>;

const abacusOf = (value: unknown): Loose =>
  ((value as { metadata?: { abacus?: Loose } } | undefined)?.metadata?.abacus ??
    {}) as Loose;

const DEV = import.meta.env.DEV;

const Collapsed = ({ title, content }: { title: string; content: string }) => {
  const { workspaceRoot } = useChatView();
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/c text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs">
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform group-data-[panel-open]/c:rotate-90"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <Markdown
          content={content}
          role="assistant"
          workspaceRoot={workspaceRoot}
        />
      </CollapsibleContent>
    </Collapsible>
  );
};

interface SearchResult {
  title?: string;
  url?: string;
  snippet?: string;
}

export const TextPartDispatch = ({ part }: PartProps<unknown, "text">) => {
  const { t } = useTranslation();
  const { workspaceRoot, runtime, skin } = useChatView();
  const scope = useMessageScope();
  const abacus = abacusOf(part);
  const kind = typeof abacus.kind === "string" ? abacus.kind : null;
  const content = (part as { content: string }).content;
  switch (kind) {
    case null: {
      if (content === "") return null;
      const text = (
        <Markdown
          content={content}
          role={scope.role}
          streaming={scope.streaming}
          workspaceRoot={workspaceRoot}
        />
      );
      return skin === "bot" && scope.role === "assistant" ? (
        <div
          className="w-fit max-w-[min(520px,85%)] rounded-[20px] rounded-bl-md bg-[var(--chat-surface)] px-3 py-2"
          data-slot="bot-bubble"
        >
          {text}
        </div>
      ) : (
        text
      );
    }
    case "notification":
      return (
        <NoticeRow
          notice={{
            key: String(abacus.notificationKey ?? abacus.segmentId ?? ""),
            seq: 0,
            name: "agent.notification",
            value: {
              message: content,
              severity: abacus.severity ?? "info",
              actions: abacus.actions,
            },
          }}
          onDismiss={() => {}}
        />
      );
    case "collapsible":
      return (
        <Collapsed
          title={String(abacus.title ?? t("chat.part.details"))}
          content={content}
        />
      );
    case "web_search_results": {
      const results = (abacus.results as SearchResult[] | undefined) ?? [];
      return (
        <div
          className="flex flex-col gap-1.5 rounded-xl bg-[var(--chat-surface-2)] p-3 text-sm"
          data-slot="search-results"
        >
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Globe aria-hidden className="size-3.5" />
            {content}
          </div>
          <ul className="flex flex-col gap-1">
            {results.map((result, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded-md px-1 py-0.5 text-start hover:bg-[var(--chat-surface)]"
                  onClick={() =>
                    result.url != null &&
                    void runtime.host.openExternal(result.url)
                  }
                >
                  <span className="truncate font-medium">
                    {result.title ?? result.url}
                  </span>
                  {result.snippet != null ? (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {result.snippet}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "feature_limit":
      return (
        <div
          className="rounded-xl bg-[var(--chat-surface)] p-3 text-sm"
          data-slot="feature-limit"
        >
          {t("chat.part.featureLimit", {
            feature: String(abacus.featureName ?? ""),
          })}
        </div>
      );
    case "compaction":
      return (
        <div className="flex flex-col gap-1">
          <Marker variant="separator">
            <MarkerIcon>
              <Layers aria-hidden />
            </MarkerIcon>
            <MarkerContent>{t("chat.part.compaction")}</MarkerContent>
          </Marker>
          {content !== "" ? (
            <Collapsed title={t("chat.part.summary")} content={content} />
          ) : null}
        </div>
      );
    default:
      return DEV ? (
        <div className="text-muted-foreground text-xs">{`[${kind}]`}</div>
      ) : null;
  }
};

/** `ThinkingView`: Marker + shimmer while it is the live last part, then "Thoughts". */
export const ThinkingView = ({ part }: PartProps<unknown, "thinking">) => {
  const { t } = useTranslation();
  const { workspaceRoot } = useChatView();
  const scope = useMessageScope();
  const content = (part as { content: string }).content;
  const thinking = scope.streaming && isLive(part);
  const title =
    typeof abacusOf(part).title === "string"
      ? String(abacusOf(part).title)
      : null;
  return (
    <Collapsible>
      <Marker
        render={<CollapsibleTrigger />}
        className="hover:text-foreground cursor-pointer"
      >
        <MarkerIcon>
          <Brain aria-hidden />
        </MarkerIcon>
        <MarkerContent className={cn(thinking && "shimmer")}>
          {thinking
            ? t("chat.part.thinking")
            : (title ?? t("chat.part.thoughts"))}
        </MarkerContent>
      </Marker>
      <CollapsibleContent className="text-muted-foreground ps-5 pt-1">
        <Markdown
          content={content}
          role="assistant"
          workspaceRoot={workspaceRoot}
        />
      </CollapsibleContent>
    </Collapsible>
  );
};

/** Whether a thinking part is the last of the newest assistant message. */
const lastThinking = new WeakSet<object>();
export const markLiveThinking = (message: {
  role: string;
  parts: readonly object[];
}): void => {
  const last = message.parts.at(-1);
  if (
    message.role === "assistant" &&
    last != null &&
    (last as { type?: string }).type === "thinking"
  )
    lastThinking.add(last);
};
const isLive = (part: object): boolean => lastThinking.has(part);

const mediaSource = (part: unknown): string | null => {
  const source = (
    part as { source?: { type?: string; value?: string; mimeType?: string } }
  ).source;
  if (source?.value == null) return null;
  return source.type === "data"
    ? `data:${source.mimeType ?? "application/octet-stream"};base64,${source.value}`
    : source.value;
};

export const ImageView = ({ part }: PartProps<unknown, "image">) => {
  const src = mediaSource(part);
  const abacus = abacusOf(part);
  if (src == null) return null;
  return (
    <figure className="flex max-w-md flex-col gap-1">
      <img
        src={src}
        alt={typeof abacus.prompt === "string" ? abacus.prompt : ""}
        loading="lazy"
        width={typeof abacus.width === "number" ? abacus.width : undefined}
        height={typeof abacus.height === "number" ? abacus.height : undefined}
        className="h-auto max-w-full rounded-xl"
      />
      {typeof abacus.prompt === "string" ? (
        <figcaption className="text-muted-foreground text-xs">
          {abacus.prompt}
        </figcaption>
      ) : null}
    </figure>
  );
};

export const VideoView = ({ part }: PartProps<unknown, "video">) => {
  const src = mediaSource(part);
  const abacus = abacusOf(part);
  if (src == null) return null;
  return (
    <video
      src={src}
      controls
      preload="metadata"
      loop={abacus.loop === true}
      style={
        typeof abacus.aspectRatio === "string"
          ? { aspectRatio: abacus.aspectRatio }
          : undefined
      }
      className="max-w-md rounded-xl"
    />
  );
};

export const DocumentView = ({ part }: PartProps<unknown, "document">) => {
  const src = mediaSource(part);
  const name =
    (part as { name?: string }).name ?? src?.split(/[\\/]/).at(-1) ?? "";
  return (
    <Attachment className="max-w-64">
      <AttachmentMedia>
        <FileText aria-hidden />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {(part as { source?: { mimeType?: string } }).source?.mimeType ?? ""}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
};

export const UnknownPart = ({ part }: PartProps<unknown>) =>
  DEV ? (
    <div className="text-muted-foreground text-xs">{`[${(part as { type: string }).type}]`}</div>
  ) : null;
