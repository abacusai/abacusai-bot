// Is the text between single $ signs math, not currency, prose or markdown?
// Deliberately conservative.
const looksLikeMath = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed) return false;

  const hasLatexCommand = /\\[a-zA-Z]/.test(trimmed);

  if (trimmed.length > 100 && !hasLatexCommand) return false;
  if (
    trimmed.includes("**") ||
    trimmed.includes("__") ||
    /\[.*\]\(.*\)/.test(trimmed)
  )
    return false;
  if (/^\d[\d,.]*\s*[a-zA-Z]{1,}/.test(trimmed) && !hasLatexCommand)
    return false;
  if (/^[\d,.\s]+$/.test(trimmed)) return false;
  if (trimmed.length === 1 && /[a-zA-Z]/.test(trimmed)) return true;
  if (hasLatexCommand) return true;
  if (/[\\^_{}]/.test(trimmed)) return true;
  if (/[<>≠≤≥≈∈∉⊂⊃∪∩±∑∫∏√∞]/.test(trimmed)) return true;
  if (/[a-zA-Z]\s*[+\-*/=×÷]\s*[a-zA-Z0-9]/.test(trimmed)) return true;
  if (/[a-zA-Z0-9]\s*[+\-*/=×÷]\s*[a-zA-Z]/.test(trimmed)) return true;
  if (/^[a-zA-Z]\(/.test(trimmed)) return true;
  if (/\d\s*[+\-*/×÷]\s*\d/.test(trimmed) && /=/.test(trimmed)) return true;
  if (/[a-zA-Z]\d/.test(trimmed)) return true;
  if (/^[a-zA-Z0-9\s,.'"!?;:\-/()×=]+$/.test(trimmed)) return false;

  return false;
};

// remark-math chokes on "\$<digit>" and "\<digit>" inside math content.
const sanitizeMathContent = (content: string): string =>
  content.replace(/\\\$(\d)/g, "$1").replace(/\\(\d)/g, "$1");

// Keep inline $...$ pairs that look like math; escape the delimiters otherwise.
const processInlineDollarMath = (text: string): string => {
  const ESCAPED_DOLLAR = "LATEXESCAPEDDOLLAR";
  let result = text.replace(/\\\$/g, ESCAPED_DOLLAR);

  result = result.replace(
    /(?<!\$)\$(?!\$)([^$\s][^$]*?[^$\s])\$(?!\$)/g,
    (_match, content) => {
      const realContent = content.replaceAll(ESCAPED_DOLLAR, "\\$");
      if (looksLikeMath(realContent))
        return `$${sanitizeMathContent(realContent)}$`;
      return `\\$${realContent}\\$`;
    }
  );

  result = result.replace(
    /(?<!\$)\$(?!\$)([^$\s])\$(?!\$)/g,
    (_match, content) => {
      const realContent = content.replaceAll(ESCAPED_DOLLAR, "\\$");
      if (looksLikeMath(realContent)) return `$${realContent}$`;
      return `\\$${realContent}\\$`;
    }
  );

  return result.replaceAll(ESCAPED_DOLLAR, "\\$");
};

const transformLatex = (input: string): string => {
  let s = input;

  // Commands arrive double-escaped from JSON ("\\\\frac" → "\frac").
  s = s.replace(/\\\\([a-zA-Z_{}])/g, (_m, ch) => `\\${ch}`);

  // remark-math wants $$ delimiters on their own line.
  s = s.replace(/\$\$([\s\S]*?)\$\$[ \t]*/g, (_match, content) => {
    const trimmed = content.replace(/^[\s]+|[\s]+$/g, "");
    return `\n$$\n${trimmed}\n$$\n`;
  });

  // 4+ leading spaces after a $$ line would make the next line a code block.
  s = s.replace(/(\n\$\$\n\s*)[ ]{4,}(?=[[(!*_`#>-])/g, "$1");

  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, content) => `$$${content}$$`);

  // \(...\) → inline math, unless the body is a markdown link (prose).
  s = s.replace(/\\\((.+?)\\\)/g, (_m, content) => {
    if (/\[.*?\]\(.*?\)/.test(content)) return `(${content})`;
    return `$${content}$`;
  });

  // Currency: bare $<digit> and prefixed forms like R$ 100 or US$ 50, unless
  // preceded by a closing $ or an escaping backslash.
  s = s.replace(
    /(?<![$\\])(?:(?<=(?:^|[^A-Za-z$\\])[A-Z]{1,3})\$(?=\s?\d)|\$(?=\d))/g,
    "\\$"
  );

  // Korean range tildes (10~20) read as strikethrough to remark-gfm.
  s = s.replace(/(?<=[\d가-힣])~(?=[\d가-힣])/g, "\\~");

  // Split on $$ blocks so the inline-$ heuristic never spans one.
  const blocks = s.split(/(\$\$[\s\S]+?\$\$)/g);
  return blocks
    .map((seg, idx) => {
      if (idx % 2 === 1) return `$$${sanitizeMathContent(seg.slice(2, -2))}$$`;
      return processInlineDollarMath(seg);
    })
    .join("");
};

// LaTeX preprocessing that leaves code fences and inline code alone. A fence
// still open mid-stream is preserved verbatim.
export const processLatexSections = (text: string): string => {
  if (!text) return text;

  const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  return segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment;

      const incompleteFenceIdx = segment.indexOf("```");
      if (incompleteFenceIdx !== -1) {
        return (
          transformLatex(segment.slice(0, incompleteFenceIdx)) +
          segment.slice(incompleteFenceIdx)
        );
      }

      return transformLatex(segment);
    })
    .join("");
};
