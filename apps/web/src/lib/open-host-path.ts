/**
 * A click that opens a file on the host from a chat. Main decides what may
 * open (`system.openPath`); this says what happened when it was anything but
 * an open, since a click that does nothing visible reads as a broken app.
 */
import type { AppClient } from "#renderer/data/transport/types";
import { i18n } from "#renderer/lib/i18n";
import { platformSystem } from "#renderer/lib/platform-system";
import { showError, showInfo } from "#renderer/lib/toast";

export const openHostPath = async (
  client: AppClient,
  path: string
): Promise<void> => {
  let result: Awaited<
    ReturnType<ReturnType<typeof platformSystem>["openPath"]>
  >;
  try {
    result = await platformSystem(client).openPath({ path });
  } catch {
    showError(i18n.t("openFile.failed"));
    return;
  }
  if (result.outcome === "opened") return;
  if (result.outcome === "revealed")
    showInfo(
      result.reason === "outside"
        ? i18n.t("openFile.revealedOutside")
        : i18n.t("openFile.revealed")
    );
  else if (result.reason === "missing")
    showError(i18n.t("openFile.refusedMissing"));
  else if (result.reason === "invalid")
    showError(i18n.t("openFile.refusedInvalid"));
  else showError(i18n.t("openFile.refusedOutside"));
};
