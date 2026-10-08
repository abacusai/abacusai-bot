import type { ComponentProps } from "react";

import { NativeSelect, NativeSelectOption } from "#renderer/ui/native-select";
import { Switch } from "#renderer/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "#renderer/ui/toggle-group";
export const Choice = ({
  id,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
}) => (
  <NativeSelect
    className="max-w-full truncate"
    aria-labelledby={`${id}-label`}
    aria-describedby={`${id}-detail`}
    value={value}
    disabled={disabled}
    onChange={(e) => onChange(e.target.value)}
  >
    {options.map((o) => (
      <NativeSelectOption key={o.value} value={o.value}>
        {o.label}
      </NativeSelectOption>
    ))}
  </NativeSelect>
);
export const Segments = ({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: readonly { value: string; label: string }[];
  onChange(value: string): void;
}) => (
  <ToggleGroup
    aria-label={label}
    value={[value]}
    onValueChange={(v) => {
      if (v[0] != null) onChange(String(v[0]));
    }}
    variant="outline"
    className="max-w-full flex-wrap gap-1"
  >
    {values.map((v) => (
      <ToggleGroupItem
        key={v.value}
        value={v.value}
        className="min-w-0 shrink truncate"
      >
        {v.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);
export const SettingSwitch = ({
  id,
  ...props
}: { id: string } & ComponentProps<typeof Switch>) => (
  <Switch
    aria-labelledby={`${id}-label`}
    aria-describedby={`${id}-detail`}
    {...props}
  />
);
