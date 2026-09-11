import type { InlineNode, MarkdownExtension } from "@tanstack/markdown";
import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";
import {
  Markdown as TanStackMarkdown,
  type MarkdownComponentProps,
  type MarkdownComponents,
} from "@tanstack/markdown/react";
import katex from "katex";
import { Check, Copy } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";

import { usePreviewLinkHandler } from "../../providers/preview-link-context";
import { useGlobalContext } from "../../stores/app-global";
import { useCodeFolderContext } from "../../stores/code-folder-context";
import { openLocalFile } from "../../utils/open-local-file";
import { processLatexSections } from "../../utils/process-latex-sections";
import { Button } from "../ui";
import { Skeleton } from "../ui/skeleton";
import {
  highlightMarkdownCode,
  markdownHighlighter,
} from "./markdown-highlighter";
import { localPathFromUrl } from "./markdown-local-links";
import { VisualizerSegment } from "./visualizer-segment";

const MATH_INLINE_PREFIX = "TANSTACK_MATH_INLINE_";
const MATH_BLOCK_LANGUAGE = "tanstack-math";
const LOCAL_FILE_PREFIX = "/__abacus_local_file__/";
const DATA_IMAGE_PREFIX = "/__abacus_data_image__/";

const encodePayload = (value: string): string =>
  Array.from(value, (character) => character.codePointAt(0)!.toString(16)).join(
    "-"
  );

const decodePayload = (value: string): string | null => {
  try {
    return value
      .split("-")
      .filter(Boolean)
      .map((part) => String.fromCodePoint(Number.parseInt(part, 16)))
      .join("");
  } catch {
    return null;
  }
};

const rewriteUrl = (value: string): string => {
  if (value.startsWith("file://")) {
    return `${LOCAL_FILE_PREFIX}${encodePayload(value.slice("file://".length))}`;
  }
  if (value.startsWith("data:image/")) {
    return `${DATA_IMAGE_PREFIX}${encodePayload(value)}`;
  }
  return value;
};

const mapOutsideCode = (
  markdown: string,
  transform: (segment: string) => string
): string =>
  markdown
    .split(/(`{3,}[\s\S]*?(?:`{3,}|$)|~{3,}[\s\S]*?(?:~{3,}|$)|`[^`\n]+`)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : transform(segment)))
    .join("");

/** Keep local and data-image URLs inside TanStack Markdown's safe URL profile. */
const prepareMarkdownUrls = (markdown: string): string =>
  mapOutsideCode(markdown, (segment) =>
    segment.replace(
      /(!?\[[^\]\n]*\]\()([^\n)]*)(\))/g,
      (match, open: string, destination: string, close: string) => {
        const parsed = destination.match(
          /^\s*(?:<([^>]*)>|(\S+))(?:\s+(["'])(.*?)\3)?\s*$/
        );
        if (!parsed) return match;
        const url = parsed[1] ?? parsed[2] ?? "";
        const rewritten = rewriteUrl(url);
        if (rewritten === url) return match;
        const title = parsed[4] ? ` "${parsed[4]}"` : "";
        return `${open}${rewritten}${title}${close}`;
      }
    )
  );

/** Encode math as ordinary Markdown nodes so the safe React renderer can own it. */
const prepareMath = (markdown: string): string => {
  return mapOutsideCode(markdown, (segment) =>
    segment
      .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, math: string) => {
        return `\n\n\`\`\`${MATH_BLOCK_LANGUAGE}\n${encodePayload(math)}\n\`\`\`\n\n`;
      })
      .replace(/(?<!\\)\$([^$\n]+?)\$/g, (_match, math: string) => {
        return `\`${MATH_INLINE_PREFIX}${encodePayload(math)}\``;
      })
  );
};

const pushTextWithBreaks = (nodes: InlineNode[], text: string): void => {
  const lines = text.split("\n");
  lines.forEach((part, index) => {
    if (part) nodes.push({ type: "text", value: part });
    if (index < lines.length - 1) nodes.push({ type: "break" });
  });
};

