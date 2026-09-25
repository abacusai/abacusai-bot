import { diffLines, diffWords, Change } from "diff";
import { Expand } from "lucide-react";
import {
  type CSSProperties,
  type JSX,
  type ReactNode,
  useMemo,
  useCallback,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";

/**
 * The shape this component reads off an edit tool call. Kept local and minimal
 * rather than importing a provider-wide tool union.
 */
interface EditToolResult {
  targetFile?: string;
  originalContent?: string;
  finalContent?: string;
  isNewFile?: boolean;
  codeChanges?: Array<{ type: string; text: string }>;
}

interface ToolUseRequest {
  input?: unknown;
}

interface CodeDiffFullProps {
  // Mode 1: request object
  request?: ToolUseRequest;
  // Mode 2: direct old/new code (compute diff)
  oldCode?: string;
  newCode?: string;
  // Mode 3: unified diff text (parse +/-/@@ markers)
  diffText?: string;
  // Mode 4: plain text (no diff, just line numbers)
  plainText?: string;
  maxLines?: number;
  maxHeight?: number;
  allowScroll?: boolean;
  isRightPanel?: boolean;
}

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
  // For word-level highlighting, store the paired line content
  pairedContent?: string;
}

const parseDiffText = (diffText: string): DiffLine[] => {
  const lines = diffText.split("\n");
  const result: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    // Parse hunk header for line numbers
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[2], 10);
      }
      continue; // Don't render the @@ line itself
    }

    if (line.startsWith("+")) {
      result.push({
        type: "add",
        content: line.slice(1),
        newLineNum: newLineNum++,
      });
    } else if (line.startsWith("-")) {
      result.push({
        type: "remove",
        content: line.slice(1),
        oldLineNum: oldLineNum++,
      });
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      result.push({
        type: "context",
        content,
        oldLineNum: oldLineNum++,
        newLineNum: newLineNum++,
      });
    }
  }

  return result;
};

const parsePlainText = (text: string): DiffLine[] => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.map((content, i) => ({
    type: "context" as const,
    content,
    newLineNum: i + 1,
  }));
};

const renderWordDiff = (
  oldContent: string,
  newContent: string,
  type: "add" | "remove"
): ReactNode => {
  const wordChanges = diffWords(oldContent, newContent);

  return wordChanges.map((part, i) => {
    // Highlight the added parts on 'add' lines, the removed on 'remove'.
    if (type === "add" && part.added) {
      return (
        <span key={i} className="code-diff-word-add">
          {part.value}
        </span>
      );
    } else if (type === "remove" && part.removed) {
      return (
        <span key={i} className="code-diff-word-remove">
          {part.value}
        </span>
      );
    } else if (
      (type === "add" && !part.removed) ||
      (type === "remove" && !part.added)
    ) {
      return <span key={i}>{part.value}</span>;
    }
    return null;
  });
};

