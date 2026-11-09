/**
 * The `memory` tool in a chat: one quiet line when a note was saved, changed
 * or forgotten, read from the tool's own result; nothing for a read, a search
 * or a journal line.
 */
import type { ToolProps } from "@tanstack/ai-react/ui";
import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useNormalizedTool } from "./tool-line";

/** `Saved "name" …` / `Forgot "name" …`, as packages/agent/src/memory/tool.ts words its result. */
const CHANGED = /^(?:Saved|Forgot) "([^"]+)"/;

export const memoryChange = (text: string): string | null =>
  CHANGED.exec(text)?.[1] ?? null;

export const MemoryToolLine = ({ part, result }: ToolProps<unknown>) => {
  const { t } = useTranslation();
  const { tool } = useNormalizedTool(part, result);
  const name = tool.status === "done" ? memoryChange(tool.text) : null;
  if (name == null) return null;
  return (
    <div
      data-slot="memory-updated"
      className="text-muted-foreground my-1 flex items-center gap-1.5 text-xs"
    >
      <Brain aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{t("chat.tool.memoryUpdated", { name })}</span>
    </div>
  );
};
