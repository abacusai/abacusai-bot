import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { NotificationSettings } from "#shared/contracts";

import { settingsQueryKeys } from "../../lib/settings-query-keys";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Switch,
} from "../ui";

/**
 * Both switches ship on. These only fire while the window is unfocused, which
 * is exactly when a finished turn or a blocked permission would otherwise go
 * unnoticed — an agent that waits silently for approval looks like one that
 * hung.
 */
export const NotificationSettingsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = settingsQueryKeys.notifications.preferences;
  const settingsQuery = useQuery({
    queryKey,
    queryFn: async () =>
      (await window.api?.agent?.getNotificationSettings?.()) ?? null,
  });

  const updateMutation = useMutation({
    mutationFn: async (next: NotificationSettings) =>
      (await window.api?.agent?.setNotificationSettings?.(next)) ?? next,
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<NotificationSettings | null>(
        queryKey
      );
      queryClient.setQueryData(queryKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? null);
    },
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  const settings = settingsQuery.data ?? null;
  const busy = updateMutation.isPending;

  const update = async (
    patch: Partial<NotificationSettings>
  ): Promise<void> => {
    if (settings == null) return;
    updateMutation.mutate({ ...settings, ...patch });
  };

  const settingsContent = (
    <FieldGroup className="border-border gap-0 rounded-lg border">
      <Field
        orientation="horizontal"
        className="px-3 py-2.5"
        data-id="notification-settings-enabled"
      >
        <FieldContent>
          <FieldLabel htmlFor="notification-settings-enabled-toggle">
            {t("notificationSettings.enableTitle")}
          </FieldLabel>
          <FieldDescription>
            {t("notificationSettings.enableSubtitle")}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="notification-settings-enabled-toggle"
          checked={settings?.enabled ?? true}
          disabled={busy || settings == null}
          aria-label={t("notificationSettings.enableTitle")}
          data-id="notification-settings-enabled-toggle"
          onCheckedChange={(value) => void update({ enabled: value })}
          onClick={(event) => event.stopPropagation()}
        />
      </Field>
      <Field
        orientation="horizontal"
        className="border-border border-t px-3 py-2.5"
        data-id="notification-settings-sound"
        data-disabled={settings?.enabled === false ? "" : undefined}
      >
        <FieldContent>
          <FieldLabel htmlFor="notification-settings-sound-toggle">
            {t("notificationSettings.soundTitle")}
          </FieldLabel>
          <FieldDescription>
            {t("notificationSettings.soundSubtitle")}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="notification-settings-sound-toggle"
          checked={settings?.sound ?? true}
          disabled={busy || settings == null || settings.enabled === false}
          aria-label={t("notificationSettings.soundTitle")}
          data-id="notification-settings-sound-toggle"
          onCheckedChange={(value) => void update({ sound: value })}
          onClick={(event) => event.stopPropagation()}
        />
      </Field>
    </FieldGroup>
  );

  return (
    <FocusedPage data-id="notification-settings-page">
      <FocusedPageBody>
        <FocusedPageLead description={t("notificationSettings.subtitle")} />
        {settingsContent}
      </FocusedPageBody>
    </FocusedPage>
  );
};
