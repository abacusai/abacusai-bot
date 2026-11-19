/**
 * The designs the deck and document tools can print, as the templates
 * gallery shows them. A pick drops an ask naming the design into the
 * composer. A named deck template prints on the template path (packages/agent
 * deck-tool.ts; slugs from apps/desktop/resources/decks/templates.json); a
 * document design is the design system's data-design (docs-system/designs/).
 *
 * Names are product names and stay as they are; the asks are not translated,
 * like the session starters: they land in the composer for the user to edit.
 */

// Files, never inlined: 70 small thumbnails inlined as base64 put 280 KB of
// text in the renderer's JavaScript.
const thumbs = import.meta.glob<string>("../../assets/templates/*.webp", {
  eager: true,
  import: "default",
  query: "?no-inline",
});

const thumb = (name: string): string =>
  thumbs[`../../assets/templates/${name}.webp`] ?? "";

export type TemplateKind = "deck" | "document";

export interface TemplateEntry {
  /** The slug the tool knows it by; also the i18n key under templates.items. */
  id: string;
  kind: TemplateKind;
  /** Documents: the type the design is for (resume, invoice, …), shown as a heading. */
  group?: string;
  name: string;
  /** The cover, then (decks) two slides. */
  images: string[];
  /** Portrait page, landscape sheet or slide. */
  shape: "slide" | "page" | "sheet";
  /** Lands in the composer; the user finishes the sentence. */
  ask: string;
}

const deck = (id: string, name: string): TemplateEntry => ({
  id,
  kind: "deck",
  name,
  images: [0, 1, 2].map((index) => thumb(`deck-${id}-${index}`)),
  shape: "slide",
  ask: `Make a presentation in the ${id} template about `,
});

/** A document design: the type's own layout ("classic") or one of its designs. */
const ASKS: Record<string, string> = {
  resume: "Make a one-page CV",
  certificate: "Make a certificate",
  invoice: "Make an invoice",
  report: "Write a report",
  flyer: "Make a flyer",
  invitation: "Make an invitation",
  letter: "Write a letter",
  proposal: "Write a proposal",
};
const docDesign = (type: string, id: string, name: string): TemplateEntry => ({
  id,
  kind: "document",
  group: type,
  name,
  images: [thumb(`doc-${id}`)],
  shape: type === "certificate" ? "sheet" : "page",
  ask: `${ASKS[type] ?? "Make a document"} in the ${name} design, `,
});
const docType = (type: string, designs: Array<[string, string]>) => [
  docDesign(type, `${type}-classic`, "Classic"),
  ...designs.map(([id, name]) => docDesign(type, id, name)),
];

export const TEMPLATES: readonly TemplateEntry[] = [
  deck("classroom", "Classroom"),
  deck("daisy-days", "Daisy Days"),
  deck("status-report", "Status Report"),
  deck("block-frame", "BlockFrame"),
  deck("storefront", "Storefront"),
  deck("grove", "Grove"),
  deck("capsule", "Capsule"),
  deck("emerald-editorial", "Emerald Editorial"),
  deck("monochrome", "Monochrome"),
  deck("coral", "Coral"),
  deck("retro-zine", "Retro Zine"),
  deck("studio", "Studio"),
  deck("broadside", "Broadside"),
  deck("biennale-yellow", "Biennale Yellow"),
  deck("creative-mode", "Creative Mode"),
  deck("editorial-tri-tone", "Editorial Tri-Tone"),
  deck("mat", "Mat"),
  deck("vellum", "Vellum"),
  deck("peoples-platform", "People's Platform"),
  deck("scatterbrain", "Scatterbrain"),
  deck("playful", "Playful"),
  deck("bold-poster", "Bold Poster"),
  deck("pink-script", "Pink Script \u2014 After Hours"),
  deck("stencil-tablet", "Stencil & Tablet"),
  deck("editorial-forest", "Editorial Forest"),
  deck("soft-editorial", "Soft Editorial"),
  deck("pin-and-paper", "Pin & Paper"),
  deck("signal", "Signal"),
  deck("cobalt-grid", "Cobalt Grid"),
  deck("cartesian", "Cartesian"),
  deck("8-bit-orbit", "8-Bit Orbit"),
  deck("retro-windows", "Retro Windows"),
  deck("long-table", "Long Table"),
  deck("sakura-chroma", "Sakura Chroma"),
  deck("neo-grid-bold", "Neo-Grid Bold"),
  deck("raw-grid", "Raw Grid"),
  deck("blue-professional", "Blue Professional"),
  ...docType("resume", [
    ["resume-harbour", "Harbour"],
    ["resume-folio", "Folio"],
    ["resume-signal", "Beacon"],
  ]),
  ...docType("certificate", [
    ["certificate-heritage", "Heritage"],
    ["certificate-linen", "Linen"],
    ["certificate-meridian", "Meridian"],
  ]),
  ...docType("invoice", [
    ["invoice-banner", "Banner"],
    ["invoice-ledger", "Tally"],
    ["invoice-studio", "Studio"],
  ]),
  ...docType("report", [
    ["report-journal", "Journal"],
    ["report-boardroom", "Boardroom"],
    ["report-schematic", "Schematic"],
  ]),
  ...docType("flyer", [
    ["flyer-blast", "Blast"],
    ["flyer-atelier", "Atelier"],
    ["flyer-fiesta", "Fiesta"],
  ]),
  ...docType("invitation", [
    ["invitation-vows", "Vows"],
    ["invitation-confetti", "Confetti"],
    ["invitation-soiree", "Soirée"],
  ]),
  ...docType("letter", [
    ["letter-letterhead", "Letterhead"],
    ["letter-margin", "Margin"],
    ["letter-engraved", "Engraved"],
  ]),
  ...docType("proposal", [
    ["proposal-agency", "Agency"],
    ["proposal-consult", "Consult"],
    ["proposal-studio", "Studio"],
  ]),
];
