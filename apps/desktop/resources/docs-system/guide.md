# Writing a document or deck with the design system

You write one HTML file. It links the app's stylesheet, which owns the type, spacing, colour and fonts. You write the content and choose components. Code then:
- works out every sum;
- draws the charts;
- fits the pages;
- prints the PDF, the PowerPoint and the Word file.

Never write your own `<style>` for fonts or sizes. Add a few lines of layout CSS only if you really need it.

## Skeleton
```html
<!doctype html>
<html lang="en-GB" data-accent="teal">   <!-- lang = the document's language (pt-BR, bn, en-IN…); accent: teal, indigo, green, orange, plum, slate, red -->
<head><meta charset="utf-8"><title>…</title><link rel="stylesheet" href="system.css"></head>
<body class="doc"> … </body>             <!-- doc = A4 pages; deck = slides; doc bleed = one poster page -->
</html>
```
Pick the accent to suit the subject. Use one accent. A document also takes a look on `<html>`: `data-look="editorial"` (serif, for essays, notes and reports to read), `bold` (strong bars, for plans and pitches), `minimal` (quiet and technical), `warm` (serif headings, terracotta, for community, food and personal documents), `midnight` (navy, for tech and finance); leave it out for the classic look. For reports and notes, prefer indigo or plum, the palettes users liked best; a quiz or worksheet prints in black ink whatever you pick.

## Documents (`<body class="doc">`)
A4 with margins and page numbers added by the printer. Content flows across pages.
- **Opening:**
  - Either a header block: `<div class="doc-head"><div><p class="kicker">Oakline Furniture</p><h1>Q3 2026 Sales Report</h1></div><div class="meta">July–September 2026<br>Prepared 15 Nov 2026</div></div>`.
  - Or a cover page, when one is asked for or the document is long (6+ pages): `<div class="cover"><div class="top"><div class="logo"><img src="…the user's logo…" alt="…"></div><p class="kicker">School</p><h1>Title</h1><p class="lead">Subtitle</p></div><div class="meta-grid"><div><span>Time</span><b>30 minutes</b></div>…</div><div class="fields"><div class="field">Name</div><div class="field">Class</div></div><p class="small muted">Instructions…</p></div>`. The `.top` prints as a solid accent band down to the details; the logo (only one the user gave) sits on a white tile in it.
