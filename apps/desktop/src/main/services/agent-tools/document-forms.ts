/**
 * Documents with a fixed layout: an invoice, a quote, a resume, a letter, a
 * certificate, a proposal. The model
 * fills named fields and this lays them out, so the layout is designed once
 * rather than improvised per document, and an invoice's sums are worked out
 * here, never by the model.
 */

export const FORM_KINDS = [
  "invoice",
  "quote",
  "resume",
  "letter",
  "certificate",
  "proposal",
  "worksheet",
  "activity_report",
] as const;
export type FormKind = (typeof FORM_KINDS)[number];

export type DocumentForm = { kind: FormKind; data: Record<string, unknown> };

import {
  formatMoney,
  formatNumber,
  formatPercent,
  labelsFor,
  languageOf,
  type Labels,
} from "./document-labels";

export const escape = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch
  );

/**
 * While `tooLong` measures a form: every string and list a render printed,
 * with the least of it that printed anywhere.
 */
let measured: {
  texts: Map<string, number>;
  lists: Map<unknown[], number>;
} | null = null;

/**
 * A field as text, cut to `max`. A read with no `max` is a check that the
 * field is there; one with a `max` is a print, and the smallest print of a
 * value is what fits.
 */
const text = (value: unknown, max?: number): string => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const whole = String(value).trim();
  if (measured != null && max != null)
    measured.texts.set(whole, Math.min(measured.texts.get(whole) ?? max, max));
  return whole.slice(0, max ?? 400);
};

const list = (value: unknown, max = 40): unknown[] => {
  if (!Array.isArray(value)) return [];
  if (measured != null)
    measured.lists.set(value, Math.min(measured.lists.get(value) ?? max, max));
  return value.slice(0, max);
};

const lines = (value: unknown): string[] => {
  const all = (Array.isArray(value) ? value : text(value, 600).split("\n"))
    .map((line) => text(line, 400))
    .filter((line) => line.length > 0);
  if (measured != null) measured.lists.set(all, 8);
  return all.slice(0, 8);
};

const block = (value: unknown): string =>
  lines(value).map(escape).join("<br />");

/**
 * A figure as a person writes it in English: "1200.5", "$1,200.50", "USD 40".
 * Anything else ("1.200,50 €", "10%", "two") is null, so it is sent back to be
 * rewritten rather than misread as another number.
 */
const plainNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const figure = value
    .trim()
    .replace(/^[\p{Sc}\p{L}]+\.?\s*/u, "")
    .replace(/\s*[\p{Sc}\p{L}]+$/u, "");
  return /^[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(figure)
    ? Number(figure.replace(/,/g, "").replace("−", "-"))
    : null;
};

/** Left out means none; a figure that is not plain counts as none too. */
const absent = (value: unknown): boolean =>
  value == null || (typeof value === "string" && value.trim().length === 0);

const num = (value: unknown): number => plainNumber(value) ?? 0;

const paragraphs = (value: unknown): string =>
  (Array.isArray(value) ? value : text(value, 6000).split(/\n\s*\n/))
    .map((each) => text(each, 2000))
    .filter((each) => each.length > 0)
    .slice(0, 12)
    .map((each) => `<p>${escape(each)}</p>`)
    .join("\n");

/**
 * The language the form being drawn prints in: its labels and its money.
 * Set by formArticle for the length of one synchronous render.
 */
let t: Labels = labelsFor("en");
let language = "en";

const money = (amount: number, currency: string): string =>
  formatMoney(amount, currency, language);

