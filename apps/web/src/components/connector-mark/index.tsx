/**
 * ConnectorMark (spec 03 §15, canvas ConnectorIcon): the connector,
 * messaging and provider marks as tiles. Every tile is the same neutral
 * disc (`bg-muted`, never a white plate) and the glyph carries the brand
 * colour; monochrome marks use `currentColor` so they read in both themes,
 * and a glyph cut-out takes `TILE` (the disc's own colour). Paths are the
 * canvas's 24×24 glyph box; tile radius round(size × 0.28), glyph
 * round(size × 0.68). Decorative unless given a `label`. Every id in the
 * `@abacus-ai/connectors` registry has a mark (connector-mark.test.tsx).
 */
import { cn } from "#renderer/lib/cn";

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
  "onedrive",
  "dropbox",
  "confluence",
  "x",
  "huggingface",
  "cloudflare",
  "zapier",
  "zoom",
  "docusign",
  "gcp",
  "canva",
  "paypal",
  // Model providers (the picker, Settings › Models, onboarding).
  "anthropic",
  "openai",
  "gemini",
  "mistral",
  "nvidia",
  "cerebras",
  "groq",
  "deepseek",
  "moonshot",
  "xai",
  "local",
  "baseten",
  "fireworks",
  "minimax",
  "opencode",
  "together",
  "zai",
] as const;
export type ConnectorMarkId = (typeof CONNECTOR_MARK_IDS)[number];

interface Part {
  d: string;
  fill?: string;
  stroke?: string;
  w?: number;
  /** A fill with holes (an eye, a ring). */
  rule?: "evenodd";
}

/** The tile's own colour, for a glyph cut-out (a white shape in the brand's own mark). */
const TILE = "var(--muted)";
const INK = "currentColor";

