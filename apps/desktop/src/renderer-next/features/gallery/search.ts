/**
 * The `/__ui` gallery's sections and overlay examples (spec 01 §10.1). One
 * section per installed `ui/` file plus tokens, shell, occlusion and motion.
 */
import * as v from "valibot";

import { optionalField } from "#next/lib/navigation/search";

const ATOM_SECTIONS = [
  "button",
  "dialog",
  "alert-dialog",
  "sheet",
  "drawer",
  "tabs",
  "dropdown-menu",
  "context-menu",
  "popover",
  "tooltip",
  "hover-card",
  "combobox",
  "command",
  "resizable",
  "scroll-area",
  "kbd",
  "field",
  "label",
  "input",
  "input-group",
  "textarea",
  "item",
  "empty",
  "spinner",
  "skeleton",
  "separator",
  "badge",
  "avatar",
  "toggle",
  "toggle-group",
  "switch",
  "select",
  "native-select",
  "toast",
  "message-scroller",
  "message",
  "bubble",
  "attachment",
  "marker",
  "questionnaire",
  "collapsible",
] as const;

export const GALLERY_SECTIONS = [
  "tokens",
  ...ATOM_SECTIONS,
  "shell",
  "occlusion",
  "motion",
] as const;
export type GallerySection = (typeof GALLERY_SECTIONS)[number];

/** One open overlay at a time (Codex r2 #14): `?open=<id>`. */
export const GALLERY_OVERLAY_IDS = [
  "dialog",
  "alert-dialog",
  "sheet",
  "drawer",
  "dropdown-menu",
  "context-menu",
  "popover",
  "tooltip",
  "hover-card",
  "combobox",
  "command",
  "select",
] as const;
export type GalleryOverlayId = (typeof GALLERY_OVERLAY_IDS)[number];

/** Which section each overlay example lives in. */
export const OVERLAY_SECTION: Record<GalleryOverlayId, GallerySection> = {
  dialog: "dialog",
  "alert-dialog": "alert-dialog",
  sheet: "sheet",
  drawer: "drawer",
  "dropdown-menu": "dropdown-menu",
  "context-menu": "context-menu",
  popover: "popover",
  tooltip: "tooltip",
  "hover-card": "hover-card",
  combobox: "combobox",
  command: "command",
  select: "select",
};

export const GallerySearch = v.object({
  section: optionalField(v.picklist(GALLERY_SECTIONS)),
  theme: v.optional(
    v.fallback(v.picklist(["app", "light", "dark"]), "app"),
    "app"
  ),
  open: optionalField(v.picklist(GALLERY_OVERLAY_IDS)),
});
export type GallerySearchValue = v.InferOutput<typeof GallerySearch>;

export const galleryEnabled = (): boolean =>
  import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1";
