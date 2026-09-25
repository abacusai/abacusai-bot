/**
 * The design component: a brief in, a canvas of mockups out.
 *
 * The model chooses palette, screens, blocks and copy; it never writes markup.
 * Each block comes from a catalog and the renderer fills it, which is what
 * keeps the output looking designed rather than generated. Screens are
 * fixed-size frames on one canvas, each also exported as a PNG.
 */
import fs from "fs/promises";
import path from "path";

import { BrowserWindow } from "electron";

import { resourcePath } from "#main/resources";

import { resolveChatEndpoint, type ChatEndpoint } from "./chat-endpoint";

const MAX_SCREENS = 8;

export type DesignRequest = {
  context: string;
  outputDir: string;
  screens?: number;
  /** `high` is a finished-looking mockup; `wire` is a greyscale wireframe. */
  fidelity?: "high" | "wire";
  device?: "desktop" | "phone" | "both";
};

export type DesignResult = {
  canvasPath: string;
  directory: string;
  name: string;
  /** `png` is empty for a screen whose export failed. The HTML is still there. */
  screens: Array<{ id: string; title: string; frame: string; png: string }>;
  palette: string;
  fidelity: string;
  model: string;
  seconds: number;
  /** Screens that did not export, so the caller can say so. */
  warnings: string[];
};

type CatalogComponent = {
  name: string;
  category: string;
  frames: string;
  description: string;
  slots: Record<string, string>;
  html: string;
};

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const designDir = async (): Promise<string> => {
  const dir = resourcePath("design");
  const present = await fs
    .stat(path.join(dir, "catalog.json"))
    .then(() => true)
    .catch(() => false);

  if (!present) {
    throw new Error("The bundled design catalog is missing from this build.");
  }

  return dir;
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const chatEndpoint = (): ChatEndpoint => resolveChatEndpoint("Designing");

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch
  );

/**
 * Fills one catalog block. `{{name}}`, `{{.}}` and `{{#list}}…{{/list}}` cover
 * every block; every value is escaped, so model output cannot alter a screen's
 * structure. Recursive because blocks nest (a footer is columns of links).
 */
const SECTION_RE = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

const renderTemplate = (
  template: string,
  scope: Record<string, unknown>
): string =>
  template
    .replace(SECTION_RE, (_whole, key: string, inner: string) => {
      const list = scope[key];
      if (!Array.isArray(list)) return "";

      // Bar heights are relative to the tallest value in the same list, so the
      // peak is computed once for the whole section rather than per item.
      const peak = Math.max(
        ...list.map(
          (entry) => Number((entry as Record<string, unknown>)?.value) || 0
        ),
        1
      );

      return list
        .map((item, index) => {
          if (item != null && typeof item === "object") {
            const record = item as Record<string, unknown>;
            // `initial` and `pct` are presentation, derived here rather than
            // asked of the model, which would supply them inconsistently.
            const child: Record<string, unknown> = {
              ...scope,
              ...record,
              index: index + 1,
              initial: String(
                record.title ?? record.name ?? record.label ?? "•"
              )
                .trim()
                .charAt(0)
                .toUpperCase(),
            };
            if (record.value != null) {
              child.pct = Math.max(
                6,
                Math.round(((Number(record.value) || 0) / peak) * 100)
              );
            }
            return renderTemplate(inner, child);
          }
          return renderTemplate(inner, {
            ...scope,
            ".": item,
            index: index + 1,
          });
        })
        .join("");
    })
    .replace(/\{\{\.\}\}/g, escapeHtml(scope["."] ?? ""))
    .replace(/\{\{(\w+)\}\}/g, (_whole, key: string) =>
      escapeHtml(scope[key] ?? "")
    );

const renderBlock = (
  template: string,
  slots: Record<string, unknown>
): string => renderTemplate(template, slots);

/**
 * Gives every structural element a stable id, so a later edit can address one
 * element without re-rendering the screen.
 */
const withDesignIds = (html: string, screenId: string): string => {
  let counter = 0;
  // Tag names only: matching into an attribute list would insert the id inside
  // another attribute and silently break the layout.
  return html.replace(
    /<(nav|header|footer|main|aside|section|article|form|table)(?=[\s>])/g,
    (whole, tag: string) => {
      counter += 1;
      return `${whole} data-design-id="${screenId}-${tag}-${counter}"`;
    }
  );
};

