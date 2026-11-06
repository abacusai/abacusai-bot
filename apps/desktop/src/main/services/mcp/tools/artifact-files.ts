import fs from "node:fs/promises";
import path from "node:path";

/**
 * Artifacts on disk: `artifacts/<slug>/index.html` is the page, and each
 * change also lands in `versions/v<n>.html`. The page carries its own CSP, so
 * the rules hold wherever it opens: the panel, a browser, a shared link.
 */

const ARTIFACTS_DIR = "artifacts";
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const ARTIFACT_STYLE = `
:root{color-scheme:light;--bg:#f1f3f7;--paper:#fff;--ink:#141a2b;--soft:#566079;--line:#dde1ea;--tint:#e8ecf6;--accent:#3347e0;--good:#0c7a55;--warn:#8d5a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0f1320;--paper:#181d2d;--ink:#e9ecf5;--soft:#a2abc2;--line:#2c3348;--tint:#222942;--accent:#93a2ff;--good:#5fd3a8;--warn:#f0c26c;--bad:#ff9d92}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.page{max-width:880px;margin-inline:auto;padding:32px max(16px,env(safe-area-inset-left,0px)) 48px;display:grid;gap:20px;min-width:0}
h1,h2,h3{line-height:1.15;margin:0;text-wrap:balance}
h1{font-size:clamp(28px,5vw,40px)}h2{font-size:22px}h3{font-size:17px}
p{margin:0}img{max-width:100%;height:auto}
.eyebrow{font-size:13px;color:var(--soft)}
.lede{font-size:18px;color:var(--soft);max-width:62ch}
.note{font-size:13px;color:var(--soft)}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat span{display:block;font-size:13px;color:var(--soft)}
.stat b{font-size:26px;font-variant-numeric:tabular-nums}
.grid{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.grid th{text-align:left;font-size:13px;font-weight:500;color:var(--soft)}
.grid th,.grid td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
.chart{display:block;width:100%;height:auto}
.chart text{fill:var(--soft);font-size:11px}
button,input,select,textarea{font:inherit;color:inherit}
button{background:var(--accent);color:var(--paper);border:0;border-radius:8px;padding:8px 14px;cursor:pointer}
input,select,textarea{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:8px 10px;max-width:100%}
input[type=range]{accent-color:var(--accent);width:100%;padding:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

export const artifactDocument = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">
<title>${escapeHtml(title)}</title>
<style>${ARTIFACT_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;

export const artifactSlug = (title: string): string =>
  title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artifact";

const pagePath = (root: string, slug: string): string =>
  path.join(root, ARTIFACTS_DIR, slug, "index.html");

const versionsDir = (root: string, slug: string): string =>
  path.join(root, ARTIFACTS_DIR, slug, "versions");

const exists = (target: string): Promise<boolean> =>
  fs.access(target).then(
    () => true,
    () => false
  );

const latestVersion = async (root: string, slug: string): Promise<number> => {
  const names = await fs.readdir(versionsDir(root, slug)).catch(() => []);
  return Math.max(
    0,
    ...names.map((name) => Number(/^v(\d+)\.html$/.exec(name)?.[1] ?? 0))
  );
};

const save = async (
  root: string,
  slug: string,
  html: string
): Promise<ArtifactSaved> => {
  if (Buffer.byteLength(html) > MAX_ARTIFACT_BYTES)
    throw new ArtifactError("The page is over 5 MB. Make it smaller.");
  const version = (await latestVersion(root, slug)) + 1;
  await fs.mkdir(versionsDir(root, slug), { recursive: true });
  await fs.writeFile(pagePath(root, slug), html, "utf8");
  await fs.writeFile(
    path.join(versionsDir(root, slug), `v${version}.html`),
    html,
    "utf8"
  );
  return { path: pagePath(root, slug), slug, version };
};

export interface ArtifactSaved {
  path: string;
  slug: string;
  version: number;
}

/** A mistake the model can fix: its words go back to it as the tool's error. */
export class ArtifactError extends Error {}

export const createArtifact = async (
  root: string,
  title: string,
  body: string
): Promise<ArtifactSaved> => {
  const base = artifactSlug(title);
  let slug = base;
  for (let n = 2; await exists(pagePath(root, slug)); n += 1)
    slug = `${base}-${n}`;
  return save(root, slug, artifactDocument(title, body));
};

export const editArtifact = async (
  root: string,
  slug: string,
  edits: ReadonlyArray<{ old: string; new: string }>
): Promise<ArtifactSaved> => {
  const target = pagePath(root, artifactSlug(slug));
  if (!(await exists(target)))
    throw new ArtifactError(`There is no artifact named ${slug}.`);
  let html = await fs.readFile(target, "utf8");
  for (const edit of edits) {
    const found = html.split(edit.old).length - 1;
    if (found !== 1)
      throw new ArtifactError(
        `Each "old" must appear exactly once; this one appears ${found} times: ${edit.old.slice(0, 80)}`
      );
    html = html.replace(edit.old, () => edit.new);
  }
  return save(root, artifactSlug(slug), html);
};

export const restoreArtifact = async (
  root: string,
  slug: string,
  version: number
): Promise<ArtifactSaved> => {
  const safe = artifactSlug(slug);
  const source = path.join(versionsDir(root, safe), `v${version}.html`);
  if (!(await exists(source)))
    throw new ArtifactError(`${slug} has no version ${version}.`);
  return save(root, safe, await fs.readFile(source, "utf8"));
};
