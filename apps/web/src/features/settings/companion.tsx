import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { SettingSwitch } from "#renderer/components/form-kit/controls";
import { GroupCard, SettingRow } from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useStartTour } from "../tour";

export const CompanionSettings = ({
  notifications = false,
}: {
  notifications?: boolean;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const replay = useStartTour();
  const info = useQuery(transport.orpc.system.info.queryOptions({ input: {} }));
  const status = useQuery({
    ...transport.orpc.notch.status.queryOptions({ input: {} }),
    refetchInterval: 2000,
  });
  const notch = prefs.notch;
  const companionState = status.data?.reason;
  const fail = () => showError(t("phase5.saveFailed"));
  const available = status.data != null && companionState !== "platform";
  const toggle = (
    id: string,
    title: string,
    field:
      | "enabled"
      | "idleVisible"
      | "extraDisplays"
      | "haptics"
      | "showInNotch",
    detail?: string
  ) => (
    <SettingRow id={id} title={title} detail={detail}>
      <SettingSwitch
        id={id}
        checked={notch?.[field] ?? field !== "extraDisplays"}
        onCheckedChange={(value) =>
          void update({ notch: { [field]: value } }).catch(fail)
        }
      />
    </SettingRow>
  );
  if (notifications)
    return available
      ? toggle(
          "showInNotch",
          t("settings.notifications.showInNotch.title"),
          "showInNotch",
          t("settings.notifications.showInNotch.description")
        )
      : null;
  return (
    <GroupCard>
      {available && (
        <>
          {toggle(
            "notchCompanion",
            t("settings.general.notch.title"),
            "enabled",
            t(
              info.data?.platform === "win32"
                ? "settings.general.notch.windowsDescription"
                : "settings.general.notch.description"
            )
          )}
          {(companionState === "failed" ||
            companionState === "metrics-unavailable") && (
            <p role="status">
              {t(
                companionState === "failed"
                  ? "settings.general.notch.failed"
                  : "settings.general.notch.metricsUnavailable"
              )}{" "}
              <Button
                variant="secondary"
                onClick={() =>
                  void transport.client.notch
                    .retry({})
                    .then(() => status.refetch())
                    .catch(fail)
                }
              >
                {t("settings.general.notch.retry")}
              </Button>
            </p>
          )}
          {notch?.enabled !== false && (
            <>
              {toggle(
                "notchIdle",
                t("settings.general.notch.idle"),
                "idleVisible"
              )}
              {info.data?.platform === "darwin" && (
                <>
                  {toggle(
                    "notchDisplays",
                    t("settings.general.notch.displays"),
                    "extraDisplays"
                  )}
                  {toggle(
                    "notchHaptics",
                    t("settings.general.notch.haptics"),
                    "haptics"
                  )}
                </>
              )}
              <SettingRow
                id="notchShortcut"
                title={t("settings.general.notch.shortcut")}
              >
                <kbd>
                  {status.data?.shortcut === "unavailable"
                    ? t("settings.general.notch.shortcutUnavailable")
                    : info.data?.platform === "darwin"
                      ? "⌘⇧Space"
                      : "Ctrl+Shift+Space"}
                </kbd>
              </SettingRow>
            </>
          )}
        </>
      )}
      <SettingRow id="tour" title={t("tour.replay")}>
        <Button variant="secondary" onClick={replay}>
          {t("tour.replay")}
        </Button>
      </SettingRow>
    </GroupCard>
  );
};
