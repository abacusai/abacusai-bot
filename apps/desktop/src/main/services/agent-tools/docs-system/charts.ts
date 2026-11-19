/**
 * Charts and diagrams drawn in code from the user's own numbers. In round 1
 * only the strong model drew a diagram (supply and demand); the templates and
 * forms could not. The model writes data, this draws it.
 *
 * <figure class="chart" data-chart="bar" data-values='[["Q2",171900],["Q3",186400]]'
 *         data-prefix="£" data-suffix=""><figcaption>…</figcaption></figure>
 * <figure class="chart" data-chart="lines" data-axes='["Quantity (Q)","Price (P)"]'
 *         data-lines='[{"label":"D","points":[[0,50],[100,0]]},{"label":"S","points":[[20,0],[100,40]]}]'
 *         data-points='[{"x":60,"y":20,"label":"E (Q 60, P 20)"}]'
 *         data-hlines='[{"y":15,"label":"ceiling"}]'></figure>
 *
 * Self-contained: serialised with Function.prototype.toString.
 */
/**
 * A report with figures and no chart at all: sent back once. A chart the app
 * chose to print as numbers (two values) counts as one (R5 live: "There is no
 * chart" sent a deck back twice when every chart had one or two values).
 */
export const missingChart = (o: {
  genre: string;
  drawn: number;
  asNumbers: number;
  briefNumbers: number[];
}): boolean =>
  o.genre === "report" &&
  o.drawn === 0 &&
  o.asNumbers === 0 &&
  new Set(o.briefNumbers.filter((n) => n > 20)).size >= 4;

