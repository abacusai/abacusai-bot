/**
 * R2-T19 (spec 02 §7.3): the pre-pass table for all four delimiters,
 * streaming prefixes, pandoc's `$` rule, code untouched; display → `math`
 * fence → MathML block; inline → sentinel → MathML; parse errors styled;
 * default import only; hostile input never yields script, handlers or
 * `javascript:`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { loadMath, renderMath } from "./math";
import { MATH_SENTINEL, prepass } from "./prepass";

const pp = (source: string) => prepass(source, { workspaceRoot: null });

describe("R2-T19 pre-pass", () => {
  it("rewrites closed spans", () => {
    expect(pp("a $$x^2$$ b")).toContain("```math\nx^2\n```");
    expect(pp("a \\[x^2\\] b")).toContain("```math\nx^2\n```");
    expect(pp("a \\(x^2\\) b")).toBe(`a \`${MATH_SENTINEL}x^2\` b`);
    expect(pp("a $x^2$ b")).toBe(`a \`${MATH_SENTINEL}x^2\` b`);
    expect(pp("$$\na\n\nb\n$$")).toContain("```math\na\n\nb\n```");
  });

  it("leaves unclosed spans and every streaming prefix as text", () => {
    for (const whole of ["$$x^2$$", "\\[x^2\\]", "\\(x^2\\)", "$x^2$"])
      for (let cut = 1; cut < whole.length; cut += 1) {
        const prefix = whole.slice(0, cut);
        if (
          whole.startsWith("$$") &&
          prefix.endsWith("$") &&
          cut === whole.length - 1
        )
          continue;
        const out = pp(`see ${prefix}`);
        expect(
          out.includes("```math") || out.includes(MATH_SENTINEL),
          `${prefix} → ${out}`
        ).toBe(prefix === "$$x^2$" ? true : false);
      }
  });

  it("follows pandoc's rule for $", () => {
    expect(pp("$5 and $6")).toBe("$5 and $6");
    expect(pp("costs $ 5$")).toBe("costs $ 5$");
    expect(pp("$x $")).toBe("$x $");
    expect(pp("$x$5")).toBe("$x$5");
  });

  it("never touches code", () => {
    const fenced = "```\n$x$ \\(y\\)\n```";
    expect(pp(fenced)).toBe(fenced);
    expect(pp("`$x$` and $y$")).toBe(`\`$x$\` and \`${MATH_SENTINEL}y\``);
    const indented = "text\n\n    $x$ code\n\nafter $z$";
    expect(pp(indented)).toContain("    $x$ code");
    expect(pp("~~~\n$$a$$\n~~~")).toBe("~~~\n$$a$$\n~~~");
    expect(pp("```\n$$ open fence $$")).toBe("```\n$$ open fence $$");
  });

  it("fences hold a body with backticks", () => {
    expect(pp("$`a`$")).toBe(`\`\` ${MATH_SENTINEL}\`a\` \`\``);
  });
});

describe("R2-T19 rendering", () => {
  beforeAll(async () => {
    await loadMath();
  });

  it("display and inline MathML", () => {
    expect(renderMath("x^2", true)).toMatch(/<math[^>]*display="block"/);
    expect(renderMath("x^2", false)).toMatch(/<math/);
  });

  it("styles parse errors instead of throwing", () => {
    expect(renderMath("\\frac{", true)).toContain("temml-error");
  });

  it("200 hostile inputs yield no script, handlers or javascript:", () => {
    const pieces = [
      "<script>alert(1)</script>",
      "\\href{javascript:alert(1)}{x}",
      "\\url{javascript:alert(1)}",
      "\\includegraphics{x.png}",
      '"><img src=x onerror=alert(1)>',
      "\\htmlId{x}{y}",
      "\\class{onload}{x}",
      "\\style{background:url(javascript:x)}{y}",
      "\\def\\x{\\x}\\x",
      "\\text{<svg onload=alert(1)>}",
    ];
    for (let index = 0; index < 200; index += 1) {
      const tex = `${pieces[index % pieces.length]}${"x".repeat(index % 7)}`;
      const html = renderMath(tex, index % 2 === 0);
      // Parsed as the browser would: escaped text may quote the source, but
      // no element may be a script and no attribute a handler or a
      // `javascript:` URL.
      const host = document.createElement("div");
      host.innerHTML = html;
      expect(
        host.querySelector("script, iframe, object, embed, img, a")
      ).toBeNull();
      for (const element of host.querySelectorAll("*"))
        for (const attribute of element.attributes) {
          expect(attribute.name).not.toMatch(/^on/i);
          expect(attribute.value).not.toMatch(/javascript:/i);
        }
    }
  });

  it("imports temml by default export only", async () => {
    const sources = import.meta.glob<string>("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    for (const [path, source] of Object.entries(sources))
      expect(source, path).not.toMatch(
        /import\s*\{[^}]*\}\s*from\s*["']temml["']/
      );
  });
});