- **Summary band** (a report's first block, under the header): `<div class="summary-band"><p class="lead">The one-sentence story.</p><div class="tiles">…3 or 4 tiles…</div></div>`.
- **Text beside a chart:** `<div class="split"><div>…h3, p, ul…</div><figure class="chart" …></figure></div>`.
- **Hero figure** (the one number that matters): `<div class="hero-figure"><div class="value">…</div><div><h3>…</h3><p>…</p></div></div>`.
- **Text:** `h2` for sections, `h3` for sub-sections, `p`, `ul/ol`. Use `<p class="lead">` for a one-line summary under the title.
- **Key figures:** `<div class="tiles"><div class="tile"><span class="value">£186,400</span><span class="label">Revenue, Q3</span><span class="delta up">+8.4% on Q2</span></div>…</div>`. Use 2 to 4 tiles for the numbers that matter most.
- **Tables:** `<table class="data">` with `<th>` headers; numbers in `class="num"` cells.
- **Callout:** `<div class="callout"><p>…</p></div>`, for the one thing to remember, or a recommendation.
- **Steps:** `<ol class="steps"><li><b>Set Qd = Qs</b> …</li></ol>`.
- **Timeline:** `<div class="timeline"><div><div class="when">October</div>Switch delivery partner</div>…</div>`.
- **Columns:** `<div class="cols-2">…</div>` or `cols-3`.
- **Page break:** `<div style="break-before: page"></div>`, e.g. before an answer key.
- **One-page report with charts** (a monthly report, a dashboard, "one page"): the header, a summary band, then panels: `<div class="dash"><div class="panel"><h3>Sales by week</h3><figure class="chart" data-chart="bar" …></figure></div><div class="panel"><h3>…</h3>…</div><div class="panel wide"><h3>Next month</h3><ul>…</ul></div></div>`. Two panels side by side; `wide` spans the page.
- **Questions answered** (an assignment, an FAQ, interview answers): one block per question: `<div class="qa"><div class="q"><span class="n">Q1</span><span>What is a process?</span></div><div class="a"><p>…</p></div></div>`.

## Résumé / CV (`<body class="doc">`, one page unless asked)
```html
<div class="cv-head"><h1>Grace Mensah</h1><p class="role">Registered Nurse · seeking a Ward Manager role</p><p class="contact">Leicester · grace@example.com · 07700 900123</p></div>
<div class="cv-body">
  <main><h2>Profile</h2><p>…</p><h2>Experience</h2>
    <div class="job"><div class="when">2021 – now</div><div><h3>Senior Staff Nurse</h3><p class="org">Acute Medical Unit, Leicester Royal Infirmary</p><ul><li>…</li></ul></div></div>
  </main>
  <aside><h2>Skills</h2><ul><li>…</li></ul><h2>Education</h2><p>…</p><h2>Certificates</h2><ul>…</ul></aside>
</div>
```
Only the person's own facts: no invented achievements, figures or referees.

Asked for a résumé with no details of the person, or only the role and years ("a resume for a fresher software engineer", "main ek teacher hoon 5 saal ka experience"): write a finished one-page sample for that profile, with no fill-in lines and no brackets. The name reads `Your Name`, the contact line `City · you@example.com · phone`; the profile, skills, two or three short typical projects and the education (degree and subject, no grades, years or college name) are written out in full as a sample to edit, specific to that job (a teacher: the subjects, classes and methods; a marketer: the campaigns and channels), two bullets an entry. Fill the page; no figures.

## Certificate (`<body class="doc bleed landscape">`, one A4 sheet sideways)
```html
<div class="certificate"><div class="frame">
  <div class="logo"><img src="…the user's logo…" alt="…"></div>   <!-- only if the user gave one -->
  <p class="kicker">Northside Training Centre</p><h1>Certificate of Completion</h1>
  <p class="presented">This certifies that</p><div class="name">Amara Okoye</div>
  <p class="for">has completed the three-day <b>First Aid at Work</b> course, on 14 November 2026.</p>
  <div class="signs"><div>Paul Hendry<span>Course Lead</span></div><div>14 November 2026<span>Date</span></div></div>
</div></div>
```
Sign-off lines only for people the user named.

## Menu or price list (a poster: `<body class="doc bleed">`)
Inside the poster's `.body`: `<div class="menu"><section><h2>Breakfast</h2><div class="item"><span class="name">Full English</span><span class="price">£9.50</span><p class="desc">…</p></div>…</section>…</div>`. Code draws the dotted line to each price; prices exactly as the user gave them.

## Numbers you work out: never type them
Any number that is not written in the brief, but worked out from it (a share, a change, a total, a per-month or per-unit figure), goes in `data-calc` as arithmetic on the brief's own numbers. Code computes and formats it:
```html
<span data-calc="8.3 * 28 / 100" data-dp="1" data-prefix="₹" data-suffix=" lakh"></span>   <!-- 28% of ₹8.3 lakh -->
<span data-calc="(186400 - 171900) / 171900 * 100" data-dp="1" data-suffix="%"></span>   <!-- growth on Q2 -->
```
- Use only numbers from the brief (or unit constants such as 12, 30, 100) and `+ - * / ( )`.
- A number that is neither in the brief nor computed this way is sent back, and then left out.
- When you are unsure, leave a derived number out rather than guess.

## Money: never type an amount you could work out
```html
<table class="data" data-currency="BRL">            <!-- ISO code: GBP, BRL, INR, EUR, USD… -->
  <tr><th>Descrição</th><th class="num">Qtd.</th><th class="num">Valor unit.</th><th class="num">Total</th></tr>
  <tr data-qty="420" data-unit="28"><td>Pintura da fachada</td><td class="num">420 m²</td><td class="num" data-cell="unit"></td><td class="num" data-cell="amount"></td></tr>
  <tr data-amount="1900"><td>Lavagem</td><td class="num">1</td><td></td><td class="num" data-cell="amount"></td></tr>
  <tr data-role="subtotal"><td colspan="3">Subtotal</td><td class="num" data-cell="amount"></td></tr>
  <tr data-role="discount" data-pct="5"><td colspan="3">Desconto à vista (5%)</td><td class="num" data-cell="amount"></td></tr>
  <tr data-role="tax" data-pct="20"><td colspan="3">VAT 20%</td><td class="num" data-cell="amount"></td></tr>   <!-- only if there is tax -->
  <tr data-role="total"><td colspan="3">Total</td><td class="num" data-cell="amount"></td></tr>
</table>
<p>Total à vista: <b data-ref="total"></b></p>     <!-- data-ref="subtotal|discount|tax|total" repeats a figure anywhere -->
```
Several taxes are several tax rows, each with its own `data-pct`, all in the same table above the total: Indian GST at 18% within a state is `<tr data-role="tax" data-pct="9">…CGST 9%…` and `<tr data-role="tax" data-pct="9">…SGST 9%…` (IGST 18% across states). Never put tax in a separate table.

Use a `data-currency` table only for priced line items (a quote, an invoice, a price list). Figures in a report go in an ordinary `table.data`.

`data-qty`, `data-unit`, `data-amount` and `data-pct` are plain numbers (`28`, not `R$ 28,00`). Leave the cells empty; code fills them, formatted for the document's language.

## Marks: never type a marks total
```html
<div class="section">
  <div class="section-head"><h2>Section A — Multiple choice</h2><span class="marks" data-ref="section-marks"></span></div>
  <div class="question" data-q="1" data-marks="1">
    <div class="q"><span>1. Which planet is closest to the Sun?</span><span class="marks"></span></div>
    <div class="options"><span>A Venus</span><span>B Mercury</span><span>C Earth</span><span>D Mars</span></div>
  </div>
  <div class="question" data-q="7" data-marks="3">
    <div class="q"><span>7. Explain why the Earth has seasons.</span><span class="marks"></span></div>
    <div class="answer-lines"><i></i><i></i><i></i></div>
  </div>
</div>
<p>Total: <b data-ref="total-marks"></b> marks</p>
<!-- In an answer key: <span data-ref="marks-of" data-q="7"></span> marks -->
```
- Code labels each question, each section and the total, and checks the total against the brief.
- If the brief asks for 30 marks, choose `data-marks` so they add up to 30.

## Charts and diagrams: drawn by code from your numbers
- **Bar chart:** `<figure class="chart" data-chart="bar" data-values='[["Q2",171900],["Q3",186400]]' data-prefix="£"><figcaption>Revenue by quarter</figcaption></figure>`
- **Line diagram** (supply and demand, trends):
  ```html
  <!-- Example for Qd = 80 − Q and Qs = 20 + Q (P = 50, Q = 30). Work out the points from YOUR equations. -->
  <figure class="chart" data-chart="lines" data-axes='["Quantity (Q)","Price (P)"]'
    data-lines='[{"label":"D","points":[[0,80],[80,0]]},{"label":"S","points":[[0,20],[60,80]]}]'
    data-points='[{"x":30,"y":50,"label":"Equilibrium"}]'
    data-hlines='[{"y":40,"label":"Price ceiling"}]'><figcaption>…</figcaption></figure>
  ```
- **Growth curve** (a rate per period, computed by code): `<figure class="chart" data-chart="growth" data-start="1850" data-rate="14" data-periods="6" data-period="month"><figcaption>Meals a day at 14% a month</figcaption></figure>`
- **Share of a whole** (three or more parts; the rest is drawn by code, with no number or label, since it is not a fact you were given): `<figure class="chart" data-chart="share" data-parts='[["Tiffinly keeps",28],["Home cook","rest"]]'></figure>`
- **Put a chart wherever there is a series:** figures over time, a growth rate, three or more parts of a whole, or three or more items that compare. A report or deck without one, when the brief has such figures, is sent back.
- **Two values, or a whole in two parts, are not a chart:** show them as tiles or in the sentence. Never show the same number twice on one slide. Code prints such a chart as plain numbers, or leaves it out when the numbers are already shown.
- A diagram takes at most half a page; code sizes it and places its labels.
- Use a chart when the subject is taught with a diagram.
- **A diagram to label** (a question that asks pupils to label a picture): draw it from simple shapes in a 100 x 60 box (x to the right, y down), and put a mark on each part to be named; code numbers the marks (or letters them, with `data-mark-style="letters"`) and writes an answer line for each under the picture, so write no lines or dots of your own and never describe a picture in words instead:
  ```html
  <figure class="chart" data-chart="label"
    data-shapes='[{"circle":[6,30,6],"fill":"dark","text":"Sun"},{"ring":[6,30,18]},{"circle":[24,30,2]},{"ring":[6,30,34]},{"circle":[40,30,3]}]'
    data-marks='[[24,30],[40,30]]'><figcaption>The Sun and the first two planets</figcaption></figure>
  ```
  Shapes: `circle` [x,y,r], `ring` [x,y,r] (a dashed orbit or outline), `ellipse` [x,y,rx,ry], `rect` [x,y,w,h], `line` and `arrow` [x1,y1,x2,y2]; `"fill":"dark"` or `"light"`, and `"text"` only for a part that is given, never for one pupils must name. The answer key lists each number with its name.
- A question that asks pupils to order things is not a chart: list the items with answer lines or empty boxes beside them. Never draw bars or lines for it.
- Use only the user's numbers, or numbers worked out from them. A diagram of an equation the user gave must use that equation: every point you mark has to lie on its lines.

## Letters (`<body class="doc">`)
```html
<div class="letter">
  <div class="from">Daniel Ortiz<br>Flat 2, 17 Elm Road<br>Cardiff CF24 3AB</div>
  <div class="to">Mrs Helen Price<br>Price Lettings<br>40 Queen Street<br>Cardiff CF10 2BU</div>
  <div class="date">14 November 2026</div>
  <p>Dear Mrs Price,</p>
  <p class="subject">Re: …</p>
  <p>…</p>
  <div class="closing"><p>Yours sincerely,</p><p class="signature">Daniel Ortiz</p></div>
</div>
```

## Posters: flyers and notices (`<body class="doc bleed">`, exactly one page)
```html
<div class="poster">
  <div class="band"><p class="kicker">Lotus Room Yoga · Nottingham</p><h1>Open Day</h1><div class="when">Saturday 6 December 2026 · 10am–3pm</div></div>
  <div class="body"> … a table.data of times, tiles for offers, <p class="big"> for the key line … </div>
  <div class="foot">Book: lotusroom.example/openday · 0115 496 0321</div>
</div>
```
- Large type: the poster must read from a distance. A notice puts each point in its own `<p class="big">`.
- A timetable is a `table.data` (time first); offers or extras go in `<div class="offers"><p>20% off a 10-class pass</p><p>Free herbal tea</p></div>`.
- Code shrinks it to fit if it runs over, so put the most important line in the band or the foot.

## Invitations (a party, a wedding, an event: `<body class="doc bleed">`, exactly one page)
`<div class="poster invite"><div class="band"><p class="kicker">You're invited</p><h1>Maya turns 7!</h1><p class="when">Saturday 6 December · 3–6pm</p></div><div class="body"><p class="big">Sunflower Hall, 12 Park Road</p><p>Games, cake and a magic show. Come as your favourite animal!</p></div><div class="foot">RSVP to Anna, 07700 900456, by 1 December</div></div>`. Only the details the user gave; leave out a line rather than invent a date, place or name.

## Decks (`<body class="deck">`, one `<section class="slide">` per slide, 1280×720)
Every slide uses one of these layouts. Each fills the slide on its own; do not leave content floating in the top half. Under the title, put the content in `<div class="body">…</div>`; it takes the rest of the slide.

| Slide | Layout |
|---|---|
| Opening | `<section class="slide cover"><p class="kicker">Seed round · Pune · 2026</p><h1>Tiffinly</h1><p class="lead">Home-cooked lunch, at your desk by 1pm</p><div class="meta"><span>Raising<b>₹4 crore</b></span><span>Meals a day<b>1,850</b></span></div></section>`. Two more looks: `cover light` (white, an accent bar; reports, lectures, research) and `cover split` with 2 to 4 key figures beside the title: `<section class="slide cover split"><div class="title"><p class="kicker">…</p><h1>…</h1><p class="lead">…</p></div><div class="meta"><span>Beta sign-ups<b>12,400</b></span>…</div></section>`. |
| What the talk covers | `<section class="slide agenda"><p class="kicker">Today</p><h2>Agenda</h2><div class="body"><ol><li>Where we are</li>…3 to 8…</ol></div></section>` |
| A picture the user gave, with its point | `<section class="slide picture"><figure><img src="…" alt="…"><figcaption>…</figcaption></figure><div class="side"><p class="kicker">…</p><h2>…</h2><p>…</p></div></section>` |
| A roadmap: workstreams over quarters or months | `<section class="slide roadmap"><p class="kicker">…</p><h2>…</h2><div class="body"><div class="scale"><span>Q1</span><span>Q2</span><span>Q3</span><span>Q4</span></div><div class="lane"><h3>App</h3><div class="bar" data-from="1" data-to="1">Beta</div><div class="bar soft" data-from="3" data-to="4">Payments</div></div>…2 to 4 lanes…</div></section>` (3 to 6 periods; `data-from`/`data-to` count periods from 1) |
| The one number that matters | `<section class="slide hero"><div class="panel"><div class="value">70%</div><div class="label">of 300 employees eat out daily</div></div><div class="side"><p class="kicker">Problem</p><h2>Office lunch is expensive and unhealthy</h2><ul>…2 or 3 points…</ul></div></section>` |
| A series, growth or share, with its meaning | `<section class="slide split"><p class="kicker">Traction</p><h2>1,850 meals a day, growing 14% a month</h2><div class="body"><div class="text"><div class="tiles">…2 tiles…</div><p>…</p></div><figure class="chart" data-chart="growth" …></figure></div></section>` |
| 3 or 4 key figures | `<section class="slide"><p class="kicker">…</p><h2>…</h2><div class="body"><div class="tiles">…3 or 4 tiles…</div></div></section>` |
| Options side by side | `<section class="slide compare"><p class="kicker">Competition</p><h2>…</h2><div class="body"><div class="col"><h3>Swiggy / Zomato</h3><div class="value">₹250+</div><p>Restaurant food</p></div>…<div class="col us"><h3>Tiffinly</h3><div class="value">₹149</div><p>Home-cooked</p></div></div></section>` |
| Steps, plans, a roadmap | `<section class="slide timeline"><p class="kicker">…</p><h2>…</h2><div class="body"><div><div class="when">Now</div><div class="step">…</div></div>…3 to 5…</div></section>` |
| Reasons, ideas, people | `<section class="slide grid"><p class="kicker">…</p><h2>…</h2><div class="body"><div class="card"><div class="num">1</div><h3>…</h3><p>…</p></div>…2 to 4…</div></section>` |
| One line to remember | `<section class="slide statement"><h2>…</h2></section>` |
| The ask, or thank you | `<section class="slide closing"><p class="kicker">The ask</p><h2>₹4 crore seed for 18 months</h2><p class="lead">…</p></section>` (`closing light` to match a light cover) |

- Open with a cover, and close with a closing slide or the ask. Pick the cover look that suits the subject; do not always use the plain one.
- A picture the user gave goes on a `picture` slide (or a `figure` in a document), never left out.
- Vary the layouts: no two slides in a row the same.
- One idea per slide: at most about 30 words of body text, and at most 3 bullets.
- Numbers go in tiles, a hero panel, a compare column or a chart, never in sentences.
- Give the number of slides asked for. A "Slide N:" outline from the user maps one to one.
- Add `<div class="foot"><span>Tiffinly</span><span>4</span></div>` to content slides.
- Speaker notes, when asked for: `<aside class="notes">…</aside>` as the slide's last child. They go into the PowerPoint's notes and never show on the slide.

## Content rules
- **Write in the user's language and script:** Hindi typed in Latin letters (Hinglish: "mera resume bana do") gets Hinglish or English in Latin letters, never Devanagari, unless the user asks for Devanagari.
- **Use every fact, figure, name and date the user gave, exactly.**
- **Invent nothing that reads as a fact:** no figures, dates, quotes, names or contact details. Today's date is given; use it only where a date is needed.
- **Derived numbers** (a share, a change, a per-unit figure) only through `data-calc`. Never type them.
- **Give the task the structure it needs:**
  - a quiz: marks and an answer key;
  - a quote: line items, terms, validity and acceptance;
  - minutes: present, items, decisions, and an actions table with owners and dates;
  - a letter: addresses, date, subject, the ask with its deadline, sign-off.
- **A header the user asks for** ("the society name in the header"): `<p class="running">Green Park Apartments</p>` first in the body. Word puts it in every page's header; the PDF prints it small at the top. Page numbers are always in the footer.
- **Fit the length asked for.** With no length asked, a report is about 6 pages. No filler.
- **A detail the document needs that the user did not give** (the person's name, college, roll number, the event's date or place): write it as `[Employee name]` where it goes. On a certificate, invitation or invoice it prints as a ruled line to fill in; in a letter, flyer, proposal or report as a highlighted placeholder in the sentence. Write everything else as natural sample wording (a flyer describes the classes in general; a leave letter asks politely for the leave), so a page has a few placeholders, never a form of lines. Never invent a person. A template to fill in later (a sales report whose figures the user will add) is at most 2 pages: one table per kind of figure. Keep blanks few: one per missing detail (name, contact, college, dates), never one per bullet; a résumé with no details still fits one page, with short sections (two projects, one line each).
- **A quiz, worksheet or test is a paper to fill in:** it prints plain (black ink, thin rules). Put the questions and their answer space first. Use a cover only when one is asked for (it prints as a compact header at the top of page 1, with the questions under it), and add no overview tiles, summary band, charts, coloured boxes or styles of your own; a diagram to label (data-chart="label") is the one figure a question may have.
