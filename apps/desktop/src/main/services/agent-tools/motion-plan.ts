/**
 * Motion graphics, the part that needs no Electron: which templates exist,
 * what each one takes, how long each scene runs, and the page that results.
 *
 * The model never writes markup or CSS. It picks a template and a size and
 * fills the template's slots with words and numbers; this module validates
 * them, works out every delay, and fills the template. Every value is escaped,
 * so nothing a model writes can change a page's structure. motion-agent.ts
 * then plays the page frame by frame into an MP4.
 *
 * All motion is CSS animation with a delay this module computed, which is what
 * makes the render exact: the renderer pauses every animation and sets its
 * time per frame, so a slow machine gives the same video as a fast one.
 */

const MOTION_SIZES = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
} as const;

type MotionSize = keyof typeof MOTION_SIZES;

export const MOTION_FPS = 30;

/** Long enough for a Reel or an explainer; short enough to render in a minute. */
const MAX_MOTION_SECONDS = 30;

/** Page seconds per video second for each pace the plan can ask for. */
const PACES: Record<string, number> = { slow: 0.8, normal: 1, fast: 1.3 };

/** Faster than this and words leave before they are read. */
const FASTEST = 1.4;

type TextSlot = {
  kind: "text";
  description: string;
  max: number;
  optional?: boolean;
};

type ListSlot = {
  kind: "list";
  description: string;
  min: number;
  maxItems: number;
  /** A list of strings when absent; otherwise each item is an object of these. */
  fields?: Record<
    string,
    { description: string; max?: number; number?: true; optional?: true }
  >;
  /** Characters per string item (lists of strings only). */
  max?: number;
};

/** A path to an image file; the host reads it (readImage) and the page embeds it. */
type ImageSlot = {
  kind: "image";
  description: string;
  optional?: boolean;
};

type Slot = TextSlot | ListSlot | ImageSlot;

/** What the host makes of an image path: a data: URI, and whether it is mostly dark. */
export type MotionImage = { src: string; tone: "dark" | "light" };

type ReadMotionImage = (file: string) => MotionImage;

type Scope = Record<string, unknown>;

type Palette = {
  accent: string;
  /** A second accent: gradients, highlights, the top bar. */
  accent2: string;
  ink: string;
  paper: string;
  /** The background's second tone, toward which it shades. */
  paper2: string;
};

type TemplateDefinition = {
  description: string;
  /** Its own colours when the plan names none: each template has a look. */
  palette: Palette;
  slots: Record<string, Slot>;
  /** Slots in, the template's scope out (with every delay), plus the length. */
  prepare: (slots: Scope) => { scope: Scope; seconds: number };
};

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Seconds, rounded for CSS: 1.2000000001s would still work, but reads badly. */
const s = (value: number): string => String(Math.round(value * 100) / 100);

