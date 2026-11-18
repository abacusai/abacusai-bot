/**
 * Sums worked out in code, never by the model. The model marks up what each
 * number is; this fills in every amount, subtotal, discount, tax, total and
 * marks total, then checks the marks against what the brief asked for.
 *
 * Money: a table with data-currency="BRL"; each line `tr[data-qty][data-unit]`
 * (or `tr[data-amount]` for a lump sum); cells `td[data-cell="unit"]` and
 * `td[data-cell="amount"]` are written here. Rows data-role="subtotal",
 * "discount" (data-pct), "tax" (data-pct) and "total". Anywhere else,
 * `[data-ref="subtotal|discount|tax|total"]` repeats a figure.
 *
 * Marks: each question `[data-q][data-marks]` with an empty `.marks`;
 * `.section` wraps questions and holds `[data-ref="section-marks"]`;
 * `[data-ref="total-marks"]` and `[data-ref="marks-of"][data-q]` (in a key)
 * are written here.
 *
 * Self-contained (no imports, no closures) because it is serialised into the
 * print window with Function.prototype.toString.
 */
export type SumsReport = {
  total: number | null;
  marks: number | null;
  /** Every value the code worked out, for the faithfulness check. */
  computed: number[];
  problems: string[];
};

export function applySums(
  doc: Document,
  ask: { totalMarks: number | null; briefNumbers?: number[] }
): SumsReport {
  const problems: string[] = [];
  const computed: number[] = [];
  const lang = doc.documentElement.getAttribute("lang") || "en-GB";
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const num = (v: string | null): number => {
    if (v == null) return NaN;
    const s = v.trim();
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  };
  let lastTotal: number | null = null;

  const tables = Array.from(doc.querySelectorAll("table[data-currency]"));
  let main: {
    lines: number;
    figures: Record<string, number>;
    money: (n: number) => string;
    table: Element;
  } | null = null;
  for (const table of tables) {
    const currency = table.getAttribute("data-currency") || "GBP";
    let fmt: Intl.NumberFormat;
    try {
      fmt = new Intl.NumberFormat(lang, { style: "currency", currency });
    } catch {
      fmt = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
      });
    }
    const money = (n: number): string => fmt.format(n);
    const set = (el: Element | null, text: string): void => {
      if (el) el.textContent = text;
    };

    let subtotal = 0;
    const lines = Array.from(table.querySelectorAll("tr")).filter(
      (tr) => tr.hasAttribute("data-qty") || tr.hasAttribute("data-amount")
    );
    // A table with no priced lines (a summary repeating the totals) computes
    // nothing; its cells stay as written (live F: they printed R$ 0,00).
    if (lines.length === 0) continue;
    for (const tr of lines) {
      let amount: number;
      if (tr.hasAttribute("data-qty")) {
        const qty = num(tr.getAttribute("data-qty"));
        const unit = num(tr.getAttribute("data-unit"));
        if (!Number.isFinite(qty) || !Number.isFinite(unit)) {
          problems.push(
            `A line has data-qty="${tr.getAttribute("data-qty")}" data-unit="${tr.getAttribute("data-unit")}"; both must be plain numbers.`
          );
          continue;
        }
        amount = round2(qty * unit);
        computed.push(amount);
        set(tr.querySelector('[data-cell="unit"]'), money(unit));
      } else {
        amount = num(tr.getAttribute("data-amount"));
        if (!Number.isFinite(amount)) {
          problems.push(
            `A line has data-amount="${tr.getAttribute("data-amount")}"; it must be a plain number.`
          );
          continue;
        }
      }
      set(tr.querySelector('[data-cell="amount"]'), money(amount));
      subtotal = round2(subtotal + amount);
    }

    const row = (role: string): Element | null =>
      table.querySelector(`tr[data-role="${role}"]`);
    const cell = (tr: Element | null): Element | null =>
      tr
        ? (tr.querySelector('[data-cell="amount"]') ?? tr.lastElementChild)
        : null;
    const figures: Record<string, number> = { subtotal };

    set(cell(row("subtotal")), money(subtotal));
    let running = subtotal;
    const discount = row("discount");
    if (discount) {
      const pct = num(discount.getAttribute("data-pct"));
      const d = Number.isFinite(pct) ? round2((subtotal * pct) / 100) : 0;
      figures.discount = d;
      set(cell(discount), `−${money(d)}`);
      running = round2(running - d);
    }
    const tax = row("tax");
    if (tax) {
      const pct = num(tax.getAttribute("data-pct"));
      const t = Number.isFinite(pct) ? round2((running * pct) / 100) : 0;
      figures.tax = t;
      set(cell(tax), money(t));
      running = round2(running + t);
    }
    figures.total = running;
    computed.push(...Object.values(figures));
    set(cell(row("total")), money(running));
    lastTotal = running;
    if (main == null || lines.length > main.lines)
      main = { lines: lines.length, figures, money, table };
  }
  // Figures repeated elsewhere come from the table with the most lines.
  if (main != null) {
    const m = main as {
      figures: Record<string, number>;
      money: (n: number) => string;
      table: Element;
    };
    for (const ref of Array.from(doc.querySelectorAll("[data-ref]"))) {
      const name = ref.getAttribute("data-ref") || "";
      if (name in m.figures && !m.table.contains(ref))
        ref.textContent = m.money(m.figures[name]!);
    }
  }

  // Derived numbers: <span data-calc="8.3 * 28 / 100" data-dp="1" data-prefix="₹"
  // data-suffix=" lakh">. Only arithmetic, and only on the brief's own
  // numbers (or that number x100 or /100), or unit constants.
  const UNITS = [
    1, 2, 7, 10, 12, 24, 30, 52, 60, 100, 365, 1000, 100000, 1000000, 10000000,
  ];
  const brief = ask.briefNumbers ?? [];
  const known = (v: number): boolean =>
    UNITS.includes(v) ||
    brief.some((b) =>
      // The number itself, x100 or /100 (a percentage), or written out in
      // thousands, lakhs, millions or crores.
      [
        b,
        b * 100,
        b / 100,
        b * 1000,
        b * 100000,
        b * 1000000,
        b * 10000000,
      ].some((c) => Math.abs(c - v) < 1e-9 * Math.max(1, Math.abs(v)))
    );
  for (const el of Array.from(doc.querySelectorAll("[data-calc]"))) {
    const expr = (el.getAttribute("data-calc") || "").trim();
    if (!/^[\d.\s+\-*/()]+$/.test(expr)) {
      problems.push(
        `data-calc="${expr}" may hold only numbers and + - * / ( ).`
      );
      continue;
    }
    const literals = (expr.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    const strange = literals.filter((v) => !known(v));
    if (strange.length > 0) {
      problems.push(
        `data-calc="${expr}" uses ${strange.join(", ")}, which is not in the brief; use the brief's own numbers.`
      );
      continue;
    }
    let value: number;
    try {
      value = Number(new Function(`return (${expr});`)());
    } catch {
      problems.push(`data-calc="${expr}" is not a valid calculation.`);
      continue;
    }
    if (!Number.isFinite(value)) {
      problems.push(`data-calc="${expr}" does not give a number.`);
      continue;
    }
    const dpAttr = el.getAttribute("data-dp");
    const dp =
      dpAttr != null && /^\d$/.test(dpAttr)
        ? Number(dpAttr)
        : Number.isInteger(value)
          ? 0
          : 1;
    const shown = Math.round(value * 10 ** dp) / 10 ** dp;
    const text = new Intl.NumberFormat(lang, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(shown);
    el.textContent = `${el.getAttribute("data-prefix") || ""}${text}${el.getAttribute("data-suffix") || ""}`;
    computed.push(shown, value);
  }

  // Marks.
  const questions = Array.from(doc.querySelectorAll("[data-q][data-marks]"))
    .filter((el) => !el.matches('[data-ref="marks-of"]'))
    // Once per question number: a key that repeats data-marks is not more marks.
    .filter(
      (el, i, all) =>
        all.findIndex(
          (o) => o.getAttribute("data-q") === el.getAttribute("data-q")
        ) === i
    );
  let marks: number | null = null;
  // Marks scaled to a target total, largest remainder first, each at least 1.
  const allocate = (given: number[], target: number): number[] => {
    const total = given.reduce((a, b) => a + b, 0);
    const exact = given.map((m) => (m * target) / total);
    const out = exact.map((x) => Math.max(1, Math.floor(x)));
    let left = target - out.reduce((a, b) => a + b, 0);
    const order = exact
      .map((x, i) => ({ i, r: x - Math.floor(x) }))
      .sort((a, b) => b.r - a.r);
    for (let k = 0; left > 0; k = (k + 1) % order.length, left--)
      out[order[k]!.i]!++;
    for (
      let k = order.length - 1;
      left < 0;
      k = (k - 1 + order.length) % order.length
    ) {
      const i = order[k]!.i;
      if (out[i]! > 1) {
        out[i]!--;
        left++;
      }
    }
    return out;
  };
  if (questions.length > 0) {
    const byQ = new Map<string, number>();
    let sum = 0;
    for (const q of questions) {
      const m = num(q.getAttribute("data-marks"));
      if (!Number.isFinite(m)) {
        problems.push(
          `Question ${q.getAttribute("data-q")} has data-marks="${q.getAttribute("data-marks")}"; it must be a number.`
        );
        continue;
      }
      byQ.set(q.getAttribute("data-q") || "", m);
      sum += m;
      const label = q.querySelector(".marks");
      if (label) label.textContent = `[${m} mark${m === 1 ? "" : "s"}]`;
    }
    marks = sum;
    computed.push(sum);
    for (const section of Array.from(doc.querySelectorAll(".section"))) {
      let s = 0;
      for (const q of Array.from(
        section.querySelectorAll("[data-q][data-marks]")
      )) {
        if (questions.includes(q)) s += num(q.getAttribute("data-marks")) || 0;
      }
      // A section with no questions of its own (an answer key's) gets no total.
      if (!questions.some((q) => section.contains(q))) continue;
      computed.push(s);
      for (const ref of Array.from(
        section.querySelectorAll('[data-ref="section-marks"]')
      ))
        ref.textContent = `${s} mark${s === 1 ? "" : "s"}`;
    }
    for (const ref of Array.from(
      doc.querySelectorAll('[data-ref="total-marks"]')
    ))
      ref.textContent = String(sum);
    for (const ref of Array.from(
      doc.querySelectorAll('[data-ref="marks-of"]')
    )) {
      const m = byQ.get(ref.getAttribute("data-q") || "");
      if (m != null) ref.textContent = String(m);
    }
    if (ask.totalMarks != null && sum !== ask.totalMarks)
      problems.push(
        `The questions' marks add up to ${sum}, but the brief asks for ${ask.totalMarks} marks in total. Change data-marks on the questions so they add up to ${ask.totalMarks}` +
          (questions.length <= ask.totalMarks && sum > 0
            ? `, for example ${allocate(
                questions.map((q) => num(q.getAttribute("data-marks")) || 1),
                ask.totalMarks
              )
                .map((m, i) => `Q${questions[i]!.getAttribute("data-q")} ${m}`)
                .join(", ")}, and make the answer key's mark scheme match.`
            : ".")
      );
  }

  return {
    total: lastTotal,
    marks,
    computed,
    problems,
  };
}
