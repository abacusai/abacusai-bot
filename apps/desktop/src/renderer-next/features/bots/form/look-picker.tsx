import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#next/components/bot-avatar";
import {
  AVATAR_SHAPES,
  SETUP_SHAPES,
  AVATAR_PALETTE,
  AVATAR_ACCESSORIES,
  type Look,
} from "#next/lib/bots/avatar";
import { Button } from "#next/ui/button";
import { ToggleGroup, ToggleGroupItem } from "#next/ui/toggle-group";
export const LookPicker = ({
  value,
  onChange,
}: {
  value: Look;
  onChange(value: Look): void;
}) => {
  const { t } = useTranslation();
  const [more, setMore] = useState(false);
  return (
    <div className="flex flex-col items-center gap-4">
      <ToggleGroup
        value={[value.shape]}
        onValueChange={(values) => {
          if (values[0])
            onChange({ ...value, shape: values[0] as Look["shape"] });
        }}
        aria-label={t("bots.form.shape")}
        className="grid grid-cols-4"
      >
        {(more ? AVATAR_SHAPES : SETUP_SHAPES).map((shape) => (
          <ToggleGroupItem
            key={shape}
            value={shape}
            aria-label={t(`bots.avatar.shapes.${shape}`)}
            className="size-9 p-1"
          >
            <BotAvatar size={26} look={{ ...value, shape }} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Button variant="ghost" size="sm" onClick={() => setMore(!more)}>
        {t("bots.form.moreShapes")}
      </Button>
      <ToggleGroup
        value={[value.color]}
        onValueChange={(values) => {
          if (values[0]) onChange({ ...value, color: values[0] });
        }}
        aria-label={t("bots.form.colour")}
        className="flex-wrap justify-center"
      >
        {AVATAR_PALETTE.map(({ id: colorId, hex: color }) => (
          <ToggleGroupItem
            key={color}
            value={color}
            aria-label={t(`bots.avatar.colors.${colorId}`)}
            className="bot-accent-control data-pressed:ring-foreground size-5 rounded-full p-0 data-pressed:ring-2 data-pressed:ring-offset-2"
            style={{ backgroundColor: color }}
          />
        ))}
      </ToggleGroup>
      <ToggleGroup
        value={[value.accessory]}
        onValueChange={(values) => {
          if (values[0])
            onChange({ ...value, accessory: values[0] as Look["accessory"] });
        }}
        aria-label={t("bots.form.accessory")}
        className="flex-wrap justify-center"
      >
        {AVATAR_ACCESSORIES.map((accessory) => (
          <ToggleGroupItem
            key={accessory}
            value={accessory}
            className="h-7 rounded-full text-xs"
          >
            {t(`bots.avatar.accessories.${accessory}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
};