export type InvoiceTotals = {
  rows: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

/** The sums, in cents so a column of prices adds up as printed. */
export const invoiceTotals = (data: Record<string, unknown>): InvoiceTotals => {
  const cents = (value: number): number => Math.round(value * 100);
  const rows = list(data.items)
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .map((item) => {
      const quantity = absent(item.quantity) ? 1 : num(item.quantity);
      const unitPrice = num(item.unit_price);
      return {
        description: text(item.description, 300),
        quantity,
        unitPrice,
        amount: cents(quantity * unitPrice) / 100,
      };
    })
    .filter((row) => row.description.length > 0);
  const subtotalCents = rows.reduce((sum, row) => sum + cents(row.amount), 0);
  // Between nothing and the whole subtotal: a refund-only invoice (a negative
  // subtotal) takes no discount and prints its negative total.
  const discountCents = Math.min(
    Math.max(cents(num(data.discount)), 0),
    Math.max(subtotalCents, 0)
  );
  const taxCents = Math.round(
    ((subtotalCents - discountCents) * num(data.tax_percent)) / 100
  );

  return {
    rows,
    subtotal: subtotalCents / 100,
    discount: discountCents / 100,
    tax: taxCents / 100,
    total: (subtotalCents - discountCents + taxCents) / 100,
  };
};

/** The priced table and its sums, shared by an invoice and a quote. */
const pricedLines = (
  data: Record<string, unknown>,
  totalLabel: string
): string => {
  const currency = text(data.currency, 4);
  const totals = invoiceTotals(data);
  const sumRow = (label: string, amount: number, strong = false): string =>
    `<tr${strong ? ' class="grand"' : ""}><td>${label}</td><td>${escape(money(amount, currency))}</td></tr>`;

  return `
  <table class="items">
    <thead><tr><th>${t.description}</th><th>${t.qty}</th><th>${t.unitPrice}</th><th>${t.amount}</th></tr></thead>
    <tbody>
${totals.rows.map((row) => `      <tr><td>${escape(row.description)}</td><td>${row.quantity}</td><td>${escape(money(row.unitPrice, currency))}</td><td>${escape(money(row.amount, currency))}</td></tr>`).join("\n")}
    </tbody>
  </table>
  <table class="sums">
    ${sumRow(t.subtotal, totals.subtotal)}
    ${totals.discount > 0 ? sumRow(t.discount, -totals.discount) : ""}
    ${num(data.tax_percent) > 0 ? sumRow(`${escape(text(data.tax_label, 30) || t.tax)} (${formatPercent(num(data.tax_percent), language)})`, totals.tax) : ""}
    ${sumRow(totalLabel, totals.total, true)}
  </table>`;
};

/** A labelled note under the figures; nothing at all when it has no text. */
const note = (label: string, value: unknown, asLines = false): string =>
  asLines
    ? lines(value).length > 0
      ? `<section class="note"><div class="label">${label}</div><div>${block(value)}</div></section>`
      : ""
    : text(value).length > 0
      ? `<section class="note"><div class="label">${label}</div>${paragraphs(value)}</section>`
      : "";

/** The head of a priced form: who it is from, its kind and its numbers. */
const pricedHead = (
  kind: string,
  data: Record<string, unknown>,
  meta: Array<[string, string]>,
  toLabel: string
): string => {
  const shown = meta.filter(([, value]) => value.length > 0);
  return `
  <header class="form-head">
    <div>
      <div class="form-kind">${escape(kind)}</div>
      <div class="party-name">${escape(text(data.from_name, 120))}</div>
      <div class="party">${block(data.from_details)}</div>
    </div>
    <dl class="form-meta">${shown.map(([k, v]) => `<dt>${k}</dt><dd>${escape(v)}</dd>`).join("")}</dl>
  </header>
  <section class="bill-to">
    <div class="label">${toLabel}</div>
    <div class="party-name">${escape(text(data.to_name, 120))}</div>
    <div class="party">${block(data.to_details)}</div>
  </section>`;
};

const invoice = (data: Record<string, unknown>): string => `
  ${pricedHead(
    t.invoice,
    data,
    [
      [t.invoiceNo, text(data.number, 40)],
      [t.issued, text(data.date, 40)],
      [t.due, text(data.due_date, 40)],
    ],
    t.billTo
  )}
  ${pricedLines(data, t.totalDue)}
  ${note(t.payment, data.payment_details, true)}
  ${note(t.notes, data.notes)}`;

/** A place for the client to sign the quote back. */
const acceptance = (label: string): string => `
  <section class="accept">
    <div class="label">${label}</div>
    <div class="sign-lines">
      <div><span class="sign-line"></span><span class="sign-caption">${t.name}</span></div>
      <div><span class="sign-line"></span><span class="sign-caption">${t.signature}</span></div>
      <div><span class="sign-line"></span><span class="sign-caption">${t.date}</span></div>
    </div>
  </section>`;

const quote = (data: Record<string, unknown>): string => {
  const heading = /^estimate$/i.test(text(data.heading)) ? t.estimate : t.quote;
  return `
  ${pricedHead(
    heading,
    data,
    [
      [t.number, text(data.number, 40)],
      [t.date, text(data.date, 40)],
      [t.validUntil, text(data.valid_until, 40)],
    ],
    t.preparedFor
  )}
  ${pricedLines(data, t.total)}
  ${note(t.terms, data.terms)}
  ${note(t.notes, data.notes)}
  ${acceptance(t.acceptedBy)}`;
};

const resume = (data: Record<string, unknown>): string => {
  const entries = (value: unknown, title: string, org: string): string =>
    list(value, 12)
      .map((entry) => (entry ?? {}) as Record<string, unknown>)
      .filter((entry) => text(entry[title]).length > 0)
      .map(
        (entry) => `
    <div class="entry">
      <div class="entry-head"><span class="entry-title">${escape(text(entry[title], 160))}</span>${text(entry[org]).length > 0 ? `<span class="entry-org"> · ${escape(text(entry[org], 160))}</span>` : ""}<span class="entry-dates">${escape(text(entry.dates, 60))}</span></div>
      ${
        list(entry.points, 8).length > 0
          ? `<ul>${list(entry.points, 8)
              .map((point) => `<li>${escape(text(point, 400))}</li>`)
              .join("")}</ul>`
          : text(entry.detail).length > 0
            ? `<p>${escape(text(entry.detail, 600))}</p>`
            : ""
      }
    </div>`
      )
      .join("");
  const experience = entries(data.experience, "role", "organisation");
  const education = entries(data.education, "qualification", "institution");
  const skills = list(data.skills, 30)
    .map((skill) => text(skill, 60))
    .filter((s) => s.length > 0);
  const contact = lines(data.contact);

  return `
  <header class="resume-head">
    <h1>${escape(text(data.name, 120))}</h1>
    ${text(data.headline).length > 0 ? `<div class="headline">${escape(text(data.headline, 200))}</div>` : ""}
    ${contact.length > 0 ? `<div class="contact">${contact.map(escape).join('<span class="dot">·</span>')}</div>` : ""}
  </header>
  ${text(data.summary).length > 0 ? `<section><h2>${t.profile}</h2>${paragraphs(data.summary)}</section>` : ""}
  ${experience.length > 0 ? `<section><h2>${t.experience}</h2>${experience}</section>` : ""}
  ${education.length > 0 ? `<section><h2>${t.education}</h2>${education}</section>` : ""}
  ${skills.length > 0 ? `<section><h2>${t.skills}</h2><ul class="skills">${skills.map((s) => `<li>${escape(s)}</li>`).join("")}</ul></section>` : ""}`;
};

const letter = (data: Record<string, unknown>): string => `
  <header class="letter-head">
    <div class="party-name">${escape(text(data.from_name, 120))}</div>
    <div class="party">${block(data.from_details)}</div>
  </header>
  <div class="letter-date">${escape(text(data.date, 60))}</div>
  <div class="party letter-to">${text(data.to_name).length > 0 ? `${escape(text(data.to_name, 120))}<br />` : ""}${block(data.to_details)}</div>
  ${text(data.subject).length > 0 ? `<div class="letter-subject">${escape(text(data.subject, 200))}</div>` : ""}
  <div class="letter-body">
    <p>${escape(text(data.greeting, 120) || t.greeting)}</p>
    ${paragraphs(data.body)}
  </div>
  <div class="letter-sign">
    <p>${escape(text(data.closing, 60) || t.closing)}</p>
    <div class="party-name">${escape(text(data.signature_name, 120) || text(data.from_name, 120))}</div>
    ${text(data.signature_title).length > 0 ? `<div class="party">${escape(text(data.signature_title, 120))}</div>` : ""}
  </div>`;

/** Who signed, each with a line above the name; nameless entries are dropped. */
const signatures = (value: unknown): string =>
  list(value, 3)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => text(entry.name).length > 0)
    .map(
      (entry) => `
      <div class="signature"><span class="sign-line"></span><div class="party-name">${escape(text(entry.name, 80))}</div>${text(entry.title).length > 0 ? `<div class="party">${escape(text(entry.title, 80))}</div>` : ""}</div>`
    )
    .join("");

