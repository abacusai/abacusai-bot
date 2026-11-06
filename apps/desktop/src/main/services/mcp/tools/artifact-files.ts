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
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "img-src data: blob:",
  "font-src data: https://fonts.gstatic.com",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const ARTIFACT_FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,600&display=swap";

const ARTIFACT_STYLE = `
:root{color-scheme:light;--bg:#f6f7fb;--paper:#fff;--ink:#191b2e;--soft:#5d6079;--line:#dfe1ec;--tint:#ecebfc;--accent:#4a3fd1;--good:#1f6b3a;--good-tint:#e3f3e8;--warn:#8a5a00;--warn-tint:#fdf1d8;--bad:#b3261e;--bad-tint:#fbe9e7;--display:"Fraunces",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#12131f;--paper:#1a1c2c;--ink:#e8e9f4;--soft:#a0a3bd;--line:#2d3047;--tint:#2a2856;--accent:#a39cff;--good:#7fd49b;--good-tint:#17301f;--warn:#f2c063;--warn-tint:#36290f;--bad:#ff8a80;--bad-tint:#3a1d1d}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--body)}
.page{max-width:940px;margin-inline:auto;padding:32px max(16px,env(safe-area-inset-left,0px)) 64px;display:flex;flex-direction:column;gap:30px;min-width:0}
section{display:flex;flex-direction:column;gap:12px;min-width:0}
h1{font:600 clamp(28px,4vw,38px)/1.15 var(--display);margin:0;text-wrap:balance}
h2{font:600 21px/1.3 var(--display);margin:0;text-wrap:balance}
h3{font:600 15px/1.35 var(--body);margin:0}
p{margin:0;max-width:70ch}
a{color:var(--accent)}
img{max-width:100%;height:auto}
.eyebrow{font:500 12px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.lede{color:var(--ink)}
.note{font-size:13.5px;color:var(--soft)}
.card{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:14px 16px;min-width:0}
.stats{display:flex;flex-wrap:wrap;gap:10px}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px 14px;display:flex;flex-direction:column;gap:2px;min-width:150px;flex:1 1 150px}
.stat b{font:600 22px/1.2 var(--mono);font-variant-numeric:tabular-nums}
.stat span{font-size:13px;color:var(--soft)}
.bar{height:6px;background:var(--tint);border-radius:3px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.table{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
.grid{width:100%;border-collapse:collapse;font-size:14px}
.grid th,.grid td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.grid th{font:500 12px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--soft)}
.grid tr:last-child td{border-bottom:0}
.grid .n{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.pill{display:inline-block;font:500 11.5px/1 var(--mono);padding:4px 7px;border-radius:999px;white-space:nowrap;background:var(--tint);color:var(--accent)}
.pill.good{background:var(--good-tint);color:var(--good)}
.pill.warn{background:var(--warn-tint);color:var(--warn)}
.pill.bad{background:var(--bad-tint);color:var(--bad)}
.chart{display:block;width:100%;height:auto}
.chart text{fill:var(--soft);font:11px var(--mono)}
button,input,select,textarea{font:14px var(--body);color:var(--ink)}
button{background:var(--accent);color:var(--paper);border:0;border-radius:6px;padding:7px 12px;cursor:pointer}
input,select,textarea{background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:7px 10px;max-width:100%}
input[type=range]{accent-color:var(--accent);width:100%;padding:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
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
<link rel="stylesheet" href="${ARTIFACT_FONTS}">
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
