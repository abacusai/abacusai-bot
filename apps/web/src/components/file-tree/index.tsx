import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeProps } from "@pierre/trees/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
interface TreeProps {
  checkoutIdentity?: string;
  paths: string[];
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (from: string, to: string) => void;
  gitStatus?: readonly GitStatusEntry[];
  renderMenu?: (
    ...args: [
      ...Parameters<NonNullable<FileTreeProps["renderContextMenu"]>>,
      rename: () => void,
    ]
  ) => React.ReactNode;
}
export const FileTreeView = (props: TreeProps) => (
  <CheckoutTree key={props.checkoutIdentity} {...props} />
);
const CheckoutTree = ({
  paths,
  onSelect,
  onOpen,
  onRename,
  gitStatus,
  renderMenu,
}: TreeProps) => {
  const { t } = useTranslation();
  const current = useRef({ onRename, onSelect });
  useLayoutEffect(() => {
    current.current = { onRename, onSelect };
  });
  const previousPaths = useRef(paths);
  const { model } = useFileTree({
    paths,
    density: "compact",
    unsafeCSS: `
      [data-type="item"] {
        flex-basis: calc(var(--trees-row-height) - 2px);
        height: calc(var(--trees-row-height) - 2px);
        line-height: calc(var(--trees-row-height) - 2px);
        margin-block: 1px;
        border-radius: var(--row-radius, 8px);
      }
      [data-item-selected="true"]:has(+ [data-item-selected="true"]),
      [data-item-selected="true"] + [data-item-selected="true"] {
        border-radius: var(--row-radius, 8px);
      }
    `,
    gitStatus,
    dragAndDrop: {
      onDropComplete: (event) => {
        for (const from of event.draggedPaths) {
          const to = [
            event.target.directoryPath?.replace(/\/$/, ""),
            from.replace(/\/$/, "").split("/").at(-1),
          ]
            .filter(Boolean)
            .join("/");
          if (to !== from.replace(/\/$/, ""))
            current.current.onRename(from.replace(/\/$/, ""), to);
        }
      },
    },
    onSelectionChange: (selected) => {
      if (selected[0]) current.current.onSelect(selected[0]);
    },
    renaming: {
      onRename: (event) =>
        current.current.onRename(event.sourcePath, event.destinationPath),
    },
  });
  useEffect(() => {
    if (
      paths.length === previousPaths.current.length &&
      paths.every((path, i) => path === previousPaths.current[i])
    )
      return;
    const expanded = previousPaths.current.filter((path) => {
      const item = model.getItem(path);
      return item != null && "isExpanded" in item && item.isExpanded();
    });
    model.resetPaths(paths, { initialExpandedPaths: expanded });
    previousPaths.current = paths;
  }, [model, paths]);
  return (
    <FileTree
      model={model}
      style={
        {
          "--trees-theme-sidebar-bg": "var(--background)",
          "--trees-theme-sidebar-fg": "var(--foreground)",
          "--trees-theme-input-bg": "var(--card)",
          "--trees-theme-list-hover-bg": "var(--row-hover)",
          "--trees-theme-list-active-selection-bg": "var(--row-selected)",
          "--trees-theme-list-active-selection-fg": "var(--accent-foreground)",
          "--trees-theme-focus-ring": "var(--row-focus)",
          "--trees-theme-input-fg": "var(--foreground)",
          "--trees-theme-input-border": "var(--input)",
          "--trees-theme-sidebar-border": "var(--border)",
          "--trees-theme-sidebar-header-fg": "var(--muted-foreground)",
          "--trees-theme-scrollbar-thumb": "var(--border)",
          "--trees-fg-muted-override": "var(--muted-foreground)",
          "--trees-bg-muted-override": "var(--row-hover)",
          // Unset without a chosen interface font: the library's default.
          "--trees-font-family-override": "var(--ui-font-family)",
          "--trees-theme-git-added-fg": "var(--bots-done)",
          "--trees-theme-git-untracked-fg": "var(--bots-done)",
          "--trees-theme-git-modified-fg": "var(--bots-attention)",
          "--trees-theme-git-renamed-fg": "var(--accent-text, var(--primary))",
          "--trees-theme-git-deleted-fg": "var(--destructive)",
          "--trees-theme-git-ignored-fg": "var(--muted-foreground)",
          colorScheme: "inherit",
        } as React.CSSProperties
      }
      renderContextMenu={
        renderMenu
          ? (item, context) =>
              renderMenu(item, context, () => {
                context.close({ restoreFocus: false });
                model.startRenaming(item.path);
              })
          : undefined
      }
      aria-label={t("sessions.dock.files")}
      className="min-h-0 flex-1"
      onDoubleClick={() => {
        const selected = model.getSelectedPaths()[0];
        if (selected) onOpen(selected);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const selected = model.getSelectedPaths()[0];
          if (selected) onOpen(selected);
        }
      }}
    />
  );
};
