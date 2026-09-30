/**
 * ConnectorMark (spec 03 §15, canvas ConnectorIcon): the 26 connector,
 * messaging and provider marks as tiles. Paths and tile colours are the
 * canvas's (24×24 glyph box); tile radius round(size × 0.28), glyph
 * round(size × 0.68). Decorative unless given a `label`. Replaces
 * `@lobehub/icons-static-svg` and the old `connector-logo.tsx` here.
 */
import { cn } from "#next/lib/cn";

export const CONNECTOR_MARK_IDS = [
  "gmail",
  "calendar",
  "drive",
  "slack",
  "notion",
  "github",
  "linear",
  "jira",
  "stripe",
  "zendesk",
  "hubspot",
  "postgres",
  "snowflake",
  "vercel",
  "aws",
  "whatsapp",
  "telegram",
  "discord",
  "abacus",
  "openrouter",
  "chrome",
  "docker",
  "mcp",
  "figma",
  "sheets",
  "outlook",
] as const;
export type ConnectorMarkId = (typeof CONNECTOR_MARK_IDS)[number];

interface Part {
  d: string;
  fill?: string;
  stroke?: string;
  w?: number;
}

const MARKS: Record<ConnectorMarkId, { bg: string; parts: Part[] }> = {
  gmail: {
    bg: "#ffffff",
    parts: [
      { d: "M3 7v11h3.5V11l5.5 4 5.5-4v7H21V7l-9 6.5z", fill: "#EA4335" },
      { d: "M3 7l3.5 2.5V18H3z", fill: "#4285F4" },
      { d: "M17.5 9.5 21 7v11h-3.5z", fill: "#34A853" },
      { d: "M3 7l1-1.5L12 11l8-5.5L21 7l-9 6.5z", fill: "#FBBC04" },
    ],
  },
  calendar: {
    bg: "#ffffff",
    parts: [
      {
        d: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
        fill: "#ffffff",
        stroke: "#4285F4",
        w: 2,
      },
      { d: "M4 8h16", stroke: "#4285F4", w: 2 },
      {
        d: "M9.5 11.5h2.2c1.2 0 1.8.6 1.8 1.4 0 .7-.5 1.1-1 1.2.7.1 1.3.6 1.3 1.4 0 1-.8 1.5-2 1.5H9.5",
        stroke: "#1a73e8",
        w: 1.4,
      },
      { d: "M16 17.5 16 11.5 14.8 12.5", stroke: "#1a73e8", w: 1.4 },
    ],
  },
  drive: {
    bg: "#ffffff",
    parts: [
      { d: "M8.5 4h7l5.5 9.5h-7z", fill: "#FBBC04" },
      { d: "M8.5 4 3 13.5l3.5 6L12 10z", fill: "#34A853" },
      { d: "M3 13.5h11l3.5 6H6.5z", fill: "#4285F4" },
    ],
  },
  sheets: {
    bg: "#ffffff",
    parts: [
      {
        d: "M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
        fill: "#34A853",
      },
      { d: "M8 11h8v7H8z M8 14.5h8 M12 11v7", stroke: "#ffffff", w: 1.4 },
    ],
  },
  slack: {
    bg: "#ffffff",
    parts: [
      {
        d: "M9 3a2 2 0 1 0 0 4h2V5a2 2 0 0 0-2-2z M9 8.5H4a2 2 0 1 0 0 4h5a2 2 0 1 0 0-4z",
        fill: "#36C5F0",
      },
      {
        d: "M21 9a2 2 0 1 0-4 0v2h2a2 2 0 0 0 2-2z M15.5 9V4a2 2 0 1 0-4 0v5a2 2 0 1 0 4 0z",
        fill: "#2EB67D",
      },
      {
        d: "M15 21a2 2 0 1 0 0-4h-2v2a2 2 0 0 0 2 2z M15 15.5h5a2 2 0 1 0 0-4h-5a2 2 0 1 0 0 4z",
        fill: "#ECB22E",
      },
      {
        d: "M3 15a2 2 0 1 0 4 0v-2H5a2 2 0 0 0-2 2z M8.5 15v5a2 2 0 1 0 4 0v-5a2 2 0 1 0-4 0z",
        fill: "#E01E5A",
      },
    ],
  },
  notion: {
    bg: "#ffffff",
    parts: [
      {
        d: "M5 4.5 15.5 3.7c1.2-.1 1.6 0 2.3.6l3 2.1c.5.4.7.5.7 1v12.4c0 .9-.3 1.4-1.5 1.5L8.3 22c-.9.1-1.3-.1-1.8-.7L4 18.4c-.5-.7-.7-1.2-.7-1.8V6c0-.8.3-1.4 1.7-1.5z",
        fill: "#ffffff",
        stroke: "#111111",
        w: 1.5,
      },
      {
        d: "M8.5 8.5v10l2-.2v-6.6l5 7.1 2.2-.2V8.2l-2 .2v6.4L10.6 8.3z",
        fill: "#111111",
      },
    ],
  },
  github: {
    bg: "#24292f",
    parts: [
      {
        d: "M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.8.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1-4.4-4.7 0-1 .4-1.9 1-2.5-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.6.6.6 1 1.5 1 2.5 0 3.7-2.3 4.5-4.4 4.7.3.3.6.9.6 1.8v2.6c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z",
        fill: "#ffffff",
      },
    ],
  },
  linear: {
    bg: "#ffffff",
    parts: [
      {
        d: "M3.2 13.6 10.4 20.8A9 9 0 0 1 3.2 13.6z M3 10.9 13.1 21a9 9 0 0 0 2.4-.7L3.7 8.5a9 9 0 0 0-.7 2.4z M4.5 6.5 17.5 19.5a9 9 0 0 0 1.5-1.2L5.7 5a9 9 0 0 0-1.2 1.5z M7 4l13 13A9 9 0 1 0 7 4z",
        fill: "#5E6AD2",
      },
    ],
  },
  jira: {
    bg: "#ffffff",
    parts: [
      { d: "M12 2 6 8l6 6 6-6z", fill: "#2684FF" },
      { d: "M6 8 2 12l6 6 4-4z", fill: "#0052CC" },
      { d: "M18 8l4 4-6 6-4-4z", fill: "#0052CC" },
      { d: "M8 18l4 4 4-4-4-4z", fill: "#2684FF" },
    ],
  },
  stripe: {
    bg: "#635BFF",
    parts: [
      {
        d: "M13.3 9.6c0-.7.6-1 1.6-1 1.4 0 3.2.4 4.6 1.2V5.6c-1.5-.6-3-.9-4.6-.9-3.8 0-6.3 2-6.3 5.3 0 5.1 7 4.3 7 6.5 0 .8-.7 1.1-1.7 1.1-1.5 0-3.5-.6-5.1-1.5v4.3c1.7.7 3.4 1 5.1 1 3.9 0 6.6-1.9 6.6-5.3-.1-5.5-7.2-4.5-7.2-6.5z",
        fill: "#ffffff",
      },
    ],
  },
  zendesk: {
    bg: "#03363D",
    parts: [
      {
        d: "M11 7v13H3z M3 7a4 4 0 0 1 8 0z M13 17V4h8z M21 17a4 4 0 0 1-8 0z",
        fill: "#ffffff",
      },
    ],
  },
  hubspot: {
    bg: "#ffffff",
    parts: [
      {
        d: "M16.5 9.2V6.7a1.8 1.8 0 1 0-1.4 0v2.5a5 5 0 0 0-2.4 1L6.9 6a2 2 0 1 0-1 1.2l5.6 4.1a5 5 0 1 0 5 -2.1z M15.8 17.5a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4z",
        fill: "#FF7A59",
      },
    ],
  },
  postgres: {
    bg: "#336791",
    parts: [
      {
        d: "M12 4c-4 0-6 3-6 7 0 3 1 6 3 8 1 1 2 1 3 0 1-1 1-3 1-3s2 0 3-2c1-2 1-5 0-7s-2-3-4-3z",
        fill: "#ffffff",
      },
      { d: "M9.5 9.5h.01 M14 9.5h.01", stroke: "#336791", w: 2 },
    ],
  },
  snowflake: {
    bg: "#29B5E8",
    parts: [
      {
        d: "M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9 M12 3l-2 2 M12 3l2 2 M12 21l-2-2 M12 21l2-2",
        stroke: "#ffffff",
        w: 2,
      },
    ],
  },
  vercel: { bg: "#000000", parts: [{ d: "M12 4 21 20H3z", fill: "#ffffff" }] },
  aws: {
    bg: "#232F3E",
    parts: [
      { d: "M4 15c2.5 2 5.5 3 8.5 3s5.5-1 7.5-2.5", stroke: "#FF9900", w: 2 },
      { d: "M18 14l2 1.5-2 1.5", stroke: "#FF9900", w: 2 },
      { d: "M7 6h3l1.5 5L13 6h3", stroke: "#ffffff", w: 1.8 },
    ],
  },
  whatsapp: {
    bg: "#25D366",
    parts: [
      {
        d: "M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5z",
        fill: "#ffffff",
      },
      {
        d: "M9 8.5c.2-.5.5-.5.8-.5h.5c.2 0 .4.1.5.4l.6 1.5c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4.5.9 1.4 1.8 2.4 2.3.2.1.3.1.4 0l.7-.7c.2-.2.4-.2.6-.1l1.5.7c.2.1.3.3.3.5 0 .8-.4 1.5-1.2 1.8-.7.2-1.5.1-2.4-.3a8 8 0 0 1-3.7-3.6c-.4-.9-.5-1.7-.4-2.5.1-.4.3-.8.6-1z",
        fill: "#25D366",
      },
    ],
  },
  telegram: {
    bg: "#2AABEE",
    parts: [
      {
        d: "M4 11.5 19 5.5c.7-.3 1.3.2 1.1 1L17.5 18c-.2.8-.7 1-1.4.6l-3.8-2.8-1.8 1.8c-.2.2-.4.3-.8.3l.3-3.8 6.9-6.2c.3-.3-.1-.4-.5-.2L8 12.9l-3.7-1.2c-.8-.2-.8-.8.1-1.2z",
        fill: "#ffffff",
      },
    ],
  },
  discord: {
    bg: "#5865F2",
    parts: [
      {
        d: "M18.9 6.2A15 15 0 0 0 15.2 5l-.5 1a14 14 0 0 0-5.4 0l-.5-1a15 15 0 0 0-3.7 1.2C2.7 9.7 2.1 13.1 2.4 16.5a15 15 0 0 0 4.6 2.3l1-1.6a10 10 0 0 1-1.6-.8l.4-.3a10.7 10.7 0 0 0 10.4 0l.4.3-1.6.8 1 1.6a15 15 0 0 0 4.6-2.3c.4-3.9-.7-7.3-2.7-10.3zM9 14.5c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8zm6 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8z",
        fill: "#ffffff",
      },
    ],
  },
  abacus: {
    bg: "#111111",
    parts: [
      { d: "M5 6h14 M5 12h14 M5 18h14", stroke: "#3f3f46", w: 1.5 },
      {
        d: "M8 6h.01 M12 6h.01 M7 12h.01 M11 12h.01 M15 12h.01 M9 18h.01 M16 18h.01",
        stroke: "#e879f9",
        w: 3.2,
      },
    ],
  },
  openrouter: {
    bg: "#ffffff",
    parts: [{ d: "M3 12h4l3-4 4 8 3-4h4", stroke: "#6467f2", w: 2 }],
  },
  chrome: {
    bg: "#ffffff",
    parts: [
      {
        d: "M12 3a9 9 0 0 1 7.8 4.5H12a4.5 4.5 0 0 0-4.2 2.9L4.3 6A9 9 0 0 1 12 3z",
        fill: "#EA4335",
      },
      {
        d: "M4.3 6l3.5 4.4a4.5 4.5 0 0 0 2.6 5.9L8.1 20.2A9 9 0 0 1 4.3 6z",
        fill: "#34A853",
      },
      {
        d: "M8.1 20.2l2.3-3.9a4.5 4.5 0 0 0 5.6-2.9h3.8A9 9 0 0 1 8.1 20.2z",
        fill: "#FBBC04",
      },
      {
        d: "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
        fill: "#4285F4",
      },
    ],
  },
  docker: {
    bg: "#1D63ED",
    parts: [
      {
        d: "M5 11h2v2H5z M8 11h2v2H8z M11 11h2v2h-2z M8 8h2v2H8z M11 8h2v2h-2z M11 5h2v2h-2z",
        fill: "#ffffff",
      },
      {
        d: "M3 14h13c2-.5 3.5-2 4-3.5 1 0 1.5.5 2 .5-1 1-1.5 2-2.5 2-1 4-5 6-8.5 6S4 18 3 14z",
        fill: "#ffffff",
      },
    ],
  },
  mcp: {
    bg: "#f2f2f3",
    parts: [
      {
        d: "M4 14 13 5a2.5 2.5 0 0 1 3.5 3.5L9 16 M9 9l5-5a2.5 2.5 0 0 1 3.5 3.5l-5 5 M7 17l-3 3",
        stroke: "#111111",
        w: 1.8,
      },
    ],
  },
  figma: {
    bg: "#ffffff",
    parts: [
      { d: "M9 3h3v6H9a3 3 0 0 1 0-6z", fill: "#F24E1E" },
      { d: "M12 3h3a3 3 0 0 1 0 6h-3z", fill: "#FF7262" },
      { d: "M12 9h3a3 3 0 1 1-3 3z", fill: "#1ABCFE" },
      { d: "M9 9h3v6H9a3 3 0 0 1 0-6z", fill: "#A259FF" },
      { d: "M9 15h3v3a3 3 0 1 1-3-3z", fill: "#0ACF83" },
    ],
  },
  outlook: {
    bg: "#ffffff",
    parts: [
      { d: "M3 7h9v10H3z", fill: "#0078D4" },
      {
        d: "M7.5 9.5a2.2 2.5 0 1 0 0 5 2.2 2.5 0 0 0 0-5z",
        stroke: "#ffffff",
        w: 1.4,
      },
      { d: "M12 8h9v9h-9z M12 8l4.5 3.5L21 8", stroke: "#0078D4", w: 1.5 },
    ],
  },
};

