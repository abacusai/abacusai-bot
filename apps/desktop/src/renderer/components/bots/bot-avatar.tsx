import { Avatar, Style } from "@dicebear/core";
import gaze from "@dicebear/styles/gaze.json" with { type: "json" };
import { useMemo, type JSX } from "react";

const stylesByColor = new Map<string, Style<typeof gaze>>();

const gazeStyleFor = (color: string): Style<typeof gaze> => {
  const normalized = color.startsWith("#") ? color : `#${color}`;
  const cached = stylesByColor.get(normalized);
  if (cached != null) return cached;
  const style = new Style({
    ...gaze,
    colors: {
      ...gaze.colors,
      body: { ...gaze.colors.body, values: [normalized] },
    },
  } as typeof gaze);
  stylesByColor.set(normalized, style);
  return style;
};

/**
 * The outline each shape id draws. Pinned rather than left to the seed, so
 * "pebble" is the same pebble on every bot and in every picker. The order
 * of BOT_AVATAR_SHAPES is the picker's; this is only what each one means.
 */
const SHAPE_VARIANT = {
  blob: "pill",
  tablet: "arch",
  pebble: "pentagon",
  squircle: "square",
  drop: "diamond",
  cloud: "egg",
  pill: "column",
  cone: "octagon",
} as const;

const variantFor = (shape: string | null | undefined) =>
  SHAPE_VARIANT[
    (shape != null && shape in SHAPE_VARIANT
      ? shape
      : "blob") as keyof typeof SHAPE_VARIANT
  ];

export const BotAvatar = ({
  seed,
  color,
  shape,
  size = 24,
  active = false,
  className,
}: {
  seed?: string | null;
  color: string;
  shape?: string | null;
  size?: number;
  active?: boolean;
  className?: string;
}): JSX.Element => {
  const src = useMemo(
    () =>
      new Avatar(gazeStyleFor(color), {
        // The seed still picks the eyes and the tilt; the outline is the
        // shape's own, so a picked shape is the shape that shows.
        seed: `${seed ?? "bot"}:${color}`,
        shapeVariant: variantFor(shape),
        ...(active ? { animationVariant: "medium" } : {}),
      }).toDataUri(),
    [active, color, seed, shape]
  );

  return (
    <img
      src={src}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
};
