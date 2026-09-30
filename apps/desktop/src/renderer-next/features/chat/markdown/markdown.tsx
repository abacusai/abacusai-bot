/**
 * The chat's Markdown (spec 02 §7): TanStack `TextPart` over the pre-pass
 * (math and file links), the synchronous highlighter, and component
 * overrides: links routed by target, code blocks with a header and Copy,
 * inline math, scrolling tables, lazy images. Raw HTML stays escaped.
 */
import { TextPart } from "@tanstack/ai-react/ui";
import { Check, Copy } from "lucide-react";
import {
  Children,
  createContext,
  isValidElement,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";
import { Button } from "#next/ui/button";

import { highlight } from "./highlighter";
import { renderMath, useMathVersion } from "./math";
import { MATH_SENTINEL, pathFromHref, prepass } from "./prepass";

interface MarkdownLinks {
  openFile(absPath: string): void;
  openExternal(url: string): void;
}

const noLinks: MarkdownLinks = { openFile: () => {}, openExternal: () => {} };

const LinksContext = createContext<MarkdownLinks>(noLinks);
export const MarkdownLinksProvider = LinksContext.Provider;

/** Whether the message this block belongs to is still streaming. */
const StreamingContext = createContext(false);

const COLLAPSE_LINES = 30;

/**
 * The app routes on the hash (`router.tsx`), so no link in a message may
 * navigate the window: every click is cancelled and routed by target.
 * In-message anchors (footnotes, `#section`) scroll within the transcript.
 */
const ChatLink = ({ href, children, ...rest }: ComponentProps<"a">) => {
  const links = use(LinksContext);
  const file = pathFromHref(href);
  const external = href != null && /^(https?:|mailto:)/i.test(href);
  return (
    <a
      {...rest}
      href={href}
      data-file={file != null ? "" : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (file != null) links.openFile(file);
        else if (external) links.openExternal(href!);
        else if (href?.startsWith("#") === true && href.length > 1)
          scrollToAnchor(event.currentTarget, href.slice(1));
      }}
    >
      {children}
    </a>
  );
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The element with that id inside the same transcript (or message). */
const scrollToAnchor = (from: HTMLElement, id: string): void => {
  const scope = from.closest('[role="log"]') ?? from.closest(".chat-prose");
  if (scope == null) return;
  const wanted = safeDecode(id);
  const target = [...scope.querySelectorAll<HTMLElement>("[id]")].find(
    (element) =>
      element.id === wanted || element.id === `user-content-${wanted}`
  );
  target?.scrollIntoView?.({ block: "center" });
};

const innerHtmlOf = (children: ReactNode): string | null => {
  const child = Children.toArray(children)[0];
  if (!isValidElement(child)) return null;
  const html = (
    child as ReactElement<{ dangerouslySetInnerHTML?: { __html: string } }>
  ).props.dangerouslySetInnerHTML?.__html;
  return html ?? null;
};

const CodeBlock = (props: ComponentProps<"pre"> & { "data-lang"?: string }) => {
  const { t } = useTranslation();
  const streaming = use(StreamingContext);
  const lang = props["data-lang"] ?? "plaintext";
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current != null) clearTimeout(copiedTimer.current);
    },
    []
  );
  const html = innerHtmlOf(props.children);
  if (lang === "math")
    return (
      <div
        className="chat-math"
        // temml's MathML (§7.3): escaped text, no scripts, `trust: false`.
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    );
  const lines = (html ?? "").split("\n").length;
  const collapsible = lines > COLLAPSE_LINES + 1;
  const copy = () => {
    const text = ref.current?.textContent ?? "";
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    if (copiedTimer.current != null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="chat-code" data-lang={lang}>
      <div className="chat-code-header">
        <span className="chat-code-lang">{lang}</span>
        {streaming ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? t("chat.code.copied") : t("chat.code.copy")}
            onClick={copy}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        )}
      </div>
      <pre
        {...props}
        ref={ref}
        className={cn(
          props.className,
          collapsible && !expanded && "chat-code-collapsed"
        )}
      />
      {collapsible ? (
        <button
          type="button"
          className="chat-code-more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("chat.code.showLess")
            : t("chat.code.showMore", { count: lines - COLLAPSE_LINES })}
        </button>
      ) : null}
    </div>
  );
};

const InlineCode = (props: ComponentProps<"code">) => {
  const { children, ...rest } = props;
  if (
    props.dangerouslySetInnerHTML != null ||
    /\blanguage-/.test(props.className ?? "")
  )
    return <code {...props} />;
  const text = typeof children === "string" ? children : null;
  if (text?.startsWith(MATH_SENTINEL) === true)
    return (
      <span
        className="chat-math-inline"
        title={text.slice(1)}
        dangerouslySetInnerHTML={{ __html: renderMath(text.slice(1), false) }}
      />
    );
  return <code {...rest}>{children}</code>;
};

const Table = (props: ComponentProps<"table">) => (
  <div className="chat-table scroll-fade-x">
    <table {...props} />
  </div>
);

const Image = ({ alt, ...props }: ComponentProps<"img">) => (
  <img {...props} alt={alt ?? ""} loading="lazy" className="chat-image" />
);

const COMPONENTS = {
  a: ChatLink,
  pre: CodeBlock,
  code: InlineCode,
  table: Table,
  img: Image,
};

export interface MarkdownProps {
  content: string;
  role: "user" | "assistant" | "system";
  streaming?: boolean;
  workspaceRoot?: string | null;
  className?: string;
}

export const Markdown = ({
  content,
  role,
  streaming = false,
  workspaceRoot = null,
  className,
}: MarkdownProps) => {
  // Re-render once temml has loaded (math renders as TeX until then). The
  // React Compiler memoises the element on its props, so the version is
  // the key: a new version is a new element, not a cached one.
  const mathVersion = useMathVersion();
  const source = prepass(content, { workspaceRoot });
  return (
    <StreamingContext value={streaming}>
      <TextPart
        key={mathVersion}
        content={source}
        role={role}
        highlighter={highlight}
        components={COMPONENTS}
        className={cn(
          "chat-prose",
          streaming && "chat-prose-streaming",
          className
        )}
      />
    </StreamingContext>
  );
};