const certificate = (data: Record<string, unknown>): string => {
  const signed = signatures(data.signatories);
  const foot = [
    text(data.date, 60),
    text(data.number).length > 0 ? `${t.number} ${text(data.number, 40)}` : "",
  ].filter((each) => each.length > 0);
  return `
  <div class="cert-frame">
    ${text(data.issuer).length > 0 ? `<div class="cert-issuer">${escape(text(data.issuer, 120))}</div>` : ""}
    <h1 class="cert-title">${escape(text(data.title, 80) || t.certificate)}</h1>
    <div class="cert-presented">${escape(text(data.presented_line, 60) || t.certify)}</div>
    <div class="cert-name${text(data.recipient_name).length > 28 ? " long" : ""}">${escape(text(data.recipient_name, 120))}</div>
    <div class="cert-statement">${escape(text(data.statement, 120) || t.completed)}</div>
    <div class="cert-achievement${text(data.achievement).length > 60 ? " long" : ""}">${escape(text(data.achievement, 200))}</div>
    ${text(data.detail).length > 0 ? `<p class="cert-detail">${escape(text(data.detail, 300))}</p>` : ""}
    ${signed.length > 0 ? `<div class="cert-signatures">${signed}</div>` : ""}
    ${foot.length > 0 ? `<div class="cert-foot">${foot.map(escape).join('<span class="dot">·</span>')}</div>` : ""}
  </div>`;
};