const splitText = (value: string): InlineNode[] => {
  const nodes: InlineNode[] = [];
  const urlPattern = /https?:\/\/[^\s<]+/g;
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    const start = match.index;
    const raw = match[0];
    const href = raw.replace(/[),.;!?]+$/, "");
    pushTextWithBreaks(nodes, value.slice(cursor, start));
    nodes.push({
      type: "link",
      href,
      children: [{ type: "text", value: href }],
    });
    pushTextWithBreaks(nodes, raw.slice(href.length));
    cursor = start + raw.length;
  }
  pushTextWithBreaks(nodes, value.slice(cursor));
  return nodes;
};

const transformInlineNodes = (nodes: InlineNode[]): InlineNode[] =>
  nodes.flatMap((node) => {
    if (node.type === "text") return splitText(node.value);
    if (
      node.type === "strong" ||
      node.type === "emphasis" ||
      node.type === "strike"
    ) {
      return [{ ...node, children: transformInlineNodes(node.children) }];
    }
    return [node];
  });

const chatMarkdownExtension: MarkdownExtension = {
  name: "abacus-chat-markdown",
  transformInline: transformInlineNodes,
};
const COMPLETE_EXTENSIONS = [chatMarkdownExtension];
const STREAMING_EXTENSIONS = [
  chatMarkdownExtension,
  streamingMarkdownExtension(),
];

const isLocalHref = (href: string): boolean =>
  href.startsWith("/") ||
  href.startsWith("./") ||
  href.startsWith("../") ||
  href.startsWith("~/") ||
  /^[A-Za-z]:[\\/]/.test(href) ||
  (!/^[a-z][a-z0-9+.-]*:/i.test(href) &&
    !href.startsWith("//") &&
    !href.startsWith("#"));

const decodedLocalPath = (href: string): string | null => {
  if (href.startsWith(LOCAL_FILE_PREFIX)) {
    return decodePayload(href.slice(LOCAL_FILE_PREFIX.length));
  }
  return localPathFromUrl(href) ?? (isLocalHref(href) ? href : null);
};

const Anchor = ({ href, children, ...props }: MarkdownComponentProps<"a">) => {
  const currentFolder = useCodeFolderContext((state) => state.currentFolder);
  const previewHandler = usePreviewLinkHandler();
  const rawPath = href ? decodedLocalPath(href) : null;
  return (
    <a
      {...props}
      href={rawPath ?? href}
      rel={rawPath == null ? "noopener noreferrer" : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (!href) return;
        if (rawPath != null) {
          const isAbsolute =
            rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath);
          const resolved =
            isAbsolute || !currentFolder
              ? rawPath
              : `${currentFolder}/${rawPath.replace(/^\.\//, "")}`;
          if (previewHandler) previewHandler(resolved);
          else void openLocalFile(resolved);
          return;
        }
        // A web link goes to the browser, never the preview pane: the pane has
        // no address bar, tabs, history or signed-in sessions.
        window.api.openExternal(href);
      }}
    >
      {children}
    </a>
  );
};

const POSIX_ROOTS =
  "Users|home|tmp|private|var|opt|etc|mnt|media|srv|Volumes|Applications|Library";
const CLICKABLE_PATH_RE = new RegExp(
  `^(?:~\\/|\\/(?:${POSIX_ROOTS})\\/|[A-Za-z]:[\\\\/])[^\`"'<>|*?]+\\.[A-Za-z0-9]{1,8}$`
);

const renderMath = (value: string, displayMode: boolean): string =>
  katex.renderToString(value, {
    displayMode,
    throwOnError: false,
    strict: "ignore",
    trust: false,
  });

const InlineCode = ({
  className,
  children,
  ...props
}: MarkdownComponentProps<"code">) => {
  const previewHandler = usePreviewLinkHandler();
  const homeDir = useGlobalContext((state) => state.homeDir);
  const { t } = useTranslation();
  const text = typeof children === "string" ? children : "";
  if (!className && text.startsWith(MATH_INLINE_PREFIX)) {
    const math = decodePayload(text.slice(MATH_INLINE_PREFIX.length));
    if (math != null) {
      return (
        <span
          className="katex-inline"
          dangerouslySetInnerHTML={{ __html: renderMath(math, false) }}
        />
      );
    }
  }
  if (!className && CLICKABLE_PATH_RE.test(text)) {
    const resolved = text.startsWith("~")
      ? homeDir.length > 0
        ? `${homeDir}${text.slice(1)}`
        : null
      : text;
    if (resolved != null) {
      const open = (): void => {
        if (previewHandler) previewHandler(resolved);
        else void openLocalFile(resolved);
      };
      return (
        <code
          {...props}
          className="hover:text-primary cursor-pointer underline decoration-dotted underline-offset-2"
          role="link"
          tabIndex={0}
          title={t("workspace.openPathInPreview")}
          onClick={open}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }}
        >
          {children}
        </code>
      );
    }
  }
  return (
    <code {...props} className={className}>
      {children}
    </code>
  );
};