export function drawCharts(doc: Document): {
  drawn: number;
  failed: string[];
  computed: number[];
  asNumbers: number;
  shares: number[];
} {
  const computed: number[] = [];
  // Each share chart's given parts, checked against the request (make.ts).
  const shares: number[] = [];
  const failed: string[] = [];
  let drawn = 0;
  let numbered = 0;
  const win = doc.defaultView!;
  const accent =
    win
      .getComputedStyle(doc.documentElement)
      .getPropertyValue("--accent")
      .trim() || "#0f6e6a";
  const ink = "#17191c";
  const muted = "#5b616b";
  const line = "#c9cdd3";
  const escHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // In SVG, sub- and superscript characters become shifted digits in the
  // chart's own font: no bundled face has them, and "D₁" printed in
  // LiberationSans-Bold (R5b live). Self-contained, like the rest.
  const SUBS = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₙₜ";
  const SUBP = "0123456789+\u2212=()aeoxnt";
  const SUPS = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ";
  const SUPP = "0123456789+\u2212=()ni";
  const esc = (s: string): string =>
    escHtml(s)
      .replace(
        /[₀-₉₊₋₌₍₎ₐₑₒₓₙₜ]+/g,
        (m) =>
          `<tspan baseline-shift="sub" font-size="75%">${Array.from(m)
            .map((c) => SUBP[SUBS.indexOf(c)] ?? c)
            .join("")}</tspan>`
      )
      .replace(
        /[⁰¹²³⁴-⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g,
        (m) =>
          `<tspan baseline-shift="super" font-size="75%">${Array.from(m)
            .map((c) => SUPP[SUPS.indexOf(c)] ?? c)
            .join("")}</tspan>`
      );
  const fmt = (n: number): string => {
    const lang = doc.documentElement.getAttribute("lang") || "en-GB";
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
  };
  const parse = (el: Element, name: string): unknown => {
    const raw = el.getAttribute(name);
    if (raw == null) return null;
    return JSON.parse(raw);
  };
  const palette = [accent, "#b4521c", "#3a3fb0", "#2f7a3d", "#7a2e6b"];
  const chartFit =
    parseFloat(
      win.getComputedStyle(doc.documentElement).getPropertyValue("--chart-fit")
    ) || 1;
  const squash = (t: string): string => t.replace(/\s+/g, "");

  // Two values, or a whole in two parts, are numbers, not a chart (round 4: a
  // thin two-part revenue bar; two bars repeating the tiles beside them). When
  // the numbers are already written nearby the figure goes; otherwise they
  // print as figures.
  const asNumbers = (fig: Element, items: Array<[string, string]>): void => {
    numbered++;
    const scope = fig.closest("section.slide") ?? fig.parentElement ?? doc.body;
    let around = "";
    const walk = doc.createTreeWalker(scope, 4 /* SHOW_TEXT */);
    for (let n = walk.nextNode(); n; n = walk.nextNode())
      // Only what prints: speaker notes are not on the slide (R5b live).
      if (!fig.contains(n) && !n.parentElement?.closest(".notes"))
        around += n.textContent || "";
    // No number twice on one slide (round 5: 64% in a tile and again
    // beside it): only what is not already shown is printed.
    const fresh = items.filter(([, v]) => !squash(around).includes(squash(v)));
    if (fresh.length === 0) {
      fig.remove();
      return;
    }
    const caption = fig.querySelector("figcaption");
    fig.innerHTML = `<div class="figures">${fresh
      .map(
        ([label, value]) =>
          `<div><span class="value">${escHtml(value)}</span><span class="label">${escHtml(label)}</span></div>`
      )
      .join("")}</div>`;
    if (caption) fig.appendChild(caption);
    fig.classList.add("as-numbers");
  };

  for (const fig of Array.from(
    doc.querySelectorAll("figure.chart[data-chart]")
  )) {
    const kind = fig.getAttribute("data-chart");
    const onSlide = fig.closest("section.slide") != null;
    // Beside text in a split, a chart gets a taller shape to fill its column.
    const inSplit = fig.closest(".split") != null;
    // A half-width dashboard panel gets a taller shape, like a split column
    // (overnight: a bar chart there printed a third as tall as wide).
    const inPanel = fig.closest(".dash > .panel:not(.wide)") != null;
    // A document's chart is drawn at the width it prints, so its type is
    // the size it says (round 4: diagrams beside text printed at ~6.5 pt).
    const printed = onSlide ? 0 : fig.getBoundingClientRect().width;
    const font = onSlide ? 24 : printed > 0 ? 14 : 12;
    // Bar and growth charts share one shape.
    const seriesW = onSlide
      ? inSplit
        ? 640
        : 1000
      : printed > 0
        ? printed
        : inSplit
          ? 420
          : 600;
    const seriesH = onSlide
      ? inSplit
        ? 540
        : 440
      : printed > 0
        ? inPanel
          ? Math.min(seriesW * 0.8, 300 * chartFit)
          : Math.min(seriesW * 0.5, 280 * chartFit)
        : inSplit
          ? 300
          : 240;
    try {
      let svg = "";
      let after = "";
      if (kind === "label") {
        // A picture for pupils to label (showcase u02: "label the diagram"
        // printed a row of dots). Shapes in a 100 x 60 box, x right, y down;
        // the app numbers each mark and writes an answer line for it.
        const shapes = parse(fig, "data-shapes") as Array<
          Record<string, unknown>
        >;
        const marks = parse(fig, "data-marks") as Array<[number, number]>;
        if (!Array.isArray(shapes) || shapes.length === 0)
          throw new Error(
            'label needs data-shapes=\'[{"circle":[x,y,r]}, {"rect":[x,y,w,h]}, …]\' in a 100 x 60 box'
          );
        if (!Array.isArray(marks) || marks.length === 0 || marks.length > 12)
          throw new Error("label needs data-marks='[[x,y], …]', 1 to 12 marks");
        marks.forEach((m, i) => {
          const [x, y] = m.map(Number) as [number, number];
          if (!(x >= 0 && x <= 100 && y >= 0 && y <= 60))
            throw new Error(
              `mark ${i + 1} (${x}, ${y}) is outside the drawing (x 0-100, y 0-60)`
            );
          marks.slice(0, i).forEach((o, j) => {
            if (Math.hypot(Number(o[0]) - x, Number(o[1]) - y) < 4)
              throw new Error(
                `marks ${j + 1} and ${i + 1} are too close to tell apart; point each at its own part`
              );
          });
        });
        const letters = fig.getAttribute("data-mark-style") === "letters";
        const name = (i: number): string =>
          letters ? String.fromCharCode(65 + i) : String(i + 1);
        const W = onSlide
          ? inSplit
            ? 640
            : 1000
          : Math.min(printed > 0 ? printed : 560, 560);
        const k = W / 100;
        const H = 60 * k;
        const stroke = onSlide ? 3 : 2;
        const fillOf = (f: unknown): string =>
          f === "dark" ? ink : f === "light" ? "#e9ecef" : "none";
        const num = (v: unknown, i: number): number => {
          const n = Array.isArray(v) ? Number(v[i]) : NaN;
          if (!Number.isFinite(n))
            throw new Error(`a shape has a coordinate that is not a number`);
          return n * k;
        };
        // What is drawn, so the picture is cropped to it (live u02: a row of
        // planets printed as a small strip in a mostly empty box). Rings
        // (orbits) are outlines and do not widen it.
        const ext = {
          x0: Infinity,
          y0: Infinity,
          x1: -Infinity,
          y1: -Infinity,
        };
        const grow = (x: number, y: number, rx: number, ry = rx): void => {
          ext.x0 = Math.min(ext.x0, x - rx);
          ext.y0 = Math.min(ext.y0, y - ry);
          ext.x1 = Math.max(ext.x1, x + rx);
          ext.y1 = Math.max(ext.y1, y + ry);
        };
        for (const sh of shapes) {
          const fill = fillOf(sh.fill);
          const textFill = sh.fill === "dark" ? "#fff" : ink;
          let cx = NaN;
          let cy = NaN;
          if (sh.circle) {
            cx = num(sh.circle, 0);
            cy = num(sh.circle, 1);
            svg += `<circle cx="${cx}" cy="${cy}" r="${num(sh.circle, 2)}" fill="${fill}" stroke="${ink}" stroke-width="${stroke}"/>`;
            grow(cx, cy, num(sh.circle, 2) + stroke);
          } else if (sh.ring) {
            cx = num(sh.ring, 0);
            cy = num(sh.ring, 1);
            grow(cx, cy, 0);
            svg += `<circle cx="${cx}" cy="${cy}" r="${num(sh.ring, 2)}" fill="none" stroke="${muted}" stroke-width="${stroke / 2}" stroke-dasharray="${stroke * 2} ${stroke * 2}"/>`;
          } else if (sh.ellipse) {
            cx = num(sh.ellipse, 0);
            cy = num(sh.ellipse, 1);
            svg += `<ellipse cx="${cx}" cy="${cy}" rx="${num(sh.ellipse, 2)}" ry="${num(sh.ellipse, 3)}" fill="${fill}" stroke="${ink}" stroke-width="${stroke}"/>`;
            grow(
              cx,
              cy,
              num(sh.ellipse, 2) + stroke,
              num(sh.ellipse, 3) + stroke
            );
          } else if (sh.rect) {
            const [x, y, w, h] = [0, 1, 2, 3].map((i) => num(sh.rect, i)) as [
              number,
              number,
              number,
              number,
            ];
            cx = x + w / 2;
            cy = y + h / 2;
            svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${ink}" stroke-width="${stroke}"/>`;
            grow(cx, cy, w / 2 + stroke, h / 2 + stroke);
          } else if (sh.line || sh.arrow) {
            const v = sh.line ?? sh.arrow;
            const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => num(v, i)) as [
              number,
              number,
              number,
              number,
            ];
            svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ink}" stroke-width="${stroke}"/>`;
            grow(x1, y1, stroke * 5);
            grow(x2, y2, stroke * 5);
            if (sh.arrow) {
              const a = Math.atan2(y2 - y1, x2 - x1);
              const l = stroke * 5;
              svg += `<polygon points="${x2},${y2} ${x2 - l * Math.cos(a - 0.4)},${y2 - l * Math.sin(a - 0.4)} ${x2 - l * Math.cos(a + 0.4)},${y2 - l * Math.sin(a + 0.4)}" fill="${ink}"/>`;
            }
            cx = (x1 + x2) / 2;
            cy = (y1 + y2) / 2 - font * 0.6;
          } else
            throw new Error(
              "each shape is one of circle, ring, ellipse, rect, line or arrow"
            );
          if (typeof sh.text === "string" && sh.text.trim() !== "")
            svg += `<text x="${cx}" y="${cy + font * 0.35}" text-anchor="middle" font-size="${font}" font-weight="600" fill="${textFill}">${esc(sh.text.trim())}</text>`;
        }
        // Each mark: a dot, a leader up to a numbered badge (down when there
        // is no room above), badges kept apart.
        const r = font * 0.8;
        const placed: Array<[number, number]> = [];
        marks.forEach((m, i) => {
          const x = Number(m[0]) * k;
          const y = Number(m[1]) * k;
          let by = y - 9 * k < r + 2 ? y + 9 * k : y - 9 * k;
          const bx = Math.min(W - r - 2, Math.max(r + 2, x));
          for (let n = 0; n < 6; n++) {
            const hit = placed.find(
              ([px, py]) => Math.hypot(px - bx, py - by) < r * 2.2
            );
            if (!hit) break;
            by += by < y ? -r * 2.4 : r * 2.4;
          }
          by = Math.min(H - r - 2, Math.max(r + 2, by));
          placed.push([bx, by]);
          grow(bx, by, r + 2);
          grow(x, y, stroke * 2);
          svg += `<line x1="${x}" y1="${y}" x2="${bx}" y2="${by}" stroke="${ink}" stroke-width="1.2"/>`;
          svg += `<circle cx="${x}" cy="${y}" r="${stroke * 1.5}" fill="${ink}"/>`;
          svg += `<circle cx="${bx}" cy="${by}" r="${r}" fill="#fff" stroke="${ink}" stroke-width="1.5"/>`;
          svg += `<text x="${bx}" y="${by + font * 0.35}" text-anchor="middle" font-size="${font}" font-weight="700" fill="${ink}">${name(i)}</text>`;
        });
        const pad = font;
        // Past the box too: a shape drawn over its edge is still shown whole.
        const vx = ext.x0 - pad;
        const vy = ext.y0 - pad;
        const vw = ext.x1 + pad - vx;
        const vh = ext.y1 + pad - vy;
        svg = `<svg viewBox="${vx} ${vy} ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Noto Sans Math, Noto Sans Symbols 2">${svg}</svg>`;
        after = `<div class="label-lines" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 28px;margin:6px 0 12px">${marks
          .map(
            (_, i) =>
              `<p style="margin:0;line-height:2">${name(i)} ${"_".repeat(28)}</p>`
          )
          .join("")}</div>`;
      } else if (kind === "bar") {
        const values = parse(fig, "data-values") as Array<[string, number]>;
        if (!Array.isArray(values) || values.length === 0)
          throw new Error("data-values must be [[label, number], …]");
        if (values.some((v) => !Number.isFinite(Number(v[1]))))
          throw new Error(
            "every value in data-values must be one of the brief's numbers, not a word; leave the chart out if there are no numbers"
          );
        const prefix = fig.getAttribute("data-prefix") || "";
        const suffix = fig.getAttribute("data-suffix") || "";
        if (values.length < 3) {
          asNumbers(
            fig,
            values.map(([label, value]) => [
              String(label),
              prefix + fmt(Number(value)) + suffix,
            ])
          );
          continue;
        }
        const W = seriesW;
        const H = seriesH;
        const top = font * 2;
        // Each label in lines that fit its own band (R5 live: "Ash bookcase"
        // ran into "Hale dining table" in a half-width chart).
        const room = W / values.length - 6;
        const wrap = (text: string): { lines: string[]; size: number } => {
          for (let size = font; size >= font * 0.8 - 0.01; size -= 0.5) {
            const lines: string[] = [];
            for (const word of text.split(/\s+/)) {
              const last = lines[lines.length - 1];
              if (
                last != null &&
                (last + " " + word).length * size * 0.58 <= room
              )
                lines[lines.length - 1] = last + " " + word;
              else lines.push(word);
            }
            if (lines.every((l) => l.length * size * 0.58 <= room))
              return { lines, size };
          }
          return { lines: [text], size: font * 0.8 };
        };
        const labels = values.map(([label]) => wrap(String(label)));
        const rows = Math.max(1, ...labels.map((l) => l.lines.length));
        const bottom = font * (1 + 1.2 * rows);
        const max = Math.max(...values.map((v) => Number(v[1])), 0) || 1;
        const band = W / values.length;
        const bw = Math.min(band * 0.62, onSlide ? 200 : 90);
        svg += `<line x1="0" y1="${H - bottom}" x2="${W}" y2="${H - bottom}" stroke="${line}" stroke-width="1.5"/>`;
        values.forEach(([, value], i) => {
          const v = Number(value);
          const h = ((H - top - bottom) * v) / max;
          const x = band * i + (band - bw) / 2;
          const y = H - bottom - h;
          svg += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="${i === values.length - 1 ? accent : "#9fb8b6"}"/>`;
          svg += `<text x="${x + bw / 2}" y="${y - font * 0.5}" text-anchor="middle" font-size="${font}" font-weight="700" fill="${ink}">${esc(prefix + fmt(v) + suffix)}</text>`;
          const lab = labels[i]!;
          svg += `<text x="${x + bw / 2}" y="${H - bottom + font * 1.5}" text-anchor="middle" font-size="${lab.size}" fill="${muted}">${lab.lines.map((l, k) => `<tspan x="${x + bw / 2}" dy="${k === 0 ? 0 : lab.size * 1.2}">${esc(l)}</tspan>`).join("")}</text>`;
        });
        svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Noto Sans Math, Noto Sans Symbols 2">${svg}</svg>`;
      } else if (kind === "lines") {
        const lines = parse(fig, "data-lines") as Array<{
          label: string;
          points: Array<[number, number]>;
        }>;
        const points =
          (parse(fig, "data-points") as Array<{
            x: number;
            y: number;
            label?: string;
          }>) ?? [];
        const hlines =
          (parse(fig, "data-hlines") as Array<{ y: number; label?: string }>) ??
          [];
        const axes = (parse(fig, "data-axes") as [string, string]) ?? ["", ""];
        if (!Array.isArray(lines) || lines.length === 0)
          throw new Error(
            "data-lines must be [{label, points: [[x, y], …]}, …]"
          );
        // Only what lies on or above the axes is drawn (round 3: S started at
        // P = -10 and ran below the Q axis).
        const clip = (
          a: [number, number],
          b: [number, number]
        ): [[number, number], [number, number]] | null => {
          let [p, q] = [[...a], [...b]] as [[number, number], [number, number]];
          for (const k of [0, 1]) {
            if (p[k]! < 0 && q[k]! < 0) return null;
            const t = (0 - p[k]!) / (q[k]! - p[k]! || 1);
            if (p[k]! < 0)
              p = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
            else if (q[k]! < 0)
              q = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          }
          return [p, q];
        };
        const drawn = lines.map((l) =>
          l.points
            .slice(1)
            .map((b, i) => clip(l.points[i]!, b))
            .filter((x): x is [[number, number], [number, number]] => x != null)
        );
        const xs = drawn
          .flat(2)
          .map((p) => p[0])
          .concat(points.map((p) => p.x));
        const ys = drawn
          .flat(2)
          .map((p) => p[1])
          .concat(
            points.map((p) => p.y),
            hlines.map((h) => h.y)
          );
        const xmax = Math.max(...xs, 1) * 1.05;
        const ymax = Math.max(...ys, 1) * 1.08;
        const W = onSlide ? (inSplit ? 640 : 760) : printed > 0 ? printed : 420;
        // At most half a page in a document (round 4: a page-high diagram).
        const H = onSlide
          ? inSplit
            ? 540
            : 440
          : printed > 0
            ? Math.min(W * 0.68, 340 * chartFit)
            : 300;
        const L = font * 3.2;
        const B = font * 2.8;
        const T = font * 2;
        // Room on the right for the longest line or level label (round 2:
        // "Higher", "S (Qs = …)" were cut off at the edge).
        const longest = Math.max(
          0,
          ...lines.map((l) => l.label.length),
          ...hlines.map((h) => (h.label ?? "").length)
        );
        const R = Math.min(
          W * 0.35,
          Math.max(font * 3, longest * font * 0.58 + 12)
        );
        const X = (x: number): number => L + ((W - L - R) * x) / xmax;
        const Y = (y: number): number => H - B - ((H - B - T) * y) / ymax;

        // Every line drawn, in the svg's own units, so no label sits on one.
        const segs: Array<[number, number, number, number]> = [];
        const seg = (
          x1: number,
          y1: number,
          x2: number,
          y2: number
        ): string => {
          segs.push([x1, y1, x2, y2]);
          return `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`;
        };
        svg += `<line ${seg(L, T, L, H - B)} stroke="${ink}" stroke-width="1.5"/>`;
        svg += `<line ${seg(L, H - B, W - R, H - B)} stroke="${ink}" stroke-width="1.5"/>`;
        for (const h of hlines)
          svg += `<line ${seg(L, Y(h.y), W - R, Y(h.y))} stroke="#b4521c" stroke-width="2" stroke-dasharray="6 4"/>`;
        drawn.forEach((parts, i) => {
          for (const [a, b] of parts) {
            segs.push([X(a[0]), Y(a[1]), X(b[0]), Y(b[1])]);
            svg += `<polyline points="${X(a[0])},${Y(a[1])} ${X(b[0])},${Y(b[1])}" fill="none" stroke="${palette[i % palette.length]}" stroke-width="${onSlide ? 4 : 2.5}"/>`;
          }
        });
        for (const p of points) {
          svg += `<line ${seg(X(p.x), Y(p.y), X(p.x), H - B)} stroke="${muted}" stroke-dasharray="4 4"/>`;
          svg += `<line ${seg(L, Y(p.y), X(p.x), Y(p.y))} stroke="${muted}" stroke-dasharray="4 4"/>`;
          svg += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${onSlide ? 7 : 4.5}" fill="${ink}"/>`;
        }

        // Labels: the first place near their anchor that crosses no line, no
        // other label and stays inside the figure.
        const placed: Array<{ l: number; r: number; t: number; b: number }> =
          [];
        const crosses = (box: {
          l: number;
          r: number;
          t: number;
          b: number;
        }): boolean =>
          box.l < 0 ||
          box.r > W ||
          box.t < 0 ||
          box.b > H ||
          placed.some(
            (o) => o.l < box.r && box.l < o.r && o.t < box.b && box.t < o.b
          ) ||
          segs.some(([ax, ay, bx, by]) => {
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
            for (let k = 0; k <= n; k++) {
              const x = ax + ((bx - ax) * k) / n;
              const y = ay + ((by - ay) * k) / n;
              if (x > box.l && x < box.r && y > box.t && y < box.b) return true;
            }
            return false;
          });
        // Labels with no free spot go in a key under the diagram, never
        // across a line (R5: a long equilibrium label crossed S in a narrow chart).
        const keys: Array<{ text: string; attrs: string; mark: string }> = [];
        const label = (
          text: string,
          spots: Array<[number, number, "start" | "end" | "middle"]>,
          attrs: string,
          mark?: string
        ): string => {
          const w = text.length * font * 0.62;
          const boxOf = ([x, y, a]: [number, number, string]) => {
            const l = a === "end" ? x - w : a === "middle" ? x - w / 2 : x;
            return {
              l: l - 2,
              r: l + w + 2,
              t: y - font * 0.8 - 2,
              b: y + font * 0.2 + 2,
            };
          };
          const free = spots.find((s) => !crosses(boxOf(s)));
          if (free == null && mark != null) {
            keys.push({ text, attrs, mark });
            return "";
          }
          const spot = free ?? spots[0]!;
          placed.push(boxOf(spot));
          return `<text x="${spot[0]}" y="${spot[1]}" text-anchor="${spot[2]}" font-size="${font}" ${attrs}>${esc(text)}</text>`;
        };
        const g = font * 0.6;
        // Around an anchor, nearest first: eight directions at growing
        // distances, so a label finds the gap between lines that cross there.
        const around = (
          x: number,
          y: number
        ): Array<[number, number, "start" | "end" | "middle"]> => {
          const out: Array<[number, number, "start" | "end" | "middle"]> = [];
          for (const d of [g, g * 2, g * 3.5, g * 5, g * 7, g * 9.5]) {
            out.push(
              [x + d, y - d, "start"],
              [x - d, y - d, "end"],
              [x + d, y + font + d * 0.6, "start"],
              [x - d, y + font + d * 0.6, "end"],
              [x, y - d - g, "middle"],
              [x, y + font + d, "middle"],
              [x + d * 1.4, y + font * 0.35, "start"],
              [x - d * 1.4, y + font * 0.35, "end"]
            );
          }
          return out;
        };
        // Axis names written level, at the ends of their axes.
        svg += label(
          axes[1] || "",
          [
            [L - 6, T - font * 0.7, "start"],
            [4, T - font * 0.7, "start"],
          ],
          `font-weight="600" fill="${ink}"`
        );
        svg += label(
          axes[0] || "",
          [
            [W - R, H - font * 0.3, "end"],
            [(L + W - R) / 2, H - font * 0.3, "middle"],
            [W - 2, H - B - g, "end"],
          ],
          `font-weight="600" fill="${ink}"`
        );

        for (const p of points) {
          const [px, py] = [X(p.x), Y(p.y)];
          svg += label(
            fmt(p.y),
            [[L - 6, py + font * 0.35, "end"]],
            `fill="${ink}"`
          );
          svg += label(
            fmt(p.x),
            [[px, H - B + font * 1.2, "middle"]],
            `fill="${ink}"`
          );
          if (p.label)
            svg += label(
              p.label,
              around(px, py),
              `font-weight="600" fill="${ink}"`,
              "●"
            );
        }
        for (const h of hlines)
          if (h.label)
            svg += label(
              h.label,
              [
                [W - R + 4, Y(h.y) + font * 0.35, "start"],
                [L + 6, Y(h.y) - g, "start"],
                [L + 6, Y(h.y) + font + g, "start"],
              ],
              `fill="#b4521c"`
            );
        drawn.forEach((parts, i) => {
          const l = lines[i]!;
          if (parts.length === 0) return;
          const [ex, ey] = [
            X(parts[parts.length - 1]![1][0]),
            Y(parts[parts.length - 1]![1][1]),
          ];
          const [sx, sy] = [X(parts[0]![0][0]), Y(parts[0]![0][1])];
          svg += label(
            l.label,
            [
              [ex + g, ey + font * 0.35, "start"],
              ...around(ex, ey),
              ...around(sx, sy),
            ],
            `font-weight="700" fill="${palette[i % palette.length]}"`,
            "—"
          );
        });
        keys.forEach((k, i) => {
          svg += `<text x="4" y="${H + font * (1.4 * i + 1.1)}" font-size="${font}" ${k.attrs}>${esc(`${k.mark} ${k.text}`)}</text>`;
        });
        const fullH = H + keys.length * font * 1.4 + (keys.length > 0 ? 4 : 0);
        // Each marked point must sit on a line; an equilibrium or intersection
        // on two (E run: an equilibrium marked where the S line did not pass).
        const onLine = (
          p: { x: number; y: number },
          l: { points: Array<[number, number]> }
        ): boolean =>
          l.points.slice(1).some((b, i) => {
            const a = l.points[i]!;
            const [ax, ay, bx, by] = [
              a[0] / xmax,
              a[1] / ymax,
              b[0] / xmax,
              b[1] / ymax,
            ];
            const [px, py] = [p.x / xmax, p.y / ymax];
            const dx = bx - ax;
            const dy = by - ay;
            const t = Math.max(
              0,
              Math.min(
                1,
                ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)
              )
            );
            return Math.hypot(ax + t * dx - px, ay + t * dy - py) < 0.02;
          });
        for (const p of points) {
          const n = lines.filter((l) => onLine(p, l)).length;
          const name = p.label ? `"${p.label}"` : "A point";
          if (
            n === 0 ||
            (n < 2 && /equilibri|intersect|cross|meet/i.test(p.label ?? ""))
          )
            fig.setAttribute("data-chart-failed", "");
          if (n === 0)
            failed.push(
              `${name} at (${p.x}, ${p.y}) is on no line; check its numbers`
            );
          else if (
            n < 2 &&
            /equilibri|intersect|cross|meet/i.test(p.label ?? "")
          )
            failed.push(
              `${name} at (${p.x}, ${p.y}) is on ${n} of its lines; it must be where two lines cross, so check the lines' points against the equations`
            );
        }
        svg = `<svg viewBox="0 0 ${W} ${fullH}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Noto Sans Math, Noto Sans Symbols 2">${svg}</svg>`;
      } else if (kind === "growth") {
        // A series grown in code from a start and a rate, so its end value is
        // computed, not typed: data-start="1850" data-rate="14" data-periods="6".
        const start = Number(fig.getAttribute("data-start"));
        const rate = Number(fig.getAttribute("data-rate"));
        const periods = Number(fig.getAttribute("data-periods"));
        if (
          ![start, rate, periods].every(Number.isFinite) ||
          periods < 1 ||
          periods > 60
        )
          throw new Error(
            "growth needs data-start, data-rate (per cent a period) and data-periods (1 to 60)"
          );
        const unit = fig.getAttribute("data-period") || "month";
        const prefix = fig.getAttribute("data-prefix") || "";
        const suffix = fig.getAttribute("data-suffix") || "";
        const series = Array.from(
          { length: periods + 1 },
          (_, i) => start * (1 + rate / 100) ** i
        );
        const end = series[series.length - 1]!;
        const shownEnd = Math.round(end);
        computed.push(shownEnd, start);
        const W = seriesW;
        const H = seriesH;
        const L = font * 1.5;
        const R = font * 6;
        const T = font * 2.2;
        const B = font * 2.4;
        const X = (i: number): number => L + ((W - L - R) * i) / periods;
        const Y = (v: number): number => H - B - ((H - B - T) * v) / end;
        const pts = series.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
        svg += `<polygon points="${X(0)},${H - B} ${pts} ${X(periods)},${H - B}" fill="${accent}" opacity="0.14"/>`;
        svg += `<polyline points="${pts}" fill="none" stroke="${accent}" stroke-width="${onSlide ? 5 : 3}"/>`;
        svg += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="${line}" stroke-width="1.5"/>`;
        svg += `<circle cx="${X(0)}" cy="${Y(start)}" r="${onSlide ? 8 : 5}" fill="${accent}"/>`;
        svg += `<circle cx="${X(periods)}" cy="${Y(end)}" r="${onSlide ? 8 : 5}" fill="${accent}"/>`;
        svg += `<text x="${X(0)}" y="${Y(start) - font * 0.8}" font-size="${font}" font-weight="700" fill="${ink}">${esc(prefix + fmt(start) + suffix)}</text>`;
        svg += `<text x="${X(periods) + 12}" y="${Y(end) + font * 0.35}" font-size="${font}" font-weight="700" fill="${accent}">${esc(prefix + fmt(shownEnd) + suffix)}</text>`;
        svg += `<text x="${X(0)}" y="${H - B + font * 1.5}" font-size="${font}" fill="${muted}">now</text>`;
        svg += `<text x="${X(periods)}" y="${H - B + font * 1.5}" text-anchor="end" font-size="${font}" fill="${muted}">${esc(`${periods} ${unit}${periods === 1 ? "" : "s"} at ${fmt(rate)}%`)}</text>`;
        computed.push(periods, rate);
        svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Noto Sans Math, Noto Sans Symbols 2">${svg}</svg>`;
      } else if (kind === "share") {
        // Parts of a whole as one bar; "rest" is computed: data-parts='[["Tiffinly",28],["Home cook","rest"]]'.
        const parts = parse(fig, "data-parts") as Array<
          [string, number | "rest"]
        >;
        if (!Array.isArray(parts) || parts.length < 2)
          throw new Error(
            'share needs data-parts=\'[["label", number], ["label", "rest"]]\''
          );
        const given = parts.reduce(
          (a, [, v]) => a + (v === "rest" ? 0 : Number(v)),
          0
        );
        const vals = parts.map(([, v]) =>
          v === "rest" ? Math.max(0, 100 - given) : Number(v)
        );
        // Parts are percentages only beside a computed rest.
        if (parts.some(([, v]) => v === "rest"))
          shares.push(
            ...parts.filter(([, v]) => v !== "rest").map(([, v]) => Number(v))
          );
        const total = vals.reduce((a, b) => a + b, 0) || 1;
        // A derived rest is not a fact (round 5: "36% Other answers"): it is
        // drawn as the bar's remainder, with no number or label.
        if (parts.length <= 2) {
          const pcts = vals.map((v) => Math.round((v / total) * 1000) / 10);
          computed.push(
            ...pcts.filter((_, i) => parts[i]![1] !== "rest"),
            ...vals
          );
          asNumbers(
            fig,
            parts
              .map(
                ([label], i) =>
                  [String(label), `${fmt(pcts[i]!)}%`] as [string, string]
              )
              .filter((_, i) => parts[i]![1] !== "rest")
          );
          continue;
        }
        const W = onSlide
          ? inSplit
            ? 640
            : 1000
          : printed > 0
            ? printed
            : 600;
        const bh = onSlide ? 90 : 46;
        const colour = (i: number): string =>
          parts[i]![1] === "rest"
            ? line
            : i === 0
              ? accent
              : palette[(i % (palette.length - 1)) + 1]!;
        // A label wider than its part (a narrow chart, a small share) puts
        // the labels in a legend under the bar (overnight: "Sandw…").
        const shown = parts
          .map((p, i) => ({ label: String(p[0]), i }))
          .filter(({ i }) => parts[i]![1] !== "rest");
        const legend = shown.some(
          ({ label, i }) =>
            label.length * font * 0.6 > (W * vals[i]!) / total - 4
        );
        if (legend) {
          const rowH = font * 1.9;
          const perRow = W >= 420 ? 3 : 2;
          const rows = Math.ceil(shown.length / perRow);
          const H2 = bh + font * 1.2 + rows * rowH;
          let x2 = 0;
          vals.forEach((v, i) => {
            const w = (W * v) / total;
            const pct = Math.round((v / total) * 1000) / 10;
            const rest = parts[i]![1] === "rest";
            svg += `<rect x="${x2}" y="0" width="${w}" height="${bh}" fill="${colour(i)}" opacity="${i === 0 || rest ? 1 : 0.35}"/>`;
            if (!rest) {
              computed.push(pct, v);
              if (`${fmt(pct)}%`.length * font * 1.2 * 0.62 < w - 8)
                svg += `<text x="${x2 + 8}" y="${bh / 2 + font * 0.4}" font-size="${font * 1.1}" font-weight="700" fill="${i === 0 ? "#fff" : ink}">${esc(fmt(pct))}%</text>`;
            }
            x2 += w;
          });
          shown.forEach(({ label, i }, k) => {
            const cx = (k % perRow) * (W / perRow);
            const cy = bh + font * 1.2 + Math.floor(k / perRow) * rowH;
            const pct = Math.round((vals[i]! / total) * 1000) / 10;
            svg += `<rect x="${cx}" y="${cy}" width="${font * 0.8}" height="${font * 0.8}" fill="${colour(i)}" opacity="${i === 0 ? 1 : 0.35}"/>`;
            svg += `<text x="${cx + font * 1.2}" y="${cy + font * 0.75}" font-size="${font}" fill="${ink}">${esc(label)}</text>`;
            svg += `<text x="${cx + font * 1.2 + label.length * font * 0.58 + font * 0.4}" y="${cy + font * 0.75}" font-size="${font}" font-weight="700" fill="${muted}">${esc(fmt(pct))}%</text>`;
          });
          svg = `<svg viewBox="0 0 ${W} ${H2}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Noto Sans Math, Noto Sans Symbols 2">${svg}</svg>`;
        } else {
          const H = onSlide ? 200 : 110;
          let x = 0;
          vals.forEach((v, i) => {
            const w = (W * v) / total;
            const pct = Math.round((v / total) * 1000) / 10;
            const rest = parts[i]![1] === "rest";
            svg += `<rect x="${x}" y="0" width="${w}" height="${bh}" fill="${rest ? line : i === 0 ? accent : palette[(i % (palette.length - 1)) + 1]}" opacity="${i === 0 || rest ? 1 : 0.35}"/>`;
            if (rest) {
              x += w;
              return;
            }
            computed.push(pct, v);
            svg += `<text x="${x + 12}" y="${bh / 2 + font * 0.35}" font-size="${font * 1.2}" font-weight="700" fill="${i === 0 ? "#fff" : ink}">${esc(fmt(pct))}%</text>`;
            svg += `<text x="${x + 2}" y="${bh + font * 1.5}" font-size="${font}" fill="${muted}">${esc(String(parts[i]![0]))}</text>`;
            x += w;
          });
          svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Noto Sans Math, Noto Sans Symbols 2">${svg}</svg>`;
        }
      } else {
        throw new Error(
          `no chart called "${kind}"; use bar, growth, share, lines or label`
        );
      }
      const caption = fig.querySelector("figcaption");
      fig.innerHTML = svg;
      if (caption) fig.appendChild(caption);
      if (after) fig.insertAdjacentHTML("afterend", after);
      drawn++;
    } catch (e) {
      failed.push(`${kind ?? "chart"}: ${(e as Error).message}`);
    }
  }
  return { drawn, failed, computed, asNumbers: numbered, shares };
}