/** A titled part of a longer form; nothing at all when it has no body. */
const part = (heading: string, body: string): string =>
  body.trim().length > 0
    ? `<section class="part"><h2>${heading}</h2>${body}</section>`
    : "";

/** `[{title, detail}]` or plain strings, as a numbered list of steps. */
const steps = (value: unknown): string => {
  const items = list(value, 10)
    .map((entry) =>
      typeof entry === "string"
        ? { title: text(entry, 200), detail: "" }
        : {
            title: text((entry as Record<string, unknown>)?.title, 200),
            detail: text((entry as Record<string, unknown>)?.detail, 600),
          }
    )
    .filter((entry) => entry.title.length > 0);
  return items.length > 0
    ? `<ol class="steps">${items.map((entry) => `<li class="step"><div class="step-title">${escape(entry.title)}</div>${entry.detail.length > 0 ? `<div class="step-detail">${escape(entry.detail)}</div>` : ""}</li>`).join("")}</ol>`
    : "";
};

const bullets = (value: unknown): string => {
  const items = list(value, 20)
    .map((each) => text(each, 300))
    .filter((each) => each.length > 0);
  return items.length > 0
    ? `<ul>${items.map((each) => `<li>${escape(each)}</li>`).join("")}</ul>`
    : "";
};

/** `[{phase, dates, detail}]` as a two-column plan. */
const timeline = (value: unknown): string => {
  const rows = list(value, 16)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => text(entry.phase).length > 0);
  return rows.length > 0
    ? `<table class="plan"><tbody>${rows.map((row) => `<tr><td class="plan-dates">${escape(text(row.dates, 60))}</td><td><div class="plan-phase">${escape(text(row.phase, 160))}</div>${text(row.detail).length > 0 ? `<div class="plan-detail">${escape(text(row.detail, 400))}</div>` : ""}</td></tr>`).join("")}</tbody></table>`
    : "";
};

