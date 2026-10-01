import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeProps } from "@pierre/trees/react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
export const FileTreeView = ({
  paths,
  onSelect,
  onOpen,
  onRename,
  gitStatus,
  renderMenu,
}: {
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
}) => {
  const { t } = useTranslation();
  const { model } = useFileTree({
    paths,
    density: "compact",
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
            onRename(from.replace(/\/$/, ""), to);
        }
      },
    },
    onSelectionChange: (selected) => {
      if (selected[0]) onSelect(selected[0]);
    },
    renaming: {
      onRename: (event) => onRename(event.sourcePath, event.destinationPath),
    },
  });
  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);
  return (
    <FileTree
      model={model}
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
