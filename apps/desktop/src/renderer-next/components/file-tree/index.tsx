import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
export const FileTreeView = ({
  paths,
  onSelect,
  onOpen,
  onRename,
}: {
  paths: string[];
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (from: string, to: string) => void;
}) => {
  const { t } = useTranslation();
  const { model } = useFileTree({
    paths,
    density: "compact",
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
