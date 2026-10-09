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
import geminiLogo from "#renderer/assets/connectors/gemini.svg";
import gmailLogo from "#renderer/assets/connectors/gmail.png";
import calendarLogo from "#renderer/assets/connectors/google_calendar.webp";
import driveLogo from "#renderer/assets/connectors/google_drive.webp";
import { AppBrandMark } from "#renderer/components/app-icon";
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

// Original bundled connector assets; Gemini is from LobeHub Icons, MIT.
const LOGO_ASSETS: Record<string, string> = {
  gmail: gmailLogo,
  calendar: calendarLogo,
  drive: driveLogo,
  gemini: geminiLogo,
};

const MARKS: Record<ConnectorMarkId, { parts: Part[] }> = {
  gmail: { parts: [] },
  calendar: { parts: [] },
  drive: { parts: [] },
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
        d: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z",
        fill: "#128C46",
      },
    ],
  },
  telegram: {
    parts: [
      {
        d: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
        fill: "#1C7FB2",
      },
    ],
  },
  discord: {
    parts: [
      {
        d: "M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z",
        fill: "#5865F2",
      },
    ],
  },
  abacus: { parts: [] },
  openrouter: {
    parts: [
      {
        d: "M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z",
        fill: INK,
      },
    ],
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
  gemini: { parts: [] },
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
      {markId === "abacus" ? (
        <AppBrandMark
          size={glyph}
          className="size-full"
          style={{ width: glyph, height: glyph }}
        />
      ) : mark != null ? (
        <svg
          className="size-full"
          style={{ width: glyph, height: glyph }}
          width={glyph}
          height={glyph}
          viewBox="0 0 24 24"
          fill="none"
        >
          {LOGO_ASSETS[markId] ? (
            <image href={LOGO_ASSETS[markId]} width="24" height="24" />
          ) : (
            <>
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
            </>
          )}
        </svg>
      ) : (
        (initial ?? id.charAt(0)).toUpperCase()
      )}
    </span>
  );
};