const extractText = (node: React.ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
};

const CodeBlock = ({
  children,
  className,
  ...props
}: MarkdownComponentProps<"pre">) => {
  const [copied, setCopied] = useState(false);
  const codeElement = React.isValidElement(children) ? children : null;
  const codeProps = codeElement?.props as
    | { children?: React.ReactNode; className?: string }
    | undefined;
  const code = extractText(codeProps?.children ?? children).replace(/\n$/, "");
  const language =
    /language-([\w-]+)/.exec(codeProps?.className ?? "")?.[1] ?? "plaintext";
  if (language === MATH_BLOCK_LANGUAGE) {
    const math = decodePayload(code.trim());
    return math == null ? null : (
      <div
        className="katex-only"
        dangerouslySetInnerHTML={{ __html: renderMath(math, true) }}
      />
    );
  }
  if (language === "visualizer") {
    return <VisualizerSegment code={code} data-id="visualizer-segment" />;
  }
  const markup = highlightMarkdownCode(code, language);
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="group/code relative my-3 min-w-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre
        {...props}
        className={cn("th-code overflow-x-auto rounded-md p-3", className)}
        data-language={markdownHighlighter.normalizeLanguage(language)}
      >
        <code dangerouslySetInnerHTML={{ __html: markup }} />
      </pre>
    </div>
  );
};