const words = (text: string): string[] =>
  text.split(/\s+/).filter((word) => word.length > 0);

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** How a number reads on screen: grouped, at most two decimals. */
const formatNumber = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const MOTION_TEMPLATES: Record<string, TemplateDefinition> = {
  "title-card": {
    description:
      "One big title revealed word by word, an accent line, and an optional subtitle and kicker above it. An intro, an outro, a YouTube title, an announcement.",
    palette: {
      accent: "#8b5cf6",
      accent2: "#f472b6",
      ink: "#f8f7ff",
      paper: "#0c0a1d",
      paper2: "#24123f",
    },
    slots: {
      title: { kind: "text", description: "The headline.", max: 60 },
      subtitle: {
        kind: "text",
        description: "One line under the title.",
        max: 100,
        optional: true,
      },
      kicker: {
        kind: "text",
        description:
          "A small label above the title: a date, a brand, an episode.",
        max: 40,
        optional: true,
      },
    },
    prepare: (slots) => {
      const subtitle = str(slots.subtitle);
      const title = words(str(slots.title));
      const titleDone = 0.5 + title.length * 0.08 + 0.6;
      return {
        scope: {
          titleWords: title.map((word, index) => ({
            w: word,
            wd: s(0.5 + index * 0.08),
          })),
          lineAt: s(titleDone),
          subtitleAt: s(titleDone + 0.3),
          subtitle,
          kicker: str(slots.kicker),
        },
        seconds: clamp(titleDone + (subtitle.length > 0 ? 3.6 : 2.8), 4.5, 8),
      };
    },
  },

  "kinetic-text": {
    description:
      "Short lines that punch in one after another, word by word, in big type; numbers and prices are highlighted. A hook for a Reel or Short, a manifesto, a quote, a countdown.",
    palette: {
      accent: "#facc15",
      accent2: "#fb7185",
      ink: "#fafafa",
      paper: "#0a0a0c",
      paper2: "#1c1917",
    },
    slots: {
      lines: {
        kind: "list",
        description:
          "The lines, in order, a few words each. Words the user gave (a quote, a slogan, their own lines) go in word for word, each once.",
        min: 2,
        maxItems: 8,
        max: 48,
      },
      closing: {
        kind: "text",
        description:
          "A last line held on screen in the accent colour: a quote's author, or a call to action the user asked for. Otherwise leave it out.",
        max: 60,
        optional: true,
      },
    },
    prepare: (slots) => {
      const lines = (slots.lines as string[]).map(str);
      const closing = str(slots.closing);
      let at = 0.3;
      const scenes = lines.map((line, index) => {
        const list = words(line);
        const len = clamp(1.1 + list.length * 0.28, 1.6, 3.2);
        const scene = {
          d: s(at),
          len: s(len),
          last: index === lines.length - 1 && closing.length === 0 ? "1" : "",
          words: list.map((word, position) => ({
            w: word,
            wd: s(at + position * 0.1),
            // A number or a price is what a hook turns on.
            hl: /[\p{N}$€£¥₹%]/u.test(word) ? "1" : "",
          })),
        };
        at += len;
        return scene;
      });
      const closingAt = at;
      const seconds = closing.length > 0 ? at + 2.6 : at + 0.6;
      return {
        scope: { lines: scenes, closing, closingAt: s(closingAt) },
        seconds,
      };
    },
  },

  "animated-chart": {
    description:
      "A horizontal bar chart filling the frame, whose bars grow in one by one while their numbers count up; the largest is highlighted. A title and an optional caption. Results, rankings, comparisons.",
    palette: {
      accent: "#38bdf8",
      accent2: "#34d399",
      ink: "#f0f9ff",
      paper: "#07111f",
      paper2: "#0e2a3d",
    },
    slots: {
      title: { kind: "text", description: "What the chart shows.", max: 60 },
      bars: {
        kind: "list",
        description: "The bars, in the order to show them.",
        min: 2,
        maxItems: 8,
        fields: {
          label: { description: "The bar's name.", max: 24 },
          value: { description: "A number, zero or more.", number: true },
        },
      },
      unit: {
        kind: "text",
        description:
          'Shown with every number: "%", "$M" (shows as $120M), "users".',
        max: 12,
        optional: true,
      },
      caption: {
        kind: "text",
        description: "The takeaway, shown at the end.",
        max: 100,
        optional: true,
      },
    },
    prepare: (slots) => {
      const bars = slots.bars as Array<{ label: string; value: number }>;
      const peak = Math.max(...bars.map((bar) => bar.value), 1e-9);
      const caption = str(slots.caption);
      const start = 1.0;
      const step = 0.3;
      const grow = 1.3;
      const items = bars.map((bar, index) => {
        const whole = Number.isInteger(bar.value) && bar.value < 1e9;
        return {
          label: str(bar.label),
          pct: s(clamp((bar.value / peak) * 100, 2, 100)),
          top: bar.value === peak ? "1" : "",
          d: s(start + index * step),
          // Whole numbers count up in CSS; anything else fades in as text.
          count: whole ? String(bar.value) : "",
          text: whole ? "" : formatNumber(bar.value),
        };
      });
      const unit = splitUnit(str(slots.unit));
      const barsDone = start + (bars.length - 1) * step + grow;
      const captionAt = barsDone + 0.3;
      return {
        scope: {
          title: str(slots.title),
          prefix: unit.prefix,
          unit: unit.suffix,
          caption,
          captionAt: s(captionAt),
          bars: items,
        },
        seconds: caption.length > 0 ? captionAt + 3 : barsDone + 2,
      };
    },
  },

  "product-promo": {
    description:
      "A short product ad: the name, the tagline, the features building up as a checklist, then a call to action held at the end.",
    palette: {
      accent: "#ff5c8a",
      accent2: "#ffb347",
      ink: "#fff7f2",
      paper: "#16080f",
      paper2: "#3a1024",
    },
    slots: {
      name: { kind: "text", description: "The product or brand.", max: 40 },
      tagline: {
        kind: "text",
        description: "What it does for the viewer, in a line.",
        max: 90,
      },
      features: {
        kind: "list",
        description: "Benefits, one short line each.",
        min: 2,
        maxItems: 5,
        max: 60,
      },
      cta: {
        kind: "text",
        description:
          'The call to action: "Try it free at example.com", "Order today".',
        max: 50,
      },
    },
    prepare: (slots) => {
      // The name (0-2.4 s) and the tagline (2.4-5.2 s) are fixed in the
      // template; then the features build up, one every 1.4 s, and the CTA.
      const features = (slots.features as string[]).map(str);
      const featuresLen = 0.3 + features.length * 1.4 + 1.4;
      const ctaAt = 5.2 + featuresLen;
      return {
        scope: {
          name: str(slots.name),
          tagline: str(slots.tagline),
          cta: str(slots.cta),
          features: features.map((feature, index) => ({
            feature,
            k: s(0.3 + index * 1.4),
          })),
          featuresLen: s(featuresLen),
          ctaAt: s(ctaAt),
        },
        seconds: ctaAt + 3,
      };
    },
  },

  explainer: {
    description:
      "A title, then numbered steps along a timeline, each a heading and a sentence, then an optional closing line. How something works, a process, a tutorial, a summary.",
    palette: {
      accent: "#2dd4bf",
      accent2: "#a3e635",
      ink: "#f0fdfa",
      paper: "#051417",
      paper2: "#0b3036",
    },
    slots: {
      title: { kind: "text", description: "The topic.", max: 60 },
      steps: {
        kind: "list",
        description: "The steps, in order.",
        min: 2,
        maxItems: 6,
        fields: {
          heading: { description: "A few words.", max: 40 },
          text: { description: "One or two short sentences.", max: 140 },
        },
      },
      outro: {
        kind: "text",
        description: "A closing line held at the end.",
        max: 80,
        optional: true,
      },
    },
    prepare: (slots) => {
      const steps = slots.steps as Array<{ heading: string; text: string }>;
      const outro = str(slots.outro);
      let at = 0;
      const titleLen = 2.6;
      at += titleLen;
      const scenes = steps.map((step, index) => {
        const text = str(step.text);
        // Reading time at about 18 characters a second, plus the entrance.
        const len = clamp(2.2 + text.length / 18, 3, 7);
        const scene = {
          heading: withoutNumber(str(step.heading), index + 1),
          text,
          number: String(index + 1),
          dots: steps.map((_, other) => ({
            n: String(other + 1),
            state: other < index ? "done" : other === index ? "now" : "next",
          })),
          d: s(at),
          len: s(len),
          last: index === steps.length - 1 && outro.length === 0 ? "1" : "",
        };
        at += len;
        return scene;
      });
      const outroAt = at;
      return {
        scope: {
          title: str(slots.title),
          titleLen: s(titleLen),
          titleDots: steps.map((_, other) => ({ n: String(other + 1) })),
          steps: scenes,
          outro,
          outroAt: s(outroAt),
        },
        seconds: outro.length > 0 ? outroAt + 3 : outroAt + 0.4,
      };
    },
  },

  "logo-reveal": {
    description:
      "The user's logo revealed with a burst of light, then the name and an optional tagline. A channel intro or outro, a brand sting, the start of a presentation. Needs the logo as an image file.",
    palette: {
      accent: "#60a5fa",
      accent2: "#c084fc",
      ink: "#f8fafc",
      paper: "#0a0f1e",
      paper2: "#1a2550",
    },
    slots: {
      logo: {
        kind: "image",
        description: "The logo, as the user gave it.",
      },
      name: {
        kind: "text",
        description: "The brand or channel name under the logo.",
        max: 40,
        optional: true,
      },
      tagline: {
        kind: "text",
        description: "A short line under the name.",
        max: 80,
        optional: true,
      },
    },
    prepare: (slots) => {
      const image = slots.logo as MotionImage;
      const tagline = str(slots.tagline);
      return {
        scope: {
          logo: image.src,
          tone: image.tone,
          name: str(slots.name),
          tagline,
        },
        seconds: tagline.length > 0 ? 5.6 : 4.6,
      };
    },
  },

  "big-numbers": {
    description:
      "One to four headline numbers, each counting up large on its own with a label, after an optional title. Results, milestones, a year in review, a stat for a Reel.",
    palette: {
      accent: "#f97316",
      accent2: "#facc15",
      ink: "#fffbeb",
      paper: "#140a04",
      paper2: "#3b1a07",
    },
    slots: {
      title: {
        kind: "text",
        description: "Shown before the numbers.",
        max: 60,
        optional: true,
      },
      stats: {
        kind: "list",
        description: "The numbers, in order.",
        min: 1,
        maxItems: 4,
        fields: {
          value: { description: "The number.", number: true },
          unit: {
            description: 'Around the number: "%", "$", "$M", "★", "users".',
            max: 12,
            optional: true,
          },
          label: { description: "What the number is.", max: 60 },
        },
      },
      caption: {
        kind: "text",
        description: "The takeaway, held at the end.",
        max: 100,
        optional: true,
      },
    },
    prepare: (slots) => {
      const title = str(slots.title);
      const caption = str(slots.caption);
      const stats = slots.stats as Array<{
        value: number;
        unit: string;
        label: string;
      }>;
      let at = 0;
      const titleLen = 2.4;
      if (title.length > 0) at += titleLen;
      const len = 3.2;
      const scenes = stats.map((stat, index) => {
        const unit = splitUnit(str(stat.unit));
        const scene = {
          ...countGroups(stat.value),
          prefix: unit.prefix,
          unit: unit.suffix,
          label: str(stat.label),
          d: s(at),
          len: s(len),
          last: index === stats.length - 1 && caption.length === 0 ? "1" : "",
        };
        at += len;
        return scene;
      });
      return {
        scope: {
          title,
          titleLen: s(titleLen),
          stats: scenes,
          caption,
          captionAt: s(at),
        },
        seconds: caption.length > 0 ? at + 3 : at + 0.6,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Catalog: what the sub-agent plans from (never the markup)
// ---------------------------------------------------------------------------

export type MotionCatalog = {
  sizes: MotionSize[];
  templates: Array<{
    name: string;
    description: string;
    slots: Record<string, string>;
  }>;
};

const describeSlot = (slot: Slot): string => {
  if (slot.kind === "image")
    return `${slot.optional ? "optional " : ""}image: the path of a PNG, JPEG, WebP, GIF or SVG file (an attached logo). ${slot.description}`;
  if (slot.kind === "text")
    return `${slot.optional ? "optional " : ""}text, at most ${slot.max} characters. ${slot.description}`;
  const items =
    slot.fields == null
      ? `strings of at most ${slot.max} characters`
      : `objects {${Object.entries(slot.fields)
          .map(([key, field]) =>
            field.number === true
              ? `${key}: number`
              : `${key}: ${field.optional ? "optional " : ""}text ≤ ${field.max}`
          )
          .join(", ")}}`;
  return `list of ${slot.min} to ${slot.maxItems} ${items}. ${slot.description}`;
};

export const motionCatalog = (): MotionCatalog => ({
  sizes: Object.keys(MOTION_SIZES) as MotionSize[],
  templates: Object.entries(MOTION_TEMPLATES).map(([name, template]) => ({
    name,
    description: template.description,
    slots: Object.fromEntries(
      Object.entries(template.slots).map(([key, slot]) => [
        key,
        describeSlot(slot),
      ])
    ),
  })),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A unit as written around a number: a currency sign goes in front ("$K" is
 * $120K, not 120 $K), a short unit sticks to the number (120%, 120K) and a
 * word stands apart (120 users).
 */
const splitUnit = (unit: string): { prefix: string; suffix: string } => {
  const currency = /^[$€£¥₹₩₽₺₦]/u.exec(unit)?.[0] ?? "";
  const rest = unit.slice(currency.length).trim();
  const word = /^\p{L}{3,}/u.test(rest);
  return { prefix: currency, suffix: word ? ` ${rest}` : rest };
};

/**
 * A whole number as groups of three that count up side by side
 * (1,240,000 → 1 | 240 | 000), each after the first padded to three digits,
 * with the decimals after: CSS counters cannot group or show decimals.
 */
const countGroups = (
  value: number
): {
  groups: Array<{ g: string; pad: string; sep: string }>;
  decimals: string;
} => {
  const [whole = "0", fraction = ""] = formatNumber(value).split(".");
  const parts = whole.split(",");
  return {
    groups: parts.map((part, index) => ({
      g: String(Number(part)),
      pad: index > 0 ? "1" : "",
      sep: index < parts.length - 1 ? "1" : "",
    })),
    decimals: fraction === "" ? "" : `.${fraction}`,
  };
};

/**
 * A heading without the step's own number in front ("1. Ask", "Step 2: We
 * check"): the template prints the number large above it.
 */
const withoutNumber = (heading: string, number: number): string => {
  const match = /^(?:step\s*)?(\d+)\s*[.):\-–—]\s+/iu.exec(heading);
  return match != null && Number(match[1]) === number
    ? heading.slice(match[0].length)
    : heading;
};

/** `label` is how the error names the text: `"title"`, `"heading" of steps item 3`. */
const checkText = (label: string, value: unknown, max: number): string => {
  const text = str(value);
  if (text.length > max)
    throw new Error(
      `${label} is ${text.length} characters; keep it to ${max}.`
    );
  return text;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const validateSlots = (
  name: string,
  template: TemplateDefinition,
  raw: Scope,
  readImage?: ReadMotionImage
): { slots: Scope; warnings: string[] } => {
  const warnings: string[] = [];
  const slots: Scope = {};

  for (const key of Object.keys(raw))
    if (!(key in template.slots))
      warnings.push(`Ignored "${key}": ${name} has no such slot.`);

  for (const [key, slot] of Object.entries(template.slots)) {
    const value = raw[key];
    if (slot.kind === "image") {
      const file = str(value);
      if (file.length === 0) {
        if (slot.optional !== true) throw new Error(`"${key}" is required.`);
        slots[key] = null;
        continue;
      }
      if (readImage == null)
        throw new Error(`"${key}": images cannot be read here.`);
      try {
        slots[key] = readImage(file);
      } catch (error) {
        throw new Error(`"${key}": ${(error as Error).message}`);
      }
      continue;
    }
    if (slot.kind === "text") {
      const text = checkText(`"${key}"`, value, slot.max);
      if (text.length === 0 && slot.optional !== true)
        throw new Error(`"${key}" is required.`);
      slots[key] = text;
      continue;
    }

    if (!Array.isArray(value) || value.length === 0)
      throw new Error(`"${key}" is required: a list.`);
    if (value.length < slot.min || value.length > slot.maxItems)
      throw new Error(
        `"${key}" has ${value.length} items; use ${slot.min} to ${slot.maxItems}.`
      );

    slots[key] = value.map((item, index) => {
      // Counted from 1 in words: "steps[3]" reads as a fourth item to a model.
      const at = `${key} item ${index + 1}`;
      if (slot.fields == null) {
        const text = checkText(`"${at}"`, item, slot.max ?? 60);
        if (text.length === 0) throw new Error(`"${at}" is empty.`);
        return text;
      }
      if (item == null || typeof item !== "object")
        throw new Error(`"${at}" must be an object.`);
      const record = item as Scope;
      const out: Scope = {};
      for (const [field, spec] of Object.entries(slot.fields)) {
        if (spec.number === true) {
          const number = toNumber(record[field]);
          if (number == null || number < 0)
            throw new Error(
              `"${field}" of ${at} must be a number, zero or more.`
            );
          out[field] = number;
        } else {
          const text = checkText(
            `"${field}" of ${at}`,
            record[field],
            spec.max ?? 60
          );
          if (text.length === 0 && spec.optional !== true)
            throw new Error(`"${field}" of ${at} is required.`);
          out[field] = text;
        }
      }
      return out;
    });
  }

  return { slots, warnings };
};

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const isHex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());

const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** WCAG AA (4.5:1): a frame is seen for seconds, often on a phone in daylight. */
const readableOn = (ink: string, paper: string): boolean => {
  const [light, dark] = [luminance(ink), luminance(paper)].sort(
    (a, b) => b - a
  );
  return (light + 0.05) / (dark + 0.05) >= 4.5;
};

/** Every template's background (motion.css .bg): glows over a gradient, under grain. */
const BACKGROUND =
  '<div class="bg"><i class="glow g1"></i><i class="glow g2"></i><i class="glow g3"></i><i class="grain"></i></div>';

/** @font-face rules for the bundled families (data: URIs), by kind; "" for none. */
export type MotionFontFaces = { sans: string; serif: string; mono: string };

export const BUNDLED_FAMILY: Record<keyof MotionFontFaces, string> = {
  sans: "'Motion Sans'",
  serif: "'Motion Serif'",
  mono: "'Motion Mono'",
};

/**
 * What the bundled fonts' latin subset holds: Latin-1, general punctuation,
 * € and ™. A Turkish ğ or any other script is outside it.
 */
const BUNDLED_RANGES: Array<[number, number]> = [
  [0x0000, 0x00ff],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
];

const coveredByBundledFonts = (text: string): boolean =>
  [...text].every((ch) => {
    const code = ch.codePointAt(0)!;
    return BUNDLED_RANGES.some(([low, high]) => code >= low && code <= high);
  });

const FONTS: Record<string, string> = {
  system: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif`,
  serif: `'Iowan Old Style', Georgia, 'Times New Roman', 'Noto Serif', serif`,
  mono: `ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`,
};

// ---------------------------------------------------------------------------
// Filling a template
// ---------------------------------------------------------------------------

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] ?? ch
  );

const SECTION_RE = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

/**
 * `{{name}}` and `{{#name}}…{{/name}}`: a list repeats the section once per
 * item (its fields in scope), any other non-empty value renders it once.
 * Every value is escaped.
 */
const fillTemplate = (template: string, scope: Scope): string =>
  template
    .replace(SECTION_RE, (_whole, key: string, inner: string) => {
      const value = scope[key];
      if (Array.isArray(value))
        return value
          .map((item) => fillTemplate(inner, { ...scope, ...(item as Scope) }))
          .join("");
      return value == null || value === "" ? "" : fillTemplate(inner, scope);
    })
    .replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => escapeHtml(scope[key]));

/**
 * Shrinks any `[data-fit]` element's type until its text fits its box. Runs
 * once at load, before the first frame: a long word in a narrow 9:16 frame
 * would otherwise run off the edge. Sets `__motionReady` when done.
 */
const FIT_SCRIPT = `(() => {
  const fit = () => {
    // Measured at rest: an entrance moving a word down counts as overflow.
    const rest = document.createElement('style');
    // Words do not break while measuring, so a long word shrinks the line
    // first; breaking it is the fallback once the type is as small as allowed.
    rest.textContent = '*, *::before, *::after { animation: none !important; } [data-fit] { overflow-wrap: normal !important; }';
    document.head.append(rest);
    // Too tall only once the box has reached its max-height: below that it
    // just grows, and glyphs overhanging a tight line-height are not overflow.
    const over = (el) => {
      const cap = parseFloat(getComputedStyle(el).maxHeight);
      return el.scrollWidth > el.clientWidth + 1 ||
        (Number.isFinite(cap) && el.clientHeight >= cap - 1 && el.scrollHeight > el.clientHeight + 1);
    };
    for (const el of document.querySelectorAll('[data-fit]')) {
      let size = parseFloat(getComputedStyle(el).fontSize);
      const floor = size * 0.45;
      for (let i = 0; i < 40 && over(el) && size > floor; i++) {
        size *= 0.93;
        el.style.fontSize = size + 'px';
      }
    }
    rest.remove();
    window.__motionReady = true;
  };
  document.fonts.ready.then(fit, fit);
})();`;

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export type MotionRequest = {
  template: string;
  size: string;
  slots: Scope;
  palette?: { accent?: string; ink?: string; paper?: string };
  font?: string;
  /** How fast the whole video plays: "slow", "normal" (default) or "fast". */
  pace?: string;
  /** A length the user named, in seconds: played as close to it as still reads. */
  seconds?: number;
};

export type BuiltMotion = {
  template: string;
  size: MotionSize;
  width: number;
  height: number;
  /** The video's length: the page's, divided by timeScale. */
  seconds: number;
  /** Page seconds per video second: 1 plays as written, 1.25 a quarter faster. */
  timeScale: number;
  html: string;
  warnings: string[];
};

export const buildMotion = (
  request: MotionRequest,
  readTemplate: (name: string) => string,
  baseCss = "",
  faces: MotionFontFaces = { sans: "", serif: "", mono: "" },
  readImage?: ReadMotionImage
): BuiltMotion => {
  const name = str(request?.template);
  const template = MOTION_TEMPLATES[name];
  if (template == null)
    throw new Error(
      name === ""
        ? `"template" is required: one of ${Object.keys(MOTION_TEMPLATES).join(", ")}.`
        : `Unknown template "${name}". Use one of: ${Object.keys(MOTION_TEMPLATES).join(", ")}.`
    );

  const sizeKey = str(request.size) as MotionSize;
  if (!(sizeKey in MOTION_SIZES))
    throw new Error(`Unknown size "${sizeKey}". Use 16:9, 9:16 or 1:1.`);
  const { width, height } = MOTION_SIZES[sizeKey];

  const { slots, warnings } = validateSlots(
    name,
    template,
    request.slots != null && typeof request.slots === "object"
      ? request.slots
      : {},
    readImage
  );
  const { scope, seconds: raw } = template.prepare(slots);
  const pageSeconds = Math.round(raw * 10) / 10;
  const paceName = str(request.pace) || "normal";
  const pace = PACES[paceName];
  if (pace == null)
    throw new Error(`Unknown pace "${paceName}". Use slow, normal or fast.`);
  // A named length sets the clock instead of the pace, within slow..FASTEST.
  const wanted = toNumber(request.seconds);
  const base =
    wanted != null && wanted > 0
      ? Math.min(FASTEST, Math.max(PACES.slow!, pageSeconds / wanted))
      : pace;
  // Played faster, all of it (entrances too), rather than refused: a plan a
  // little long is still worth having. Beyond FASTEST it would not read.
  let timeScale = Math.max(base, pageSeconds / MAX_MOTION_SECONDS);
  if (timeScale > FASTEST) {
    const text = JSON.stringify(slots).length;
    const cut =
      Math.ceil(
        (text * (1 - (MAX_MOTION_SECONDS * FASTEST) / pageSeconds)) / 10
      ) * 10;
    throw new Error(
      `This would run ${s(pageSeconds / FASTEST)} s even played fast; the limit is ${MAX_MOTION_SECONDS} s. ` +
        `Cut about ${cut} characters of text, or use fewer items: each item's time comes from how much it says.`
    );
  }
  if (timeScale > base + 0.005)
    warnings.push(
      `It ran ${s(pageSeconds / base)} s, so it is played ${Math.round((timeScale / base - 1) * 100)}% faster to fit ${MAX_MOTION_SECONDS} s.`
    );
  timeScale = Math.round(timeScale * 1000) / 1000;
  const seconds = Math.round((pageSeconds / timeScale) * 10) / 10;

  const asked = request.palette ?? {};
  const own = template.palette;
  const palette: Palette = {
    accent: isHex(asked.accent) ? asked.accent.trim() : own.accent,
    ink: isHex(asked.ink) ? asked.ink.trim() : own.ink,
    paper: isHex(asked.paper) ? asked.paper.trim() : own.paper,
    // A named colour carries its companions with it, mixed in CSS.
    accent2: isHex(asked.accent)
      ? `color-mix(in oklch, ${asked.accent.trim()} 62%, #ffffff)`
      : own.accent2,
    paper2: isHex(asked.paper)
      ? `color-mix(in oklch, ${asked.paper.trim()} 82%, ${isHex(asked.accent) ? asked.accent.trim() : own.accent})`
      : own.paper2,
  };
  if (!readableOn(palette.ink, palette.paper)) {
    warnings.push(
      `The ink and paper colours did not contrast enough to read, so the template's own were used.`
    );
    palette.ink = own.ink;
    palette.paper = own.paper;
    palette.paper2 = own.paper2;
  }
  const kind = (
    ["serif", "mono"].includes(str(request.font)) ? str(request.font) : "sans"
  ) as keyof MotionFontFaces;
  // The bundled faces when they hold every letter on screen: the same look on
  // every machine. Otherwise the system's, which fall back per script.
  const bundled =
    faces[kind] !== "" &&
    coveredByBundledFonts(
      JSON.stringify(slots, (_key, value: unknown) =>
        value != null && typeof value === "object" && "src" in value
          ? ""
          : value
      )
    );
  const system = FONTS[kind === "sans" ? "system" : kind]!;
  const font = bundled ? `${BUNDLED_FAMILY[kind]},${system}` : system;

  const tokens =
    `:root{--w:${width}px;--h:${height}px;--accent:${palette.accent};--accent2:${palette.accent2};` +
    `--ink:${palette.ink};--paper:${palette.paper};--paper2:${palette.paper2};--font:${font};--total:${s(pageSeconds)}s}`;
  const title = str(slots.title) || str(slots.name) || name;
  const body = fillTemplate(readTemplate(name), scope);

  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:" />\n` +
    `<meta name="viewport" content="width=${width}, height=${height}" />\n` +
    `<title>${escapeHtml(title)}</title>\n${bundled ? `<style>${faces[kind]}</style>\n` : ""}<style>${tokens}</style>\n<style>${baseCss}</style>\n</head>\n` +
    `<body class="size-${sizeKey.replace(":", "x")}">\n${BACKGROUND}\n${body}\n<script>${FIT_SCRIPT}</script>\n</body>\n</html>\n`;

  return {
    template: name,
    size: sizeKey,
    width,
    height,
    seconds,
    timeScale,
    html,
    warnings,
  };
};