const proposal = (data: Record<string, unknown>): string => {
  const meta = [
    [t.preparedFor, text(data.to_name, 120)],
    [t.preparedBy, text(data.from_name, 120)],
    [t.date, text(data.date, 40)],
    [t.reference, text(data.number, 40)],
    [t.validUntil, text(data.valid_until, 40)],
  ].filter(([, value]) => value.length > 0);
  const priced = invoiceTotals(data).rows.length > 0;
  const approach = Array.isArray(data.approach)
    ? steps(data.approach)
    : paragraphs(data.approach);
  return `
  <header class="proposal-head">
    <div class="form-kind">${t.proposal}</div>
    <h1>${escape(text(data.title, 160) || `${t.proposalFor} ${text(data.to_name, 120)}`)}</h1>
    <dl class="proposal-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(v)}</dd></div>`).join("")}</dl>
  </header>
  ${part(t.summary, paragraphs(data.summary))}
  ${part(t.challenge, paragraphs(data.problem))}
  ${part(t.approach, approach)}
  ${part(t.deliverables, bullets(data.deliverables))}
  ${part(t.timeline, timeline(data.timeline))}
  ${priced ? part(t.investment, pricedLines(data, t.total)) : ""}
  <div class="closing">
  ${part(t.terms, paragraphs(data.terms))}
  ${part(t.nextSteps, bullets(data.next_steps))}
  ${acceptance(t.acceptedBy)}
  </div>`;
};

type Question = {
  question: string;
  type: "choice" | "short" | "long";
  choices: string[];
  marks: number;
  answer: string;
};

const questionsOf = (value: unknown): Question[] =>
  list(value, 40)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .map((entry) => {
      const choices = list(entry.choices, 6)
        .map((choice) => text(choice, 200))
        .filter((choice) => choice.length > 0);
      const kind = text(entry.type);
      return {
        question: text(entry.question, 600),
        type:
          choices.length > 0
            ? ("choice" as const)
            : kind === "long"
              ? ("long" as const)
              : ("short" as const),
        choices,
        marks: Math.max(num(entry.marks), 0),
        answer: text(entry.answer, 600),
      };
    })
    .filter((entry) => entry.question.length > 0);

const marksLabel = (marks: number): string =>
  `${formatNumber(marks, language)} ${marks === 1 ? t.mark : t.marks}`;

/** Ruled lines to write on: two for a short answer, six for a long one. */
const answerLines = (count: number): string =>
  `<div class="answer-lines" style="--lines:${count}">${'<span class="write-line"></span>'.repeat(count)}</div>`;

const worksheet = (data: Record<string, unknown>): string => {
  const questions = questionsOf(data.questions);
  const total = questions.reduce((sum, each) => sum + each.marks, 0);
  const terms = list(data.key_terms, 20)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => text(entry.term).length > 0);
  const letters = "ABCDEF";
  const answered = questions
    .map((each, index) => ({ ...each, number: index + 1 }))
    .filter((each) => each.answer.length > 0);
  const subtitle = [text(data.subject, 80), text(data.level, 80)].filter(
    (each) => each.length > 0
  );
  const question = (each: Question, index: number): string => `
    <li class="question">
      <div class="q-head"><span class="q-number">${index + 1}</span><span class="q-text">${escape(each.question)}</span>${each.marks > 0 ? `<span class="q-marks">(${marksLabel(each.marks)})</span>` : ""}</div>
      ${
        each.type === "choice"
          ? `<ul class="choices">${each.choices.map((choice, at) => `<li><span class="choice-letter">${letters[at]}</span>${escape(choice)}</li>`).join("")}</ul>`
          : answerLines(each.type === "long" ? 6 : 2)
      }
    </li>`;

  return `
  <header class="sheet-head">
    <div>
      ${subtitle.length > 0 ? `<div class="form-kind">${subtitle.map(escape).join(" · ")}</div>` : ""}
      <h1>${escape(text(data.title, 160))}</h1>
    </div>
    ${total > 0 ? `<div class="sheet-total">${t.total}: ${marksLabel(total)}</div>` : ""}
  </header>
  ${
    data.name_lines === false
      ? ""
      : `<div class="student-lines"><div><span class="label">${t.name}</span><span class="sign-line"></span></div><div><span class="label">${t.className}</span><span class="sign-line"></span></div><div><span class="label">${t.date}</span><span class="sign-line"></span></div></div>`
  }
  ${text(data.instructions).length > 0 ? `<div class="instructions">${paragraphs(data.instructions)}</div>` : ""}
  ${part(t.keyPoints, bullets(data.key_points))}
  ${
    terms.length > 0
      ? part(
          t.keyTerms,
          `<dl class="terms">${terms.map((entry) => `<div><dt>${escape(text(entry.term, 120))}</dt><dd>${escape(text(entry.definition, 400))}</dd></div>`).join("")}</dl>`
        )
      : ""
  }
  ${questions.length > 0 ? part(t.questions, `<ol class="questions">${questions.map(question).join("")}</ol>`) : ""}
  ${
    data.show_answers !== false && answered.length > 0
      ? `<section class="answer-key"><h2>${t.answerKey}</h2><ol class="answers">${answered.map((each) => `<li><span class="q-number">${each.number}</span>${escape(each.answer)}</li>`).join("")}</ol></section>`
      : ""
  }`;
};

/** "+8 (+21%)": the change on last period, worked out here. */
const changeOf = (value: unknown, previous: unknown): string => {
  const now = plainNumber(value);
  const before = plainNumber(previous);
  if (now == null || before == null) return "";
  const delta = Math.round((now - before) * 100) / 100;
  const sign = (n: number): string => (n > 0 ? "+" : n < 0 ? "−" : "±");
  const percent =
    before === 0
      ? ""
      : ` (${sign(delta)}${formatPercent(Math.abs(Math.round((delta / before) * 100)), language)})`;
  const figure = formatNumber(Math.abs(delta), language);
  return `<span class="change ${delta > 0 ? "up" : delta < 0 ? "down" : "same"}">${sign(delta)}${figure}${percent}</span>`;
};

const activityReport = (data: Record<string, unknown>): string => {
  const metrics = list(data.metrics, 8)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter(
      (entry) => text(entry.label).length > 0 && text(entry.value).length > 0
    );
  const log = list(data.activities, 30)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => text(entry.activity).length > 0);
  const hasPeople = log.some((entry) => !absent(entry.people));
  const hasHours = log.some((entry) => !absent(entry.hours));
  const sum = (key: string): number =>
    Math.round(log.reduce((total, entry) => total + num(entry[key]), 0) * 100) /
    100;
  const cell = (value: unknown): string =>
    `<td>${escape(text(value, 40))}</td>`;
  const meta = [
    [t.period, text(data.period, 60)],
    [t.preparedBy, text(data.author, 120)],
    [t.date, text(data.date, 40)],
  ].filter(([, value]) => value.length > 0);

  const logTable =
    log.length > 0
      ? `<table class="items log">
    <thead><tr><th>${t.date}</th><th>${t.activity}</th>${hasPeople ? `<th>${t.people}</th>` : ""}${hasHours ? `<th>${t.hours}</th>` : ""}</tr></thead>
    <tbody>