const PLATFORM_MARKS: Record<string, ConnectorMarkId> = {
  whatsapp: "whatsapp",
  telegram: "telegram",
  discord: "discord",
  abacus_telegram: "telegram",
  abacus_discord: "discord",
  slack: "slack",
};

/** A messaging platform id (shared twins included) → its mark. */
export const markForPlatform = (platformId: string): ConnectorMarkId | null =>
  PLATFORM_MARKS[platformId] ?? null;

const PROVIDER_MARKS: Record<string, ConnectorMarkId> = {
  abacus: "abacus",
  openllm: "abacus",
  routellm: "abacus",
  openrouter: "openrouter",
};

/** A model provider → its mark; null draws a neutral tile with the initial. */
export const markForProvider = (provider: string): ConnectorMarkId | null =>
  PROVIDER_MARKS[provider.toLowerCase()] ?? null;

const isMarkId = (id: string): id is ConnectorMarkId =>
  (CONNECTOR_MARK_IDS as readonly string[]).includes(id);

export interface ConnectorMarkProps {
  /** A mark id; anything else draws a neutral tile with its initial. */
  id: string;
  size: number;
  /** An accessible name; without one the mark is decorative. */
  label?: string;
  /** The initial for a neutral tile (defaults to the id's). */
  initial?: string;
  className?: string;
}

export const ConnectorMark = ({
  id,
  size,
  label,
  initial,
  className,
}: ConnectorMarkProps) => {
  const mark = isMarkId(id) ? MARKS[id] : null;
  const glyph = Math.round(size * 0.68);
  return (
    <span
      data-slot="connector-mark"
      data-mark={mark != null ? id : "neutral"}
      role={label != null ? "img" : undefined}
      aria-label={label}
      aria-hidden={label == null ? true : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        mark == null && "bg-muted text-muted-foreground font-semibold",
        mark?.bg === "#ffffff" && "ring-border ring-1 ring-inset",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        ...(mark != null ? { background: mark.bg } : { fontSize: glyph * 0.7 }),
      }}
    >
      {mark != null ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none">
          {mark.parts.map((part) => (
            <path
              key={part.d}
              d={part.d}
              fill={part.fill ?? "none"}
              stroke={part.stroke ?? "none"}
              strokeWidth={part.w ?? 0}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>
      ) : (
        (initial ?? id.charAt(0)).toUpperCase()
      )}
    </span>
  );
};