const LocalImage = ({
  path,
  alt,
  title,
}: {
  path: string;
  alt?: string;
  title?: string;
}) => {
  const currentFolder = useCodeFolderContext((state) => state.currentFolder);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const filePath = useMemo(() => {
    if (path.startsWith("/") || path.startsWith("~")) return path;
    return currentFolder
      ? `${currentFolder}/${path.replace(/^\.\//, "")}`
      : path;
  }, [path, currentFolder]);
  React.useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);
    const lastSlash = filePath.lastIndexOf("/");
    const hostRoot = lastSlash > 0 ? filePath.slice(0, lastSlash) : filePath;
    void window.api.files
      .readImageAsDataUrl({ filePath, hostRoot })
      .then((result) => {
        if (cancelled) return;
        if (result?.success === true && result.dataUrl != null) {
          setDataUrl(result.dataUrl);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  if (failed)
    return <span className="text-muted-foreground">{alt || filePath}</span>;
  if (dataUrl == null) return <Skeleton className="h-24 w-full rounded-md" />;
  return (
    <img
      src={dataUrl}
      alt={alt ?? ""}
      title={title}
      className="max-w-full rounded-md"
    />
  );
};

const Image = ({
  src,
  alt,
  title,
  ...props
}: MarkdownComponentProps<"img">) => {
  const source = typeof src === "string" ? src : "";
  if (source.startsWith(DATA_IMAGE_PREFIX)) {
    const dataUrl = decodePayload(source.slice(DATA_IMAGE_PREFIX.length));
    return dataUrl == null ? null : (
      <img
        {...props}
        src={dataUrl}
        alt={alt ?? ""}
        title={title}
        className="max-w-full rounded-md"
      />
    );
  }
  const localPath = decodedLocalPath(source);
  if (localPath != null) {
    return <LocalImage path={localPath} alt={alt} title={title} />;
  }
  return (
    <img
      {...props}
      src={source}
      alt={alt ?? ""}
      title={title}
      className="max-w-full rounded-md"
    />
  );
};

const COMPONENTS = {
  a: Anchor,
  code: InlineCode,
  img: Image,
  pre: CodeBlock,
  p: (props: MarkdownComponentProps<"p">) => (
    <p {...props} className="my-2 first:mt-0 last:mb-0" />
  ),
  ul: (props: MarkdownComponentProps<"ul">) => (
    <ul {...props} className="my-2 list-disc space-y-1 pl-5" />
  ),
  ol: (props: MarkdownComponentProps<"ol">) => (
    <ol {...props} className="my-2 list-decimal space-y-1 pl-5" />
  ),
  li: (props: MarkdownComponentProps<"li">) => (
    <li {...props} className="marker:text-muted-foreground pl-1" />
  ),
  blockquote: (props: MarkdownComponentProps<"blockquote">) => (
    <blockquote
      {...props}
      className="text-muted-foreground my-3 border-l-2 pl-4 not-italic"
    />
  ),
  h1: (props: MarkdownComponentProps<"h1">) => (
    <h1 {...props} className="mt-5 mb-2 text-xl font-semibold first:mt-0" />
  ),
  h2: (props: MarkdownComponentProps<"h2">) => (
    <h2 {...props} className="mt-5 mb-2 text-lg font-semibold first:mt-0" />
  ),
  h3: (props: MarkdownComponentProps<"h3">) => (
    <h3 {...props} className="mt-4 mb-2 text-base font-semibold first:mt-0" />
  ),
  h4: (props: MarkdownComponentProps<"h4">) => (
    <h4 {...props} className="mt-3 mb-1 font-semibold first:mt-0" />
  ),
  hr: (props: MarkdownComponentProps<"hr">) => (
    <hr {...props} className="border-border my-4" />
  ),
  section: (props: MarkdownComponentProps<"section">) => (
    <section
      {...props}
      className="text-muted-foreground mt-5 border-t pt-3 text-xs"
    />
  ),
  table: (props: MarkdownComponentProps<"table">) => (
    <div className="my-4 max-w-full overflow-x-auto rounded-md border">
      <table {...props} className="w-full border-collapse text-left" />
    </div>
  ),
  th: (props: MarkdownComponentProps<"th">) => (
    <th {...props} className="bg-muted/50 border-b px-3 py-2 font-medium" />
  ),
  td: (props: MarkdownComponentProps<"td">) => (
    <td {...props} className="border-b px-3 py-2 align-top last:border-b-0" />
  ),
} satisfies MarkdownComponents;

interface MarkdownProps {
  content: string;
  streaming?: boolean;
  truncateLines?: number;
  className?: string;
}

export const Markdown = ({
  content,
  streaming = false,
  truncateLines,
  className,
}: MarkdownProps) => {
  const processed = useMemo(
    () => prepareMarkdownUrls(prepareMath(processLatexSections(content ?? ""))),
    [content]
  );
  const { displayed, lineCount, isTruncated } = useMemo(() => {
    if (!truncateLines) {
      return { displayed: processed, lineCount: 0, isTruncated: false };
    }
    const lines = processed.split("\n");
    if (lines.length <= truncateLines) {
      return {
        displayed: processed,
        lineCount: lines.length,
        isTruncated: false,
      };
    }
    return {
      displayed: lines.slice(0, truncateLines).join("\n"),
      lineCount: lines.length,
      isTruncated: true,
    };
  }, [processed, truncateLines]);
  const [expanded, setExpanded] = useState(false);
  const handleExpand = useCallback(() => setExpanded(true), []);
  const finalContent = expanded ? processed : displayed;
  const rendered = (
    <div className={cn("markdown", className)}>
      <TanStackMarkdown
        allowHtml={false}
        frontmatter={false}
        headingIds={false}
        extensions={streaming ? STREAMING_EXTENSIONS : COMPLETE_EXTENSIONS}
        components={COMPONENTS}
      >
        {finalContent}
      </TanStackMarkdown>
    </div>
  );
  if (!isTruncated || expanded) return rendered;
  return (
    <>
      {rendered}
      <Button
        variant="ghost"
        size="xs"
        onClick={handleExpand}
        className="mt-1"
        data-id="markdown-expand-truncated-btn"
      >
        Show all ({lineCount.toLocaleString()} lines,{" "}
        {(lineCount - truncateLines!).toLocaleString()} more)
      </Button>
    </>
  );
};