const MARKS: Record<ConnectorMarkId, { parts: Part[] }> = {
  gmail: {
    parts: [
      { d: "M3 7v11h3.5V11l5.5 4 5.5-4v7H21V7l-9 6.5z", fill: "#EA4335" },
      { d: "M3 7l3.5 2.5V18H3z", fill: "#4285F4" },
      { d: "M17.5 9.5 21 7v11h-3.5z", fill: "#34A853" },
      { d: "M3 7l1-1.5L12 11l8-5.5L21 7l-9 6.5z", fill: "#FBBC04" },
    ],
  },
  calendar: {
    parts: [
      {
        d: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
        fill: TILE,
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
    parts: [
      { d: "M8.5 4h7l5.5 9.5h-7z", fill: "#FBBC04" },
      { d: "M8.5 4 3 13.5l3.5 6L12 10z", fill: "#34A853" },
      { d: "M3 13.5h11l3.5 6H6.5z", fill: "#4285F4" },
    ],
  },
  sheets: {
    parts: [
      {
        d: "M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
        fill: "#34A853",
      },
      { d: "M8 11h8v7H8z M8 14.5h8 M12 11v7", stroke: TILE, w: 1.4 },
    ],
  },
  slack: {
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
    parts: [
      {
        d: "M5 4.5 15.5 3.7c1.2-.1 1.6 0 2.3.6l3 2.1c.5.4.7.5.7 1v12.4c0 .9-.3 1.4-1.5 1.5L8.3 22c-.9.1-1.3-.1-1.8-.7L4 18.4c-.5-.7-.7-1.2-.7-1.8V6c0-.8.3-1.4 1.7-1.5z",
        fill: "none",
        stroke: INK,
        w: 1.5,
      },
      {
        d: "M8.5 8.5v10l2-.2v-6.6l5 7.1 2.2-.2V8.2l-2 .2v6.4L10.6 8.3z",
        fill: INK,
      },
    ],
  },
  github: {
    parts: [
      {
        d: "M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.8.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1-4.4-4.7 0-1 .4-1.9 1-2.5-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.6.6.6 1 1.5 1 2.5 0 3.7-2.3 4.5-4.4 4.7.3.3.6.9.6 1.8v2.6c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z",
        fill: INK,
      },
    ],
  },
  linear: {
    parts: [
      {
        d: "M3.2 13.6 10.4 20.8A9 9 0 0 1 3.2 13.6z M3 10.9 13.1 21a9 9 0 0 0 2.4-.7L3.7 8.5a9 9 0 0 0-.7 2.4z M4.5 6.5 17.5 19.5a9 9 0 0 0 1.5-1.2L5.7 5a9 9 0 0 0-1.2 1.5z M7 4l13 13A9 9 0 1 0 7 4z",
        fill: "#5E6AD2",
      },
    ],
  },
  jira: {
    parts: [
      { d: "M12 2 6 8l6 6 6-6z", fill: "#2684FF" },
      { d: "M6 8 2 12l6 6 4-4z", fill: "#0052CC" },
      { d: "M18 8l4 4-6 6-4-4z", fill: "#0052CC" },
      { d: "M8 18l4 4 4-4-4-4z", fill: "#2684FF" },
    ],
  },
  stripe: {
    parts: [
      {
        d: "M13.3 9.6c0-.7.6-1 1.6-1 1.4 0 3.2.4 4.6 1.2V5.6c-1.5-.6-3-.9-4.6-.9-3.8 0-6.3 2-6.3 5.3 0 5.1 7 4.3 7 6.5 0 .8-.7 1.1-1.7 1.1-1.5 0-3.5-.6-5.1-1.5v4.3c1.7.7 3.4 1 5.1 1 3.9 0 6.6-1.9 6.6-5.3-.1-5.5-7.2-4.5-7.2-6.5z",
        fill: "#635BFF",
      },
    ],
  },
  zendesk: {
    parts: [
      {
        d: "M11 7v13H3z M3 7a4 4 0 0 1 8 0z M13 17V4h8z M21 17a4 4 0 0 1-8 0z",
        fill: INK,
      },
    ],
  },
  hubspot: {
    parts: [
      {
        d: "M16.5 9.2V6.7a1.8 1.8 0 1 0-1.4 0v2.5a5 5 0 0 0-2.4 1L6.9 6a2 2 0 1 0-1 1.2l5.6 4.1a5 5 0 1 0 5 -2.1z M15.8 17.5a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4z",
        fill: "#FF7A59",
      },
    ],
  },
  postgres: {
    parts: [
      {
        d: "M12 4c-4 0-6 3-6 7 0 3 1 6 3 8 1 1 2 1 3 0 1-1 1-3 1-3s2 0 3-2c1-2 1-5 0-7s-2-3-4-3z",
        fill: "#336791",
      },
      { d: "M9.5 9.5h.01 M14 9.5h.01", stroke: TILE, w: 2 },
    ],
  },
  snowflake: {
    parts: [
      {
        d: "M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9 M12 3l-2 2 M12 3l2 2 M12 21l-2-2 M12 21l2-2",
        stroke: "#29B5E8",
        w: 2,
      },
    ],
  },
  vercel: { parts: [{ d: "M12 4 21 20H3z", fill: INK }] },
  aws: {
    parts: [
      { d: "M4 15c2.5 2 5.5 3 8.5 3s5.5-1 7.5-2.5", stroke: "#FF9900", w: 2 },
      { d: "M18 14l2 1.5-2 1.5", stroke: "#FF9900", w: 2 },
      { d: "M7 6h3l1.5 5L13 6h3", stroke: INK, w: 1.8 },
    ],
  },
  whatsapp: {
    parts: [
      {
        d: "M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5z",
        fill: "#25D366",
      },
      {
        d: "M9 8.5c.2-.5.5-.5.8-.5h.5c.2 0 .4.1.5.4l.6 1.5c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4.5.9 1.4 1.8 2.4 2.3.2.1.3.1.4 0l.7-.7c.2-.2.4-.2.6-.1l1.5.7c.2.1.3.3.3.5 0 .8-.4 1.5-1.2 1.8-.7.2-1.5.1-2.4-.3a8 8 0 0 1-3.7-3.6c-.4-.9-.5-1.7-.4-2.5.1-.4.3-.8.6-1z",
        fill: TILE,
      },
    ],
  },
  telegram: {
    parts: [
      {
        d: "M4 11.5 19 5.5c.7-.3 1.3.2 1.1 1L17.5 18c-.2.8-.7 1-1.4.6l-3.8-2.8-1.8 1.8c-.2.2-.4.3-.8.3l.3-3.8 6.9-6.2c.3-.3-.1-.4-.5-.2L8 12.9l-3.7-1.2c-.8-.2-.8-.8.1-1.2z",
        fill: "#2AABEE",
      },
    ],
  },
  discord: {
    parts: [
      {
        d: "M18.9 6.2A15 15 0 0 0 15.2 5l-.5 1a14 14 0 0 0-5.4 0l-.5-1a15 15 0 0 0-3.7 1.2C2.7 9.7 2.1 13.1 2.4 16.5a15 15 0 0 0 4.6 2.3l1-1.6a10 10 0 0 1-1.6-.8l.4-.3a10.7 10.7 0 0 0 10.4 0l.4.3-1.6.8 1 1.6a15 15 0 0 0 4.6-2.3c.4-3.9-.7-7.3-2.7-10.3zM9 14.5c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8zm6 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8z",
        fill: "#5865F2",
      },
    ],
  },
  abacus: {
    parts: [
      { d: "M5 6h14 M5 12h14 M5 18h14", stroke: INK, w: 1.5 },
      {
        d: "M8 6h.01 M12 6h.01 M7 12h.01 M11 12h.01 M15 12h.01 M9 18h.01 M16 18h.01",
        stroke: "#e879f9",
        w: 3.2,
      },
    ],
  },
  openrouter: {
    parts: [{ d: "M3 12h4l3-4 4 8 3-4h4", stroke: "#6467f2", w: 2 }],
  },
  chrome: {
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
    parts: [
      {
        d: "M5 11h2v2H5z M8 11h2v2H8z M11 11h2v2h-2z M8 8h2v2H8z M11 8h2v2h-2z M11 5h2v2h-2z",
        fill: "#1D63ED",
      },
      {
        d: "M3 14h13c2-.5 3.5-2 4-3.5 1 0 1.5.5 2 .5-1 1-1.5 2-2.5 2-1 4-5 6-8.5 6S4 18 3 14z",
        fill: "#1D63ED",
      },
    ],
  },
  mcp: {
    parts: [
      {
        d: "M4 14 13 5a2.5 2.5 0 0 1 3.5 3.5L9 16 M9 9l5-5a2.5 2.5 0 0 1 3.5 3.5l-5 5 M7 17l-3 3",
        stroke: INK,
        w: 1.8,
      },
    ],
  },
  figma: {
    parts: [
      { d: "M9 3h3v6H9a3 3 0 0 1 0-6z", fill: "#F24E1E" },
      { d: "M12 3h3a3 3 0 0 1 0 6h-3z", fill: "#FF7262" },
      { d: "M12 9h3a3 3 0 1 1-3 3z", fill: "#1ABCFE" },
      { d: "M9 9h3v6H9a3 3 0 0 1 0-6z", fill: "#A259FF" },
      { d: "M9 15h3v3a3 3 0 1 1-3-3z", fill: "#0ACF83" },
    ],
  },
  outlook: {
    parts: [
      { d: "M3 7h9v10H3z", fill: "#0078D4" },
      {
        d: "M7.5 9.5a2.2 2.5 0 1 0 0 5 2.2 2.5 0 0 0 0-5z",
        stroke: TILE,
        w: 1.4,
      },
      { d: "M12 8h9v9h-9z M12 8l4.5 3.5L21 8", stroke: "#0078D4", w: 1.5 },
    ],
  },
  onedrive: {
    parts: [
      {
        d: "M7 17.5h11a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 8.2 9.1 4.25 4.25 0 0 0 7 17.5z",
        fill: "#0078D4",
      },
    ],
  },
  dropbox: {
    parts: [
      {
        d: "M7.5 3 3 6l4.5 3L12 6z M16.5 3 12 6l4.5 3L21 6z M3 12l4.5 3 4.5-3-4.5-3z M21 12l-4.5 3-4.5-3 4.5-3z M7.5 16.2 12 19l4.5-2.8V17L12 20l-4.5-3z",
        fill: "#0061FF",
      },
    ],
  },
  confluence: {
    parts: [
      {
        d: "M3.5 17.5c2.4-4 4.8-5.3 8.4-3.6l5.1 2.4 1.9-4-5.2-2.4C8.4 7.6 4.5 9.4 1.9 14.5z",
        fill: "#2684FF",
      },
      {
        d: "M20.5 6.5c-2.4 4-4.8 5.3-8.4 3.6L7 7.7l-1.9 4 5.2 2.4c5.3 2.3 9.2.5 11.8-4.6z",
        fill: "#0052CC",
      },
    ],
  },
  x: {
    parts: [{ d: "M4 3h4.5l11.5 18h-4.5z M20 3 4 21", stroke: INK, w: 2 }],
  },
  huggingface: {
    parts: [
      { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", fill: "#FFD21E" },
      { d: "M8.5 9.5h.01 M15.5 9.5h.01", stroke: "#111111", w: 2.4 },
      {
        d: "M8 13c1 2.4 2.5 3.5 4 3.5s3-1.1 4-3.5c-2.6 1-5.4 1-8 0z",
        fill: "#111111",
      },
      {
        d: "M10.5 15c.5-.6 1-.8 1.5-.8s1 .2 1.5.8",
        stroke: "#FF9D0B",
        w: 1.4,
      },
    ],
  },
  cloudflare: {
    parts: [
      {
        d: "M6 17.5h11.5a3 3 0 0 0 .3-6A5 5 0 0 0 8.4 9.6 4 4 0 0 0 6 17.5z",
        fill: "#F38020",
      },
      { d: "M4 17.5h12", stroke: "#FAAE40", w: 2 },
    ],
  },
  zapier: {
    parts: [
      {
        d: "M12 3v18 M3 12h18 M5.6 5.6l12.8 12.8 M18.4 5.6 5.6 18.4",
        stroke: "#FF4F00",
        w: 2.4,
      },
      { d: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", fill: TILE },
    ],
  },
  zoom: {
    parts: [
      {
        d: "M4 7h9.5a1.5 1.5 0 0 1 1.5 1.5V17H5.5A1.5 1.5 0 0 1 4 15.5z",
        fill: "#2D8CFF",
      },
      { d: "M16 10.5 20 8v8l-4-2.5z", fill: "#2D8CFF" },
    ],
  },
  docusign: {
    parts: [
      {
        d: "M6 2.5h8l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1-1.5z",
        fill: "#FFCC22",
      },
      {
        d: "M8 16.5c1.5-2 2.5-2 3.2-.5s1.3 1 2.3-1 1.5-.6 2.5.5",
        stroke: "#111111",
        w: 1.4,
      },
      { d: "M14 2.5v5h5", stroke: TILE, w: 1.2 },
    ],
  },
  gcp: {
    parts: [
      { d: "M12 3l7.8 4.5L12 12z", fill: "#EA4335" },
      { d: "M19.8 7.5v9L12 12z", fill: "#FBBC04" },
      { d: "M12 12l7.8 4.5L12 21z", fill: "#34A853" },
      { d: "M12 12v9l-7.8-4.5z", fill: "#34A853" },
      { d: "M4.2 7.5 12 12l-7.8 4.5z", fill: "#4285F4" },
      { d: "M12 3v9L4.2 7.5z", fill: "#4285F4" },
    ],
  },
  canva: {
    parts: [
      { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", fill: "#00C4CC" },
      { d: "M14.8 9.5a3.4 3.4 0 1 0 0 5", stroke: TILE, w: 2 },
    ],
  },
  paypal: {
    parts: [
      {
        d: "M6.5 20 9 4h6.5c3 0 4.5 1.6 4 4.2-.6 3.2-2.8 4.8-6 4.8h-2.6L9.8 20z",
        fill: "#003087",
      },
      {
        d: "M9.8 20l1.1-7h2.6c3.2 0 5.4-1.6 6-4.8.1-.6.1-1.1 0-1.5 1.5.8 2 2.3 1.6 4.3-.6 3.2-2.8 4.8-6 4.8h-2.3l-.7 4.2z",
        fill: "#009CDE",
      },
    ],
  },
  // ── Model providers. Brand colour where the brand is one, else INK. ──
  anthropic: {
    parts: [
      {
        d: "M10.4 4h3.2l6.6 16h-3.4l-1.3-3.5H8.5L7.2 20H3.8zm1.6 3.4-2.4 6.3h4.8z",
        fill: INK,
        rule: "evenodd",
      },
    ],
  },
  openai: {
    parts: [
      {
        d: "M12 3.4 19.4 7.7v8.6L12 20.6l-7.4-4.3V7.7zM12 12l7.4-4.3M12 12 4.6 7.7M12 12v8.6M12 12V3.4M12 12l7.4 4.3M12 12l-7.4 4.3",
        stroke: INK,
        w: 1.6,
      },
    ],
  },
  gemini: {
    parts: [
      {
        d: "M12 2c.7 5.5 4.5 9.3 10 10-5.5.7-9.3 4.5-10 10-.7-5.5-4.5-9.3-10-10 5.5-.7 9.3-4.5 10-10z",
        fill: "#4E8EF7",
      },
    ],
  },
  mistral: {
    parts: [
      {
        d: "M3.5 4h3.4v16H3.5zm13.6 0h3.4v16h-3.4zM6.9 7.4h3.4v3.3H6.9zm6.8 0h3.4v3.3h-3.4zm-3.4 3.3h3.4V14h-3.4z",
        fill: "#FF7000",
      },
    ],
  },
  nvidia: {
    parts: [
      {
        d: "M12 7.2c-4.2 0-7.5 2-9.5 4.8 2 2.8 5.3 4.8 9.5 4.8s7.5-2 9.5-4.8c-2-2.8-5.3-4.8-9.5-4.8zm0 2.3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
        fill: "#76B900",
        rule: "evenodd",
      },
    ],
  },
  cerebras: {
    parts: [
      { d: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z", fill: "#F15A22" },
      {
        d: "M8.5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm0 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
        fill: TILE,
      },
    ],
  },
  groq: {
    parts: [
      {
        d: "M12 3a8 8 0 1 1-8 8v7h3.2v-4.1A8 8 0 0 1 12 3zm0 3.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6z",
        fill: "#F55036",
        rule: "evenodd",
      },
    ],
  },
  deepseek: {
    parts: [
      {
        d: "M2.5 11.2c2.2-4.3 6.4-6.2 10.6-5.6 2.2.3 4.2 1.4 6 3.3l2.4-1.6-.4 3.8c-1.1 3.4-4.3 5.9-8.5 5.9-3.8 0-7.2-1.7-10.1-5.8z",
        fill: "#4D6BFE",
      },
      { d: "M15.6 10.3a1 1 0 1 1 0 2 1 1 0 0 1 0-2z", fill: TILE },
    ],
  },
  moonshot: {
    parts: [
      {
        d: "M14.2 3a9 9 0 1 0 6.4 15.4A8.2 8.2 0 0 1 14.2 3z",
        fill: INK,
      },
    ],
  },
  xai: {
    parts: [
      {
        d: "M4.5 4.5 19.5 19.5M19.5 4.5l-6 6M4.5 19.5l5.3-5.3",
        stroke: INK,
        w: 2,
      },
    ],
  },
  local: {
    parts: [
      {
        d: "M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM9.5 9.5h5v5h-5zM12 2v3M12 19v3M2 12h3M19 12h3",
        stroke: INK,
        w: 1.6,
      },
    ],
  },
  baseten: {
    parts: [
      {
        d: "M4 4h9a4 4 0 0 1 2.6 7 4.5 4.5 0 0 1-2.1 9H4zm3.2 3v3.6h5.4a1.8 1.8 0 0 0 0-3.6zm0 6.4V17h5.9a1.8 1.8 0 0 0 0-3.6z",
        fill: INK,
        rule: "evenodd",
      },
    ],
  },
  fireworks: {
    parts: [
      {
        d: "M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5",
        stroke: INK,
        w: 1.8,
      },
    ],
  },
  minimax: {
    parts: [
      {
        d: "M3 9c2-2.6 4-2.6 6 0s4 2.6 6 0 4-2.6 6 0M3 15c2-2.6 4-2.6 6 0s4 2.6 6 0 4-2.6 6 0",
        stroke: INK,
        w: 1.8,
      },
    ],
  },
  opencode: {
    parts: [{ d: "M5 7l5 5-5 5M12.5 17H19", stroke: INK, w: 2 }],
  },
  together: {
    parts: [
      {
        d: "M9 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm6 0a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
        stroke: INK,
        w: 1.6,
      },
    ],
  },
  zai: {
    parts: [{ d: "M5 5h14L5 19h14", stroke: INK, w: 2.2 }],
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

/**
 * Every provider the app names (`PROVIDER_KEY_FIELDS`, pi's catalog, the
 * local runtime and the Abacus twins) → its mark; connector-mark.test.tsx
 * holds the list to it.
 */
const PROVIDER_MARKS: Record<string, ConnectorMarkId> = {
  abacus: "abacus",
  openllm: "abacus",
  routellm: "abacus",
  openrouter: "openrouter",
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  gemini: "gemini",
  google: "gemini",
  mistral: "mistral",
  nvidia: "nvidia",
  cerebras: "cerebras",
  groq: "groq",
  deepseek: "deepseek",
  moonshotai: "moonshot",
  moonshot: "moonshot",
  kimi: "moonshot",
  xai: "xai",
  local: "local",
  ollama: "local",
  baseten: "baseten",
  fireworks: "fireworks",
  huggingface: "huggingface",
  minimax: "minimax",
  opencode: "opencode",
  together: "together",
  "vercel-ai-gateway": "vercel",
  zai: "zai",
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
  const alias = id.replace(/^(?:messaging|abacus)-/, "");
  const markId =
    (
      {
        "google-drive": "drive",
        "google-calendar": "calendar",
        "google-mail": "gmail",
        "microsoft-outlook": "outlook",
        "google-sheets": "sheets",
        "cloudflare-docs": "cloudflare",
        twitter: "x",
      } as Record<string, string>
    )[alias] ?? alias;
  const mark = isMarkId(markId) ? MARKS[markId] : null;
  const glyph = Math.round(size * 0.78);
  return (
    <span
      data-slot="connector-mark"
      data-mark={mark != null ? markId : "neutral"}
      role={label != null ? "img" : undefined}
      aria-label={label}
      aria-hidden={label == null ? true : undefined}
      className={cn(
        "bg-muted inline-flex shrink-0 items-center justify-center overflow-hidden",
        mark == null
          ? "text-muted-foreground font-semibold"
          : "text-foreground",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        ...(mark == null ? { fontSize: glyph * 0.7 } : null),
      }}
    >
      {mark != null ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none">
          {mark.parts.map((part) => (
            <path
              key={part.d}
              d={part.d}
              fill={part.fill ?? "none"}
              fillRule={part.rule}
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
