/**
 * What the plan must refuse, and what the page must never allow: the model
 * fills the slots, so its words must not change the page or reach a network.
 */
import { describe, expect, it } from "vitest";

import { buildMotion, type MotionRequest } from "./motion-plan";

/** The host's image reader, stood in for: missing.png is not there. */
const readImage = (file: string) => {
  if (file.endsWith("missing.png"))
    throw new Error(`There is no file at ${file}.`);
  return { src: "data:image/png;base64,AAAA", tone: "dark" as const };
};

const build = (request: Partial<MotionRequest> & Record<string, unknown>) =>
  buildMotion(
    { size: "16:9", ...request } as MotionRequest,
    () => "<p>{{title}}</p>",
    "",
    { sans: "", serif: "", mono: "" },
    readImage
  );

describe("a plan it refuses", () => {
  // The message is all the model sees: it must name the thing to fix.
  it.each([
    [
      { template: "fireworks" },
      /Unknown template "fireworks"\. Use one of: title-card/,
    ],
    [{ template: "title-card", size: "4:3" }, /Unknown size "4:3"/],
    [{ template: "title-card", slots: {} }, /"title" is required\./],
    [
      { template: "title-card", slots: { title: "x".repeat(80) } },
      /"title" is 80 characters; keep it to 60\./,
    ],
    [
      { template: "kinetic-text", slots: { lines: Array(12).fill("Line") } },
      /"lines" has 12 items; use 2 to 8\./,
    ],
    [
      {
        template: "animated-chart",
        slots: {
          title: "T",
          bars: [
            { label: "A", value: 1 },
            { label: "B", value: "lots" },
          ],
        },
      },
      /"value" of bars item 2 must be a number/,
    ],
    [
      { template: "logo-reveal", slots: { logo: "missing.png" } },
      /"logo": There is no file at missing\.png\./,
    ],
    [
      {
        template: "explainer",
        slots: {
          title: "How",
          steps: Array.from({ length: 6 }, (_, i) => ({
            heading: `Step ${i}`,
            text: "y".repeat(140),
          })),
        },
      },
      // Over 30 s even played fast: refused, with how much to cut.
      /would run \d+(\.\d+)? s even played fast; the limit is 30 s\. Cut about \d+ characters/,
    ],
  ])("%#: %o", (request, message) => {
    expect(() => build(request)).toThrow(message);
  });
});

describe("the page", () => {
  it("escapes every value and reaches no network", () => {
    const { html } = build({
      template: "title-card",
      slots: { title: '<img src=x onerror="1">' },
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:/);
  });
});
