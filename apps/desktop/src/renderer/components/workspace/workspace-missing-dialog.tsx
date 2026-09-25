import { FolderMinus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useWorkspaceWorkspaceActions } from "../../providers/workspace-state-provider";
import { Dialog } from "../common/dialog";

interface WorkspaceMissingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceLabel: string;
  workspacePath: string;
}

/**
 * The workspace's folder is gone. Offers the only two exits: repoint it (keeps
 * the workspace id, and with it every chat), or drop the workspace record.
 */
export const WorkspaceMissingDialog = ({
  isOpen,
  onClose,
  workspaceId,
  workspaceLabel,
  workspacePath,
}: WorkspaceMissingDialogProps) => {
  const { t } = useTranslation();
  const { relocateWorkspaceMutation, removeWorkspaceMutation } =
    useWorkspaceWorkspaceActions(workspaceId);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const dismiss = (): void => {
    setIsConfirmingDelete(false);
    onClose();
  };

  if (isConfirmingDelete) {
    return (
      <Dialog
        isOpen={isOpen}
        onClose={dismiss}
        icon={Trash2}
        iconColor="text-destructive"
        title={t("workspace.workspaceMissing.deleteTitle", {
          name: workspaceLabel,
        })}
        description={t("workspace.workspaceMissing.deleteBody")}
        data-id="workspace-missing-delete-dialog"
        buttons={[
          {
            label: t("workspace.cancel"),
            variant: "secondary",
            onClick: () => setIsConfirmingDelete(false),
          },
          {
            label: t("workspace.confirmDelete"),
            variant: "destructive",
            onClick: async () => {
              await removeWorkspaceMutation.mutateAsync(workspaceId);
              toast.success(t("workspace.workspaceDeleted"), {
                id: "workspace-delete",
              });
              return true;
            },
          },
        ]}
      />
    );
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={dismiss}
      showCloseButton
      icon={FolderMinus}
      iconColor="text-destructive"
      title={t("workspace.workspaceMissing.title")}
      description={t("workspace.workspaceMissing.description", {
        path: workspacePath,
      })}
      data-id="workspace-missing-dialog"
      buttons={[
        {
          label: t("workspace.workspaceMissing.delete"),
          variant: "secondary",
          onClick: () => setIsConfirmingDelete(true),
        },
        {
          label: t("workspace.workspaceMissing.relocate"),
          variant: "default",
          onClick: async () => {
            const selected = await window.api.openFolderDialog();
            // Picker dismissed: stay open so the user still has both exits.
            if (selected == null) return false;
            await relocateWorkspaceMutation.mutateAsync({
              workspaceId,
              newPath: selected,
            });
            toast.success(t("workspace.workspaceMissing.relocated"), {
              id: "workspace-relocate",
            });
            return true;
          },
        },
      ]}
    />
  );
};
