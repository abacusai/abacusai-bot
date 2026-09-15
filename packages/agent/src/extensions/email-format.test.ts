/** Markdown never reaches a Gmail recipient raw. */
import { describe, expect, it } from "vitest";

import {
  formatGmailInput,
  looksLikeMarkdown,
  markdownToHtml,
  markdownToText,
} from "./email-format.js";

const BRIEF = `## What actually needs you (4 items)

**1. ₹5,00,000 left the account — HDFC A/c XX3224** *(changed since 2:31 PM)*
Two debits, not one:
- 9:00:56 AM IST — ₹5,00,000.00 to \`IB FUNDS TRANSFER DR-8375\`.
- 9:09:01 AM IST — ₹3,00,000.00 to payee **Sudhanshu Kumar Dey**.
→ The earlier report only had the ₹3L leg.

**2. Ramain AI — Founding Engineer**
Asks: a quick chat **this week**. See [the posting](https://example.com/job?id=1&x=2).

---

1. First step
2. Second step

> Nothing.`;

describe("recognising markdown", () => {
  it("spots headings, emphasis, lists, code and links", () => {
    expect(looksLikeMarkdown(BRIEF)).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("Call **now**.")).toBe(true);
  });

  it("leaves prose alone", () => {
    expect(
      looksLikeMarkdown("Hi Alice,\n\nThanks for the call today. Talk soon.")
    ).toBe(false);
    expect(looksLikeMarkdown("Total was 5 * 3 = 15 and 2*4.")).toBe(false);
  });
});

describe("markdown to HTML", () => {
  const html = markdownToHtml(BRIEF);

  it("renders headings one level down, never as h1", () => {
    expect(html).toContain("<h3>What actually needs you (4 items)</h3>");
    expect(html).not.toContain("<h1>");
  });

  it("renders emphasis, code, links and lists", () => {
    expect(html).toContain("<strong>Sudhanshu Kumar Dey</strong>");
    expect(html).toContain("<em>(changed since 2:31 PM)</em>");
    expect(html).toContain("<code>IB FUNDS TRANSFER DR-8375</code>");
    expect(html).toContain(
      '<a href="https://example.com/job?id=1&amp;x=2">the posting</a>'
    );
    expect(html).toContain("<ul><li>9:00:56 AM IST");
    expect(html).toContain("<ol><li>First step</li><li>Second step</li></ol>");
    expect(html).toContain("<blockquote>Nothing.</blockquote>");
    expect(html).toContain("<hr>");
  });

  it("leaves no markdown syntax behind", () => {
    expect(html).not.toMatch(/\*\*|`|^#|\]\(/m);
  });

  it("escapes HTML in the source", () => {
    expect(markdownToHtml("a <b> & c")).toBe(
      "<div><p>a &lt;b&gt; &amp; c</p></div>"
    );
  });

  it("keeps line breaks inside a paragraph", () => {
    expect(markdownToHtml("one\ntwo")).toBe("<div><p>one<br>two</p></div>");
  });
});

describe("markdown to text", () => {
  const text = markdownToText(BRIEF);

  it("drops the syntax and keeps the structure", () => {
    expect(text).toContain("WHAT ACTUALLY NEEDS YOU (4 ITEMS)");
    expect(text).toContain(
      "- 9:00:56 AM IST — ₹5,00,000.00 to IB FUNDS TRANSFER DR-8375."
    );
    expect(text).toContain("1. First step\n2. Second step");
    expect(text).toContain("the posting (https://example.com/job?id=1&x=2)");
    expect(text).toContain("> Nothing.");
    expect(text).not.toMatch(/\*\*|`|^#|---/m);
  });
});

describe("rewriting a Gmail call", () => {
  it("sends a markdown body as HTML", () => {
    const input = { action: "send_email", to: ["a@x.com"], body: BRIEF };

    expect(formatGmailInput(input)).toBe(true);
    expect(input.body).toContain("<h3>");
    expect((input as { is_html?: boolean }).is_html).toBe(true);
  });

  it("does the same for a draft", () => {
    const input = { action: "create_draft_email", body: "**hi**" };

    expect(formatGmailInput(input)).toBe(true);
    expect(input.body).toBe("<div><p><strong>hi</strong></p></div>");
  });

  it("leaves a body the model already marked as HTML alone", () => {
    const input = {
      action: "send_email",
      body: "<p>**not markdown**</p>",
      is_html: true,
    };

    expect(formatGmailInput(input)).toBe(false);
    expect(input.body).toBe("<p>**not markdown**</p>");
  });

  it("leaves plain prose alone", () => {
    const input = { action: "send_email", body: "Hi Alice, thanks." };

    expect(formatGmailInput(input)).toBe(false);
    expect(input).not.toHaveProperty("is_html");
  });

  it("flattens a reply, which the connector only takes as text", () => {
    const input = {
      action: "reply_to_email",
      query: "rfc822msgid:x",
      reply_body: "Thanks — **yes**, Thursday works.\n\n- 3pm\n- 4pm",
    };

    expect(formatGmailInput(input)).toBe(true);
    expect(input.reply_body).toBe(
      "Thanks — yes, Thursday works.\n\n- 3pm\n- 4pm"
    );
  });

  it("converts each bulk body, in whichever shape it came", () => {
    const input = {
      action: "send_bulk_emails",
      emails: [
        { to: ["a@x.com"], body: JSON.stringify({ text: "**Hi Alice**" }) },
        { to: ["b@x.com"], body: { text: "## Hi Bob" } },
        { to: ["c@x.com"], body: JSON.stringify({ text: "Hi Carol." }) },
      ],
    };

    expect(formatGmailInput(input)).toBe(true);
    expect(JSON.parse(input.emails[0]!.body as string)).toEqual({
      html: "<div><p><strong>Hi Alice</strong></p></div>",
    });
    expect(input.emails[1]!.body).toEqual({
      html: "<div><h3>Hi Bob</h3></div>",
    });
    expect(input.emails[2]!.body).toBe(JSON.stringify({ text: "Hi Carol." }));
  });

  it("ignores other actions and other tools' shapes", () => {
    expect(formatGmailInput({ action: "search_email", body: "**x**" })).toBe(
      false
    );
  });
});
