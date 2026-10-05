import { useTranslation } from "react-i18next";

import {
  CHECK_IN_PRESETS,
  withMinute,
  type CheckInDraft,
} from "#next/lib/bots/check-in";
import { weekdayName } from "#next/lib/bots/schedule";
import { AppLink } from "#next/lib/navigation/app-link";
import { Field, FieldLabel } from "#next/ui/field";
import { Input } from "#next/ui/input";
import { Switch } from "#next/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "#next/ui/toggle-group";
export const CheckInFields = ({
  value,
  onChange,
  routineId,
  onBlur,
}: {
  value: CheckInDraft;
  onChange(value: CheckInDraft): void;
  routineId?: string;
  onBlur?(): void;
}) => {
  const { t, i18n } = useTranslation();
  return (
    <Field onBlur={onBlur}>
      <FieldLabel id="check-in-label">{t("bots.checkIn.label")}</FieldLabel>
      <ToggleGroup
        aria-labelledby="check-in-label"
        value={value.preset === "custom" ? [] : [value.preset]}
        onValueChange={(items) => {
          if (items[0])
            onChange({ ...value, preset: items[0] as CheckInDraft["preset"] });
        }}
        className="bg-muted flex-wrap rounded-xl p-1"
      >
        {CHECK_IN_PRESETS.map((preset) => (
          <ToggleGroupItem key={preset} value={preset} className="text-xs">
            {t(`bots.checkIn.${preset}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {value.preset === "custom" && (
        <p className="text-muted-foreground text-xs">
          {t("bots.checkIn.custom", { schedule: value.custom })}{" "}
          {routineId && (
            <AppLink to="/routines/$routineId" params={{ routineId }}>
              {t("bots.checkIn.editInRoutines")}
            </AppLink>
          )}
        </p>
      )}
      {["daily", "weekdays", "weekly"].includes(value.preset) && (
        <Field>
          <FieldLabel htmlFor="check-in-time">
            {t("bots.checkIn.time")}
          </FieldLabel>
          <Input
            id="check-in-time"
            type="time"
            value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
            className="w-32"
          />
        </Field>
      )}
      {value.preset === "hourly" && (
        <Field>
          <FieldLabel htmlFor="check-in-minute">
            {t("bots.checkIn.minute")}
          </FieldLabel>
          <Input
            id="check-in-minute"
            type="number"
            min={0}
            max={59}
            value={Number(value.time.split(":")[1])}
            onChange={(e) =>
              onChange({
                ...value,
                time: withMinute(value.time, Number(e.target.value)),
              })
            }
            className="w-24"
          />
        </Field>
      )}
      {value.preset === "weekly" && (
        <ToggleGroup
          aria-label={t("bots.checkIn.day")}
          value={[String(value.weekday)]}
          onValueChange={(items) => {
            if (items[0])
              onChange({
                ...value,
                weekday: Number(items[0]) as CheckInDraft["weekday"],
              });
          }}
        >
          {([1, 2, 3, 4, 5, 6, 0] as const).map((day) => (
            <ToggleGroupItem
              key={day}
              value={String(day)}
              aria-label={weekdayName(day, i18n.language)}
            >
              {weekdayName(day, i18n.language).slice(0, 1)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {routineId && (
        <Field orientation="horizontal">
          <Switch
            id="check-in-paused"
            checked={!value.enabled}
            onCheckedChange={(checked) =>
              onChange({ ...value, enabled: !checked })
            }
          />
          <FieldLabel htmlFor="check-in-paused">
            {t("bots.checkIn.paused")}
          </FieldLabel>
        </Field>
      )}
    </Field>
  );
};
