/**
 * The rail's duotone icons (spec 01 §7.2), copied verbatim from the canvas
 * `Rail` board: a fill path at 22 % opacity under a 1.6 stroke. One hidden
 * `<svg>` of `<symbol>`s, referenced by `<use>`. Lucide stays the icon set for
 * everything else.
 */
import type { ComponentProps } from "react";

export type AppIconName =
  | "bots"
  | "sessions"
  | "routines"
  | "artifacts"
  | "library"
  | "settings";

interface Glyph {
  fill?: string;
  fillCircle?: { cx: number; cy: number; r: number };
  paths: string[];
  circles?: Array<{ cx: number; cy: number; r: number }>;
}

const APP_ICONS: Record<AppIconName, Glyph> = {
  bots: {
    fill: "M6 8h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z",
    paths: [
      "M6 8h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z M12 8V5 M12 5a1.5 1.5 0 1 0 0-3 M9 14h.01 M15 14h.01 M9.5 17.5c1.5 1 3.5 1 5 0",
    ],
  },
  sessions: {
    fill: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    paths: [
      "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 9h18 M7.5 13.5 9.5 15.5 7.5 17.5 M12 17.5h4",
    ],
  },
  routines: {
    fill: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z",
    paths: ["M20 12a8 8 0 1 1-2.3-5.7 M20 4v3.5h-3.5 M12 8.5V12l2.5 2"],
  },
  artifacts: {
    fill: "M6 8h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
    paths: [
      "M6 8h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z M7 5h10 M9 2.5h6 M10 12.5v5l4-2.5z",
    ],
  },
  // The canvas "Connectors" glyph (F11).
  library: {
    fill: "M4 9a3 3 0 0 1 3-3h4v12H7a3 3 0 0 1-3-3z",
    paths: [
      "M4 9a3 3 0 0 1 3-3h4v12H7a3 3 0 0 1-3-3z",
      "M13 9h4a3 3 0 0 1 3 3 3 3 0 0 1-3 3h-4",
      "M11 12h2",
    ],
  },
  settings: {
    fillCircle: { cx: 12, cy: 12, r: 7 },
    paths: [
      "M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6",
    ],
    circles: [{ cx: 12, cy: 12, r: 3.2 }],
  },
};

const NAMES = Object.keys(APP_ICONS) as AppIconName[];

/** Mounted once, in the root layout. */
export const AppIconSprite = () => (
  <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}>
    {NAMES.map((name) => {
      const glyph = APP_ICONS[name];
      return (
        <symbol key={name} id={`icon-${name}`} viewBox="0 0 24 24">
          {glyph.fill != null && (
            <path
              d={glyph.fill}
              fill="currentColor"
              stroke="none"
              opacity="0.22"
            />
          )}
          {glyph.fillCircle != null && (
            <circle
              {...glyph.fillCircle}
              fill="currentColor"
              stroke="none"
              opacity="0.22"
            />
          )}
          {glyph.paths.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {glyph.circles?.map((circle) => (
            <circle
              key={`${circle.cx}-${circle.r}`}
              {...circle}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          ))}
        </symbol>
      );
    })}
  </svg>
);

export const AppIcon = ({
  name,
  size = 20,
  ...props
}: { name: AppIconName; size?: number } & ComponentProps<"svg">) => (
  <svg aria-hidden="true" width={size} height={size} {...props}>
    <use href={`#icon-${name}`} />
  </svg>
);