${log.map((entry) => `      <tr>${cell(entry.date)}<td>${escape(text(entry.activity, 300))}${text(entry.detail).length > 0 ? `<div class="log-detail">${escape(text(entry.detail, 400))}</div>` : ""}</td>${hasPeople ? cell(entry.people) : ""}${hasHours ? cell(entry.hours) : ""}</tr>`).join("\n")}
${hasPeople || hasHours ? `      <tr class="log-total"><td></td><td>${t.total}</td>${hasPeople ? `<td>${formatNumber(sum("people"), language)}</td>` : ""}${hasHours ? `<td>${formatNumber(sum("hours"), language)}</td>` : ""}</tr>` : ""}
    </tbody>
  </table>`
      : "";

  return `
  <header class="proposal-head">
    <div class="form-kind">${escape(text(data.title, 80) || t.activityReport)}</div>
    <h1>${escape(text(data.organisation, 160))}</h1>
    <dl class="proposal-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(v)}</dd></div>`).join("")}</dl>
  </header>
  ${part(t.summary, paragraphs(data.summary))}
  ${
    metrics.length > 0
      ? part(
          t.keyFigures,
          `<div class="metrics">${metrics.map((entry) => `<div class="metric"><div class="metric-value">${escape(text(entry.value, 30))}</div><div class="metric-label">${escape(text(entry.label, 80))}</div>${changeOf(entry.value, entry.previous)}${text(entry.previous).length > 0 ? `<div class="metric-previous">${t.lastPeriod}: ${escape(text(entry.previous, 30))}</div>` : ""}</div>`).join("")}</div>`
        )
      : ""
  }
  ${part(t.activities, logTable)}
  <div class="outlook">
  ${part(t.highlights, bullets(data.highlights))}
  ${part(t.issues, bullets(data.issues))}
  ${part(t.nextSteps, bullets(data.next_steps))}
  </div>`;
};

/** The fields each kind needs before it can print: a blank invoice is no invoice. */
/**
 * An invoice's figures that are not plain numbers, each named with what was
 * written, so the filler rewrites them instead of the sums misreading them.
 */
export const unreadableNumbers = (form: DocumentForm): string[] => {
  const unread = (named: Array<[string, unknown]>): string[] =>
    named
      .filter(([, value]) => !absent(value) && plainNumber(value) == null)
      .map(([name, value]) => `${name} ${JSON.stringify(value)}`);
  if (form.kind === "activity_report")
    return unread([
      // A figure is read only to work out its change, so only with a previous one.
      ...list(form.data.metrics).flatMap(
        (item, index): Array<[string, unknown]> => {
          const row = (item ?? {}) as Record<string, unknown>;
          return absent(row.previous)
            ? []
            : [
                [`metrics[${index + 1}].value`, row.value],
                [`metrics[${index + 1}].previous`, row.previous],
              ];
        }
      ),
      ...list(form.data.activities).flatMap(
        (item, index): Array<[string, unknown]> => {
          const row = (item ?? {}) as Record<string, unknown>;
          return [
            [`activities[${index + 1}].people`, row.people],
            [`activities[${index + 1}].hours`, row.hours],
          ];
        }
      ),
    ]);
  if (form.kind === "worksheet")
    return list(form.data.questions)
      .map((item, index): [string, unknown] => [
        `questions[${index + 1}].marks`,
        ((item ?? {}) as Record<string, unknown>).marks,
      ])
      .filter(([, value]) => !absent(value) && plainNumber(value) == null)
      .map(([name, value]) => `${name} ${JSON.stringify(value)}`);
  if (!["invoice", "quote", "proposal"].includes(form.kind)) return [];
  const named: Array<[string, unknown]> = [
    ["discount", form.data.discount],
    ["tax_percent", form.data.tax_percent],
    ...list(form.data.items).flatMap(
      (item, index): Array<[string, unknown]> => {
        const row = (item ?? {}) as Record<string, unknown>;
        return [
          [`items[${index + 1}].quantity`, row.quantity],
          [`items[${index + 1}].unit_price`, row.unit_price],
        ];
      }
    ),
  ];
  return named
    .filter(([, value]) => !absent(value) && plainNumber(value) == null)
    .map(([name, value]) => `${name} ${JSON.stringify(value)}`);
};

/**
 * What a form would have to cut to fit: each field longer than its place and
 * each list with more entries than print, named with what was sent. Sent back
 * to the filler to shorten, rather than cut without a word.
 */
export const tooLong = (form: DocumentForm): string[] => {
  measured = { texts: new Map(), lists: new Map() };
  try {
    BODIES[form.kind](form.data);
    const quote = (value: string): string =>
      JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value);
    return [
      ...[...measured.texts]
        .filter(([value, max]) => value.length > max)
        .map(
          ([value, max]) =>
            `${quote(value)} is ${value.length} characters; ${max} fit`
        ),
      ...[...measured.lists]
        .filter(([value, max]) => value.length > max)
        .map(
          ([value, max]) =>
            `a list of ${value.length} entries starting ${quote(String(typeof value[0] === "object" ? JSON.stringify(value[0]) : value[0]))}; ${max} print`
        ),
    ];
  } finally {
    measured = null;
  }
};

export const missingFields = (form: DocumentForm): string[] => {
  const data = form.data;
  const priced: Array<[string, boolean]> = [
    ["from_name", text(data.from_name).length > 0],
    ["to_name", text(data.to_name).length > 0],
    ["items", invoiceTotals(data).rows.length > 0],
  ];
  const need: Record<FormKind, Array<[string, boolean]>> = {
    invoice: priced,
    quote: priced,
    resume: [
      ["name", text(data.name).length > 0],
      [
        "experience or education",
        list(data.experience).length + list(data.education).length > 0,
      ],
    ],
    letter: [
      ["from_name", text(data.from_name).length > 0],
      ["body", paragraphs(data.body).length > 0],
    ],
    proposal: [
      ["from_name", text(data.from_name).length > 0],
      ["to_name", text(data.to_name).length > 0],
      [
        "summary or approach",
        text(data.summary).length > 0 ||
          list(data.approach).length > 0 ||
          text(data.approach).length > 0,
      ],
    ],
    activity_report: [
      ["organisation", text(data.organisation).length > 0],
      ["period", text(data.period).length > 0],
      [
        "summary, metrics or activities",
        text(data.summary).length > 0 ||
          list(data.metrics).length + list(data.activities).length > 0,
      ],
    ],
    worksheet: [
      ["title", text(data.title).length > 0],
      [
        "questions, key_terms or key_points",
        questionsOf(data.questions).length +
          list(data.key_terms).length +
          list(data.key_points).length >
          0,
      ],
    ],
    certificate: [
      ["recipient_name", text(data.recipient_name).length > 0],
      ["achievement", text(data.achievement).length > 0],
    ],
  };
  return need[form.kind]
    .filter(([, present]) => !present)
    .map(([name]) => name);
};

const BODIES: Record<FormKind, (data: Record<string, unknown>) => string> = {
  invoice,
  quote,
  resume,
  letter,
  certificate,
  proposal,
  worksheet,
  activity_report: activityReport,
};

/**
 * How a kind is printed when it is not an ordinary A4 portrait page with
 * margins: a certificate is one landscape sheet framed to its edges.
 */
export const formPage = (
  kind: FormKind
): { landscape?: true; fullBleed?: true } =>
  kind === "certificate" ? { landscape: true, fullBleed: true } : {};

const FILLS_PAGE = new Set<FormKind>([
  "resume",
  "letter",
  "worksheet",
  "activity_report",
]);

/** The `<article>` for a filled form; the shell and stylesheet are the renderer's. */
export const formArticle = (form: DocumentForm, lang = "en"): string => {
  t = labelsFor(lang);
  language = languageOf(lang);
  let body: string;
  try {
    body = BODIES[form.kind](form.data);
  } finally {
    t = labelsFor("en");
    language = "en";
  }
  // A resume or letter is one page and grows to use it (see document-fill).
  // An activity report is a one-page summary by design: it may go a little
  // smaller than a resume before it spills onto a second sheet.
  const fill = FILLS_PAGE.has(form.kind)
    ? form.kind === "activity_report"
      ? ' data-fill-page data-fill-min="0.85"'
      : " data-fill-page"
    : "";
  return `<article class="doc form form-${form.kind}"${fill}>${body}\n</article>`;
};
