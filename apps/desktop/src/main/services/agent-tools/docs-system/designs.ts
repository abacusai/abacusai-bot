/**
 * Document designs: fixed designs per document type (resources/docs-system/
 * designs/<type>.css + <type>.json), applied by data-design on the page over
 * the type's own markup. The bot picks one from the list the guide carries;
 * the user switches with "Try another look" (relook.ts), a reprint.
 */
import { readFileSync } from "fs";
import path from "path";

import { resourcePath } from "#main/resources";

export const DOC_TYPES = [
  "resume",
  "certificate",
  "invoice",
  "report",
  "flyer",
  "invitation",
  "letter",
  "proposal",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export type DocDesign = { id: string; name: string; blurb: string };

/** The listed designs of a type; the type's own layout ("classic") is implicit. */
export const designsOf = (type: DocType): DocDesign[] => {
  try {
    const list = JSON.parse(
      readFileSync(
        path.join(resourcePath("docs-system"), "designs", `${type}.json`),
        "utf8"
      )
    ) as DocDesign[];
    return Array.isArray(list)
      ? list.filter(
          (d) => typeof d?.id === "string" && d.id.startsWith(`${type}-`)
        )
      : [];
  } catch {
    return [];
  }
};

/** Which type a page is, from its markup and words. */
export const docTypeOf = (html: string): DocType => {
  const text = html.replace(/<[^>]+>/g, " ").slice(0, 4000);
  if (/class="[^"]*\bcv-(head|body)\b/.test(html)) return "resume";
  if (/class="[^"]*\bcertificate\b/.test(html)) return "certificate";
  if (/class="[^"]*\bletter\b/.test(html)) return "letter";
  if (/class="[^"]*\binvite\b/.test(html)) return "invitation";
  // A proposal may open on a poster-like cover: its title says what it is.
  const title = `${/<title>([^<]*)/i.exec(html)?.[1] ?? ""} ${(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " ")}`;
  if (/\bproposal\b/i.test(title)) return "proposal";
  if (/class="[^"]*\bposter\b/.test(html))
    return /\b(invit|party|birthday|wedding|rsvp|celebrat|anniversary)/i.test(
      text
    )
      ? "invitation"
      : "flyer";
  if (/\bproposal\b/i.test(text)) return "proposal";
  if (
    /data-role="total"/.test(html) ||
    /\b(invoice|quote|quotation|estimate|or[çc]amento|factura|fatura|rechnung|devis)\b/i.test(
      text
    )
  )
    return "invoice";
  return "report";
};

/** The guide's list of designs, for the bot's pick (docs_guide). */
export const designsGuide = (): string => {
  const lines = DOC_TYPES.map((type) => {
    const list = designsOf(type);
    return list.length === 0
      ? null
      : `- ${type}: ${list.map((d) => `\`${d.id}\` (${d.blurb})`).join("; ")}${type === "certificate" || type === "invitation" ? "; always pick one of these." : "; or leave it out for the classic layout."}`;
  }).filter((line): line is string => line != null);
  return lines.length === 0
    ? ""
    : [
        "",
        "## Designs",
        'Pick the design that suits this document and set it on `<html data-design="…">` (it changes the whole page\'s design; the markup stays as above). If the user named one, use it.',
        ...lines,
      ].join("\n");
};