export function CodeDiffFull({
  request,
  oldCode: propOldCode,
  newCode: propNewCode,
  diffText,
  plainText,
  maxLines,
  maxHeight,
  allowScroll = false,
  isRightPanel = false,
}: CodeDiffFullProps): JSX.Element {
  const { t } = useTranslation();
  const editResult = request?.input as EditToolResult | undefined;
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpandedInline, setIsExpandedInline] = useState(false);

  const isPlainTextMode = !!plainText;

  const { oldCode, newCode } = useMemo(() => {
    if (propOldCode !== undefined || propNewCode !== undefined) {
      return {
        oldCode: propOldCode ?? "",
        newCode: propNewCode ?? "",
      };
    }
    const changes = editResult?.codeChanges ?? [];
    const oldItem = changes.find((c) => c.type === "old");
    const newItem = changes.find((c) => c.type === "new");
    return {
      oldCode: oldItem?.text ?? editResult?.originalContent ?? "",
      newCode: newItem?.text ?? editResult?.finalContent ?? "",
    };
  }, [editResult, propOldCode, propNewCode]);

  const allLines = useMemo(() => {
    // Priority: diffText > plainText > oldCode/newCode > request
    if (diffText) {
      return parseDiffText(diffText);
    }
    if (plainText) {
      return parsePlainText(plainText);
    }

    if (!oldCode && !newCode) return [];

    const changes: Change[] = diffLines(oldCode, newCode);
    const result: DiffLine[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;

    const tempLines: DiffLine[] = [];

    changes.forEach((change) => {
      const changeLines = change.value.split("\n");
      if (changeLines[changeLines.length - 1] === "") {
        changeLines.pop();
      }

      changeLines.forEach((line) => {
        if (change.added) {
          tempLines.push({
            type: "add",
            content: line,
            newLineNum: newLineNum++,
          });
        } else if (change.removed) {
          tempLines.push({
            type: "remove",
            content: line,
            oldLineNum: oldLineNum++,
          });
        } else {
          tempLines.push({
            type: "context",
            content: line,
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
          });
        }
      });
    });

    for (let i = 0; i < tempLines.length; i++) {
      const line = tempLines[i];

      if (line.type === "remove") {
        const removes: DiffLine[] = [line];
        let j = i + 1;
        while (j < tempLines.length && tempLines[j].type === "remove") {
          removes.push(tempLines[j]);
          j++;
        }

        const adds: DiffLine[] = [];
        while (j < tempLines.length && tempLines[j].type === "add") {
          adds.push(tempLines[j]);
          j++;
        }

        const pairCount = Math.min(removes.length, adds.length);
        for (let k = 0; k < removes.length; k++) {
          if (k < pairCount) {
            removes[k].pairedContent = adds[k].content;
          }
          result.push(removes[k]);
        }
        for (let k = 0; k < adds.length; k++) {
          if (k < pairCount) {
            adds[k].pairedContent = removes[k].content;
          }
          result.push(adds[k]);
        }

        i = j - 1; // Skip processed lines
      } else {
        result.push(line);
      }
    }

    return result;
  }, [diffText, plainText, oldCode, newCode]);

  useLayoutEffect(() => {
    if (!maxHeight || isRightPanel) {
      setIsOverflowing(false);
      return;
    }

    const el = contentRef.current;
    if (!el) return;

    const checkOverflow = () => {
      setIsOverflowing(el.scrollHeight > el.clientHeight);
    };

    checkOverflow();

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);

    return () => observer.disconnect();
  }, [maxHeight, isRightPanel, allLines]);

  const { displayLines, countMore } = useMemo(() => {
    if (maxHeight) {
      return { displayLines: allLines, countMore: null };
    }
    if (isRightPanel || !maxLines || allLines.length <= maxLines) {
      return { displayLines: allLines, countMore: null };
    }
    const countMore = allLines.length - maxLines;
    const displayLines = allLines.slice(-maxLines);
    return { displayLines, countMore };
  }, [allLines, maxLines, maxHeight, isRightPanel]);

  // Expand in place: reveals the full diff inside the message.
  const handleExpand = useCallback(() => setIsExpandedInline(true), []);

  if (allLines.length === 0) {
    return (
      <div className="bg-muted text-muted-foreground rounded-md border px-3 py-2 text-sm">
        {t("diff.noChanges")}
      </div>
    );
  }

  const getLineClassName = (type: "add" | "remove" | "context"): string => {
    switch (type) {
      case "add":
        return "code-diff-line code-diff-line-add";
      case "remove":
        return "code-diff-line code-diff-line-remove";
      default:
        return "code-diff-line";
    }
  };

  const getPrefix = (type: "add" | "remove" | "context"): string => {
    switch (type) {
      case "add":
        return "+";
      case "remove":
        return "-";
      default:
        return " ";
    }
  };

  const renderContent = (line: DiffLine): ReactNode => {
    if (
      line.pairedContent !== undefined &&
      (line.type === "add" || line.type === "remove")
    ) {
      if (line.type === "remove") {
        return renderWordDiff(line.content, line.pairedContent, "remove");
      } else {
        return renderWordDiff(line.pairedContent, line.content, "add");
      }
    }
    return line.content || " "; // Use space for empty lines to maintain height
  };

  // maxLines mode uses countMore; maxHeight mode uses overflow (when !allowScroll).
  const showMoreHeader = isExpandedInline
    ? false
    : maxHeight
      ? isOverflowing && !allowScroll
      : countMore != null;

  const moreElem = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleExpand}
      className="text-muted-foreground mb-2 w-full justify-between rounded-none border-b"
    >
      <span />
      <span>
        {countMore != null ? `(${countMore} more lines)` : "(more content)"}
      </span>
      <Expand />
    </Button>
  );

  const containerStyle: CSSProperties = {
    ...(maxHeight &&
      !isRightPanel && {
        maxHeight: maxHeight,
        overflowY: allowScroll ? "auto" : "hidden",
      }),
  };

  return (
    <div
      className={`code-diff my-1 overflow-hidden rounded-lg ${isRightPanel ? "" : "border-border border"}`}
      style={containerStyle}
      ref={contentRef}
    >
      {showMoreHeader && moreElem}
      {displayLines.map((line, i) => (
        <div key={i} className={getLineClassName(line.type)}>
          {/* Old line number - hidden in plain text mode */}
          {!isPlainTextMode && (
            <span className="code-diff-line-num code-diff-line-num-old">
              {line.oldLineNum ?? ""}
            </span>
          )}
          {/* New line number (or single line number in plain text mode) */}
          <span
            className={`code-diff-line-num ${isPlainTextMode ? "" : "code-diff-line-num-new"}`}
          >
            {line.newLineNum ?? ""}
          </span>
          {/* Prefix - hidden in plain text mode */}
          {!isPlainTextMode && (
            <span className="code-diff-prefix">{getPrefix(line.type)}</span>
          )}
          <span className="code-diff-content">{renderContent(line)}</span>
        </div>
      ))}
    </div>
  );
}
