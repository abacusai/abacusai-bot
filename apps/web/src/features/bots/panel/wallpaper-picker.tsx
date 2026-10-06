/**
 * The chat wallpaper picker (03-bots §24): a radio group of live thumbnails,
 * each the real wallpaper layer (chat.css) in a small frame, "None" first
 * and the default. The choice is stored on the bot row.
 */
import {
  BOT_WALLPAPER_IDS,
  type BotWallpaperId,
} from "@abacus-ai/contract/bots";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";

export const WallpaperPicker = ({
  value,
  onChange,
  disabled = false,
}: {
  value: BotWallpaperId | null | undefined;
  onChange(next: BotWallpaperId | null): void;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  const labelId = useId();
  const current: BotWallpaperId = value ?? "none";
  return (
    <section className="flex min-w-0 flex-col gap-2" data-slot="bot-wallpaper">
      <h3 id={labelId} className="text-muted-foreground text-xs">
        {t("bots.wallpaper.title")}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-3 gap-2"
      >
        {BOT_WALLPAPER_IDS.map((id) => {
          const checked = id === current;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t(`bots.wallpaper.${id}`)}
              data-wallpaper-option={id}
              disabled={disabled}
              onClick={() => onChange(id === "none" ? null : id)}
              className={cn(
                "flex min-w-0 flex-col items-center gap-1 rounded-lg p-1 text-xs outline-none",
                "focus-visible:ring-ring/50 focus-visible:ring-2 disabled:opacity-50"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "bg-background relative block h-11 w-full overflow-hidden rounded-md border",
                  checked
                    ? "border-[var(--bot-accent,var(--primary))] ring-2 ring-[var(--bot-accent,var(--primary))]/40"
                    : "border-border"
                )}
              >
                <span data-slot="chat-wallpaper" data-wallpaper={id} />
              </span>
              <span className="max-w-full truncate">
                {t(`bots.wallpaper.${id}`)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
