/**
 * `page`: a reply too big for a text becomes a web page the user opens from
 * WhatsApp. The model writes structured content, never HTML; the host app
 * publishes it (POST /v1/abacusaibot_channels, action "publish_page") and the
 * link goes back in the chat.
 */
import { recordPage } from "./phone-memory.js";
import {
  type PhoneToolDefinition,
  stringParam,
  toolText,
} from "./phone-tool.js";

export interface PhonePage {
  title: string;
  kicker?: string;
  lead: string;
  sections: Array<{ heading: string; body: string }>;
  sources?: Array<{ title: string; url: string }>;
}

/** Publishes a page, or updates `pageId` in place; provided by the host app. */
export interface PagePublisher {
  publish(
    page: PhonePage,
    pageId?: string
  ): Promise<{ page_id: string; url: string }>;
}

export const PHONE_PAGE_TOOL_NAME = "page";

const LIMITS = {
  title: 120,
  kicker: 60,
  lead: 600,
  heading: 120,
  body: 6_000,
  sections: 12,
  sources: 20,
  sourceTitle: 200,
  total: 30_000,
};

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/** The page, or the first thing wrong with it in words the model can fix. */
export function validatePage(
  params: Record<string, unknown>
): PhonePage | string {
  const title = stringParam(params.title).trim();
  const kicker = stringParam(params.kicker).trim();
  const lead = stringParam(params.lead).trim();

  if (title.length === 0 || title.length > LIMITS.title)
    return `title is required, at most ${LIMITS.title} characters.`;
  if (kicker.length > LIMITS.kicker)
    return `kicker is at most ${LIMITS.kicker} characters.`;
  if (lead.length === 0 || lead.length > LIMITS.lead)
    return `lead is required, at most ${LIMITS.lead} characters.`;
  if (!Array.isArray(params.sections) || params.sections.length === 0)
    return "sections is required: at least one {heading, body}.";
  if (params.sections.length > LIMITS.sections)
    return `At most ${LIMITS.sections} sections; merge some.`;

  const sections: PhonePage["sections"] = [];

  for (const [index, raw] of params.sections.entries()) {
    const heading = stringParam(record(raw).heading).trim();
    const body = stringParam(record(raw).body).trim();

    if (heading.length === 0 || heading.length > LIMITS.heading)
      return `sections[${index}].heading is required, at most ${LIMITS.heading} characters.`;
    if (body.length === 0 || body.length > LIMITS.body)
      return `sections[${index}].body is required, at most ${LIMITS.body} characters.`;
    sections.push({ heading, body });
  }

  const total = sections.reduce(
    (sum, section) => sum + section.body.length,
    lead.length
  );

  if (total > LIMITS.total)
    return `The page is ${total} characters; keep it under ${LIMITS.total}.`;

  const sources: NonNullable<PhonePage["sources"]> = [];

  if (params.sources != null) {
    if (
      !Array.isArray(params.sources) ||
      params.sources.length > LIMITS.sources
    )
      return `sources is a list of at most ${LIMITS.sources} {title, url}.`;
    for (const [index, raw] of params.sources.entries()) {
      const sourceTitle = stringParam(record(raw).title).trim();
      const url = stringParam(record(raw).url).trim();

      if (sourceTitle.length === 0 || sourceTitle.length > LIMITS.sourceTitle)
        return `sources[${index}].title is required, at most ${LIMITS.sourceTitle} characters.`;
      if (!isHttpUrl(url))
        return `sources[${index}].url must be an http(s) URL.`;
      sources.push({ title: sourceTitle, url });
    }
  }

  return {
    title,
    ...(kicker.length > 0 ? { kicker } : {}),
    lead,
    sections,
    ...(sources.length > 0 ? { sources } : {}),
  };
}

export function buildPhonePageTool(
  dir: string,
  publisher: PagePublisher | undefined
): PhoneToolDefinition {
  return {
    name: PHONE_PAGE_TOOL_NAME,
    label: PHONE_PAGE_TOOL_NAME,
    description: [
      "Publish a web page for a reply too big for a text: an itinerary, a",
      "plan, a comparison, a guide. You write the content; the page is laid",
      "out for you. Returns its link: send it with one or two lines on what",
      "you assumed.",
      "Write sections in markdown (lists, bold, tables are fine). No HTML.",
      "To change a page you published, pass its page_id; the link stays the same.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: `Page title, at most ${LIMITS.title} characters.`,
        },
        kicker: {
          type: "string",
          description: `Optional small label above the title, e.g. "Weekend plan".`,
        },
        lead: {
          type: "string",
          description: `One or two sentences on what this is, at most ${LIMITS.lead} characters.`,
        },
        sections: {
          type: "array",
          description: `1 to ${LIMITS.sections} sections, in order.`,
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              body: { type: "string", description: "Markdown." },
            },
            required: ["heading", "body"],
          },
        },
        sources: {
          type: "array",
          description: "Optional links you relied on.",
          items: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" } },
            required: ["title", "url"],
          },
        },
        page_id: {
          type: "string",
          description:
            "Optional: the page_id of a page you published, to update it in place.",
        },
      },
      required: ["title", "lead", "sections"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      if (publisher == null) {
        return toolText(
          "Publishing pages is not available here. Send the content as a few short texts instead.",
          true
        );
      }

      const page = validatePage(params);

      if (typeof page === "string") return toolText(page, true);

      const pageId = stringParam(params.page_id).trim();
      let published: { page_id: string; url: string };

      try {
        published = await publisher.publish(
          page,
          pageId.length > 0 ? pageId : undefined
        );
      } catch (error) {
        process.stderr.write(
          `[abacusai-bot-agent] page publish failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return toolText(
          "The page could not be published right now. Try once more, or send the content as short texts.",
          true
        );
      }

      recordPage(dir, {
        page_id: published.page_id,
        title: page.title,
        url: published.url,
        updated: new Date().toISOString(),
      });

      return toolText(
        `Published: ${published.url} (page_id ${published.page_id}). Send the link with one or two lines on what you assumed.`
      );
    },
  };
}
