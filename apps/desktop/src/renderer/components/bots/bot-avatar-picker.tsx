import { Pencil } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "#shared/bots";

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { BotAvatar } from "./bot-avatar";

export type BotAvatarLook = { shape: string; color: string };

/**
 * A bot's face with a pencil on it: one component for every place a bot's look
 * is settled. A popover, not swatches on the form: the look is a one-tap choice
 * for whoever wants one and a generated default for everyone else.
 */
export const BotAvatarPicker = ({
  seed,
  look,
  onChange,
  size = 48,
  active = true,
  dataId = "bot-avatar",
}: {
  /** What the face is drawn from; the name, usually. */
  seed: string;
  look: BotAvatarLook;
  onChange: (look: BotAvatarLook) => void;
  size?: number;
  active?: boolean;
  /** Prefix for the picker's data-ids: `<dataId>-picker`, `<dataId>-colors`. */
  dataId?: string;
}): JSX.Element => {
  const { t } = useTranslation();
  return (
    <Popover>
      <div className="group/avatar relative" data-id={dataId}>
        <BotAvatar
          seed={seed}
          color={look.color}
          shape={look.shape}
          size={size}
          active={active}
        />
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={t("bots.changeAvatar")}
              title={t("bots.changeAvatar")}
              data-id={`${dataId}-edit`}
              className="bg-background/90 text-foreground absolute right-0 bottom-0 flex size-5 items-center justify-center rounded-full opacity-0 shadow-sm transition-opacity group-hover/avatar:opacity-100 focus-visible:opacity-100"
            />
          }
        >
          <Pencil className="size-3" />
        </PopoverTrigger>
      </div>
      <PopoverContent side="right" align="center" className="w-52 gap-2">
        <PopoverTitle>{t("bots.avatarLabel")}</PopoverTitle>
        <div className="grid grid-cols-4 gap-1" data-id={`${dataId}-picker`}>
          {BOT_AVATAR_SHAPES.map((variant) => (
            <button
              type="button"
              key={variant}
              aria-label={`${t("bots.avatarLabel")} ${variant}`}
              aria-pressed={look.shape === variant}
              onClick={() => onChange({ ...look, shape: variant })}
              className={`flex size-10 items-center justify-center rounded-md ${
                look.shape === variant
                  ? "bg-primary/15 ring-primary ring-1"
                  : "hover:bg-muted"
              }`}
            >
              <BotAvatar
                seed={seed}
                color={look.color}
                shape={variant}
                size={32}
              />
            </button>
          ))}
        </div>
        <span className="text-muted-foreground text-xs">
          {t("bots.avatarColor")}
        </span>
        <div className="flex flex-wrap gap-1.5" data-id={`${dataId}-colors`}>
          {BOT_AVATAR_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              aria-label={`${t("bots.avatarColor")} ${color}`}
              aria-pressed={look.color === color}
              onClick={() => onChange({ ...look, color })}
              className={`size-5 rounded-full ${
                look.color === color
                  ? "ring-foreground ring-offset-background ring-2 ring-offset-2"
                  : ""
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