type Screen = {
  id: string;
  title: string;
  frame: string;
  blocks: Array<{ component: string; slots: Record<string, unknown> }>;
};

const renderScreen = (
  screen: Screen,
  catalog: Map<string, CatalogComponent>,
  fidelity: string
): string => {
  const body = screen.blocks
    .map((block) => {
      const component = catalog.get(block.component);
      if (component == null) return "";
      return renderBlock(component.html, block.slots ?? {});
    })
    .join("\n");

  const classes = [
    "frame",
    screen.frame === "phone" ? "phone" : "desktop",
    fidelity === "wire" ? "wire" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<div class="${classes}" id="${escapeHtml(screen.id)}">\n${withDesignIds(body, screen.id)}\n</div>`;
};

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * The catalog as the planning sub-agent sees it: everything except the markup,
 * because an agent holding the markup will eventually be asked to adjust it.
 */
export type DesignCatalogEntry = Omit<CatalogComponent, "html">;

export type DesignPlan = {
  name?: string;
  palette?: Record<string, string>;
  font?: string;
  screens?: Screen[];
};

export type RenderDesignRequest = {
  plan: DesignPlan;
  outputDir: string;
  fidelity?: "high" | "wire";
  device?: "desktop" | "phone" | "both";
};

/** The block vocabulary, for a caller that has to choose from it. */
export const designCatalog = async (): Promise<{
  components: DesignCatalogEntry[];
}> => {
  const resources = await designDir();
  const parsed = JSON.parse(
    await fs.readFile(path.join(resources, "catalog.json"), "utf8")
  ) as {
    components: CatalogComponent[];
  };

  return {
    components: parsed.components.map(({ html: _html, ...rest }) => rest),
  };
};

/**
 * Renders a design from a plan somebody else made: writes the canvas, the
 * per-screen HTML and a PNG of each frame. The plan is validated, not trusted:
 * ids become file names, and a block naming an unknown component is dropped.
 */
export const renderDesign = async (
  request: RenderDesignRequest
): Promise<DesignResult> => {
  const startedAt = Date.now();
  const resources = await designDir();
  const catalogJson = JSON.parse(
    await fs.readFile(path.join(resources, "catalog.json"), "utf8")
  ) as {
    components: CatalogComponent[];
  };
  const catalog = new Map(
    catalogJson.components.map((component) => [component.name, component])
  );

  const fidelity = request.fidelity ?? "high";
  const plan = request.plan ?? {};

  const screens = (Array.isArray(plan.screens) ? plan.screens : [])
    .filter(
      (screen) =>
        screen != null &&
        Array.isArray(screen.blocks) &&
        screen.blocks.length > 0
    )
    .slice(0, MAX_SCREENS);
  if (screens.length === 0)
    throw new Error("The design plan contained no usable screens.");

  // The id becomes a file name: slugified against "../evil", deduplicated
  // against two screens called "home".
  const seenIds = new Set<string>();
  screens.forEach((screen, index) => {
    const slug = String(screen.id ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const base = slug.length > 0 ? slug : `screen-${index + 1}`;
    let unique = base;
    for (let n = 2; seenIds.has(unique); n++) unique = `${base}-${n}`;
    seenIds.add(unique);
    screen.id = unique;
  });

  const directory = path.resolve(request.outputDir);
  await fs.mkdir(path.join(directory, "screens"), { recursive: true });
  await fs.copyFile(
    path.join(resources, "mockup.css"),
    path.join(directory, "mockup.css")
  );

  const palette = plan.palette ?? {};
  const fontStack =
    plan.font === "serif"
      ? `'Iowan Old Style', Georgia, serif`
      : plan.font === "mono"
        ? `ui-monospace, 'SF Mono', Menlo, monospace`
        : `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

  const hex = (value: unknown, fallback: string): string =>
    typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value.trim())
      ? value.trim()
      : fallback;

  const tokens = `:root{
  --accent:${hex(palette.accent, "#1f5eff")};
  --ink:${hex(palette.ink, "#101319")};
  --paper:${hex(palette.paper, "#ffffff")};
  --surface:${hex(palette.surface, "#f6f7f9")};
  --font:${fontStack};
  --font-display:${fontStack};
}`;

  const head = (title: string, extra = ""): string =>
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<title>${escapeHtml(title)}</title>\n` +
    `<link rel="stylesheet" href="${extra}mockup.css" />\n<style>${tokens}</style>\n</head>\n`;

  // Each screen is also a standalone file, so a single screen can be opened,
  // shared or edited without the rest of the canvas.
  const rendered: DesignResult["screens"] = [];
  for (const screen of screens) {
    const html = renderScreen(screen, catalog, fidelity);
    await fs.writeFile(
      path.join(directory, "screens", `${screen.id}.html`),
      `${head(screen.title ?? screen.id, "../")}<body style="background:var(--surface);padding:0">\n${html}\n</body>\n</html>\n`,
      "utf8"
    );
    rendered.push({
      id: screen.id,
      title: screen.title ?? screen.id,
      frame: screen.frame ?? "desktop",
      png: "",
    });
  }

  const canvas =
    `${head(plan.name ?? "Design")}<body style="background:#eceef1;padding:56px">\n` +
    `<div style="max-width:none;display:flex;flex-direction:column;gap:56px;align-items:flex-start">\n` +
    `<div style="font:600 22px var(--font);color:#101319">${escapeHtml(plan.name ?? "Design")}</div>\n` +
    screens
      .map((screen) => {
        const label = `<div style="font:550 12px var(--font);color:#6b7280;margin-bottom:10px">${escapeHtml(screen.title ?? screen.id)}</div>`;
        return `<div>${label}<div style="box-shadow:0 20px 60px rgba(16,19,25,0.13)">${renderScreen(screen, catalog, fidelity)}</div></div>`;
      })
      .join("\n") +
    `\n</div>\n</body>\n</html>\n`;

  const canvasPath = path.join(directory, "canvas.html");
  await fs.writeFile(canvasPath, canvas, "utf8");

  // Export each frame. A failure is reported, not thrown: the canvas and every
  // screen's HTML are already on disk and can be opened right now.
  const warnings: string[] = [];
  const win = new BrowserWindow({
    show: false,
    width: 1500,
    height: 1000,
    useContentSize: true,
  });
  try {
    for (const screen of rendered) {
      try {
        const file = path.join(directory, "screens", `${screen.id}.html`);
        await win.loadFile(file);
        await win.webContents.executeJavaScript(
          `new Promise((r) => setTimeout(r, 250))`,
          true
        );

        const box = (await win.webContents.executeJavaScript(`
          (() => {
            const frame = document.querySelector('.frame');
            if (frame == null) return null;
            const rect = frame.getBoundingClientRect();
            return { w: Math.ceil(rect.width), h: Math.ceil(rect.height), text: document.body.innerText.trim().length };
          })()
        `)) as { w: number; h: number; text: number } | null;

        if (box == null || box.text < 20) {
          warnings.push(
            `screen "${screen.id}" rendered empty and was not exported as a PNG`
          );
          continue;
        }

        win.setContentSize(Math.min(1600, box.w), Math.min(2400, box.h));
        await win.webContents.executeJavaScript(
          `new Promise((r) => setTimeout(r, 150))`,
          true
        );

        // setContentSize clamps, and a capture rect larger than the page comes
        // back truncated or blank; never ask for more than the window is now.
        const [contentWidth, contentHeight] = win.getContentSize();
        const image = await win.webContents.capturePage({
          x: 0,
          y: 0,
          width: Math.max(1, Math.min(box.w, contentWidth)),
          height: Math.max(1, Math.min(box.h, contentHeight)),
        });
        const png = path.join(directory, "screens", `${screen.id}.png`);
        await fs.writeFile(png, image.toPNG());
        screen.png = png;
      } catch (error) {
        warnings.push(
          `screen "${screen.id}" could not be exported as a PNG: ${(error as Error).message}`
        );
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }

  return {
    canvasPath,
    directory,
    name: plan.name ?? "Design",
    screens: rendered,
    palette: hex(palette.accent, "#1f5eff"),
    fidelity,
    model: chatEndpoint().model,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    warnings,
  };
};
