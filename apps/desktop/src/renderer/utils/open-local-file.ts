import { toast } from "sonner";

import i18n from "../i18n";

/**
 * Ask the OS to open a local file. Main may refuse the path or reveal it in
 * the file manager instead (see local-open-guard); every outcome the user did
 * not ask for gets a toast so a silent click does not read as a broken app.
 */
export const openLocalFile = async (absPath: string): Promise<void> => {
  const refusals = {
    invalid: "openFile.refusedInvalid",
    missing: "openFile.refusedMissing",
    outside: "openFile.refusedOutside",
  } as const;

  try {
    const result = await window.api.openFilePath(absPath);
    if (result.outcome === "revealed") {
      toast.info(i18n.t("openFile.revealed"));
    } else if (result.outcome === "refused") {
      toast.error(i18n.t(refusals[result.reason]));
    }
  } catch {
    toast.error(i18n.t("openFile.failed"));
  }
};
