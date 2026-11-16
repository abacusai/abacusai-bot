/**
 * The folder a routine works in, picked the same way wherever a routine is
 * set up: the user's folders, the app's own workspace by its name, and a
 * last entry that opens the system folder picker and adds what it returns.
 */
import type { WorkspaceRow } from "@abacus-ai/contract/contract/rows";
import { useLiveQuery } from "@tanstack/react-db";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { platformSystem } from "#renderer/lib/platform-system";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { NativeSelect, NativeSelectOption } from "#renderer/ui/native-select";

/** The option value that opens the folder picker instead of selecting. */
const CHOOSE_FOLDER = "choose";

/**
 * The folders a routine may run in. A code routine needs a folder the user
 * added: the app's own workspace holds chats, not a project.
 */
export const useRoutineFolders = (codeOnly: boolean): WorkspaceRow[] => {
  const c = useCollections();
  return (useLiveQuery(c.workspaces).data ?? []).filter(
    (w) =>
      w.status !== "deleted" &&
      (w.kind == null || (!codeOnly && w.kind === "auto"))
  );
};

export const RoutineFolderSelect = ({
  id,
  value,
  onChange,
  emptyLabel,
  codeOnly = false,
}: {
  id: string;
  value: string | null;
  onChange: (workspaceId: string | null) => void;
  /** The "no folder" entry; left out when there is none to offer. */
  emptyLabel: string | null;
  codeOnly?: boolean;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const folders = useRoutineFolders(codeOnly);

  const choose = () =>
    void platformSystem(transport.client)
      .dialog.openFolder({})
      .then(async (path) => {
        if (!path) return;
        const added = await transport.client.workspaces.add({ path });
        if (added.workspaceId == null) throw new Error("folder not added");
        onChange(added.workspaceId);
      })
      .catch(() => showError(t("phase5.folderFailed")));

  return (
    <NativeSelect
      id={id}
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === CHOOSE_FOLDER) choose();
        else onChange(e.target.value || null);
      }}
    >
      {emptyLabel != null && (
        <NativeSelectOption value="">{emptyLabel}</NativeSelectOption>
      )}
      {folders.map((w) => (
        <NativeSelectOption key={w.id} value={w.id}>
          {w.kind === "auto" ? t("sessions.tray.default") : (w.label ?? w.path)}
        </NativeSelectOption>
      ))}
      <NativeSelectOption value={CHOOSE_FOLDER}>
        {t("phase5.chooseFolder")}
      </NativeSelectOption>
    </NativeSelect>
  );
};
