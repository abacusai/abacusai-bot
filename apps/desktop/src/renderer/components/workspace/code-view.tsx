import { Check, Copy } from "lucide-react";
import { type JSX, useMemo, useState } from "react";

import { cn } from "#renderer/lib/cn";

import {
  highlightMarkdownCode,
  markdownHighlighter,
} from "../common/markdown-highlighter";
import { Button } from "../ui";

interface CodeViewProps {
  code: string;
  language: string;
  /** Show line numbers in the rendered block. @default true */
  lineNumbers?: boolean;
  /** Render line numbers starting from this value (default 1). */
  startingLineNumber?: number;
  className?: string;
}

const offsetLineNumbers = (
  markup: string,
  startingLineNumber: number
): string =>
  markup.replace(/data-line="(\d+)"/g, (_match, line: string) => {
    return `data-line="${Number.parseInt(line, 10) + startingLineNumber - 1}"`;
  });

export function CodeView({
  code,
  language,
  lineNumbers = true,
  startingLineNumber = 1,
  className,
}: CodeViewProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = markdownHighlighter.normalizeLanguage(language);
  const markup = useMemo(() => {
    const highlighted = highlightMarkdownCode(code, language || "plaintext", {
      lineNumbers,
    });
    return startingLineNumber > 1
      ? offsetLineNumbers(highlighted, startingLineNumber)
      : highlighted;
  }, [code, language, lineNumbers, startingLineNumber]);

  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={cn("group/code relative min-w-0", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute end-1.5 top-1.5 z-10 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100 focus:opacity-100"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre
        className={cn(
          "th-code h-full overflow-auto rounded-md p-3",
          lineNumbers && "th-code--line-numbers"
        )}
        data-language={normalizedLanguage}
      >
        <code dangerouslySetInnerHTML={{ __html: markup }} />
      </pre>
    </div>
  );
}
