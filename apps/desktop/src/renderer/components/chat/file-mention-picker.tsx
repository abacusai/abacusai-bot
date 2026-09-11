import { motion, AnimatePresence } from "framer-motion";
import { File as FileIcon, Folder as FolderIcon, SearchX } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "../ui";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../ui/item";

export interface FileMentionItem {
  relativePath: string;
  fileName: string;
  kind: "file" | "directory";
}

interface FileMentionPickerProps {
  results: FileMentionItem[];
  selectedIndex: number;
  onSelect: (item: FileMentionItem) => void;
  visible: boolean;
  query: string;
  isLoading: boolean;
  isError: boolean;
}

export const FileMentionPicker = ({
  results,
  selectedIndex,
  onSelect,
  visible,
  query,
  isLoading,
  isError,
}: FileMentionPickerProps) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const top = results.slice(0, 10);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!visible) return null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          id="file-mention-picker"
          data-id="file-mention-picker"
          role="listbox"
          aria-label={t("workspace.attach.mentionTip")}
          className="bg-popover text-popover-foreground ring-foreground/10 absolute right-0 bottom-full left-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg p-1 shadow-md ring-1"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
        >
          <div className="text-muted-foreground flex h-6 items-center gap-2 px-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono">@{query}</span>
            {isLoading && <Spinner />}
          </div>
          {top.length > 0 ? (
            <ItemGroup ref={listRef} className="gap-0" role="presentation">
              {top.map((item, i) => (
                <Item
                  render={<button type="button" />}
                  size="xs"
                  key={item.relativePath}
                  id={`file-mention-option-${i}`}
                  data-id={`file-mention-item-${i}`}
                  role="option"
                  aria-selected={i === selectedIndex}
                  className={`min-h-7 cursor-default flex-nowrap gap-2 px-2 py-1 text-left ${
                    i === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent hover:text-accent-foreground"
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(item);
                  }}
                >
                  <ItemMedia variant="icon">
                    {item.kind === "directory" ? (
                      <FolderIcon className="text-primary" />
                    ) : (
                      <FileIcon className="text-muted-foreground" />
                    )}
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-row items-baseline gap-1.5!">
                    <ItemTitle className="max-w-1/2 shrink-0">
                      <span className="truncate">{item.fileName}</span>
                    </ItemTitle>
                    {item.relativePath !== item.fileName && (
                      <ItemDescription className="min-w-0 flex-1 truncate whitespace-nowrap">
                        {item.relativePath}
                      </ItemDescription>
                    )}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            !isLoading && (
              <Item size="xs" className="text-muted-foreground flex-nowrap">
                <ItemMedia variant="icon">
                  <SearchX />
                </ItemMedia>
                <ItemContent>
                  <ItemDescription>
                    {isError
                      ? t("workspace.explorer.loadFailed")
                      : t("workspace.explorer.noFiles")}
                  </ItemDescription>
                </ItemContent>
              </Item>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
