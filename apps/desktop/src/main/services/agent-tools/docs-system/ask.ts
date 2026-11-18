/**
 * What a brief asks for, read in code so the checks do not depend on the model
 * remembering it: a marks total, one page, a slide count, the formats named.
 */
export type Ask = {
  totalMarks: number | null;
  onePage: boolean;
  slides: number | null;
  formats: Array<"pdf" | "pptx" | "docx">;
  /**
   * teaching: quizzes, notes, assignments (general knowledge, so numbers need
   * not be in the brief); form: quotes, letters, minutes, resumes, notices,
   * flyers; report: reports and decks built on the user's figures.
   */
  genre: "teaching" | "form" | "report";
  /**
   * A paper someone fills in (a quiz, worksheet, test): printed plainly, the
   * questions and answer space first (round 4: "for a quiz there is no need
   * for an appealing design, only the questions need to be clear").
   */
  plain: boolean;
};

export const readAsk = (brief: string): Ask => {
  // Every total the brief states, and the largest is the quiz's own (a
  // section's "12 marks total" is not the paper's "Total: 30 marks").
  const totals: number[] = [];
  const grab = (re: RegExp): void => {
    for (const m of brief.matchAll(re)) totals.push(Number(m[1]));
  };
  grab(/\btotal\s*:?\s*(?:of\s+)?(\d{1,3})\s*marks\b/gi);
  grab(/\b(\d{1,3})\s+marks\s+(?:in\s+all|in\s+total|total|altogether)\b/gi);
  grab(/\bworth\s+(\d{1,3})\s+marks\b/gi);
  if (/\bmarks?\b/i.test(brief)) {
    grab(/\bout\s+of\s+(\d{1,3})\b/gi);
    grab(
      /\btotal\s*:?\s*(\d{1,3})\b(?!\s*(?:%|minutes|pages|slides|questions))/gi
    );
  }
  const totalMarks = totals.length > 0 ? Math.max(...totals) : null;

  const onePage =
    // Not a one-page part of a longer document ("7. One-page summary").
    /\b(one|1)[- ]page\b(?![- ](summary|section|overview|recap|cheat ?sheet|appendix|table))/i.test(
      brief
    ) || /\b(flyer|poster|notice)\b/i.test(brief);

  // On one line, so "Group 4" ending a line before "Slide 2:" is not a count.
  const written = brief.match(/\b(\d{1,2})[ \t]+slides?\b(?![ \t]*\d)/i);
  const listed = brief.match(/^\s*slide\s+\d+\s*:/gim)?.length ?? 0;

  const formats: Ask["formats"] = [];
  // A real ask for Word, not "word bank" or "in a word".
  if (
    /\b(in|as|into|to)\s+(a\s+|an\s+)?(microsoft\s+)?word\b(?!\s+bank)|\bword\s+(document|doc|file|format|version|copy)\b|\.docx\b|\bdocx\b/i.test(
      brief
    )
  )
    formats.push("docx");
  if (/\b(powerpoint|pptx|ppt|slides|deck)\b/i.test(brief))
    formats.push("pptx");
  if (/\bpdf\b/i.test(brief) || formats.length === 0) formats.push("pdf");

  const genre: Ask["genre"] =
    /\b(quiz|worksheet|study (notes|guide)|revision|lecture|assignment|lesson|exam|homework)\b/i.test(
      brief
    )
      ? "teaching"
      : /\b(or[çc]amento|quote|invoice|letter|minutes|resume|cv|notice|flyer|poster|certificate)\b/i.test(
            brief
          )
        ? "form"
        : "report";

  return {
    genre,
    plain:
      genre === "teaching" &&
      /\b(quiz(zes)?|worksheets?|tests?|exams?|exam paper|homework|answer sheet)\b/i.test(
        brief
      ) &&
      !/\b(revision|lecture|study) notes\b/i.test(brief),
    totalMarks,
    onePage,
    slides: listed > 0 ? listed : written ? Number(written[1]) : null,
    formats:
      formats.includes("pptx") && !/\bpdf\b/i.test(brief) ? ["pptx"] : formats,
  };
};
