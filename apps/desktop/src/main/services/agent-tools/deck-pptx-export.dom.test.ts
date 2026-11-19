// @vitest-environment jsdom
/**
 * The editable deck is measured on screen, not in print, so the print rule that
 * shows a template's animated text never applies to it. Five templates hide
 * that text until a slide is the active one; measured as they stood, their
 * .pptx came out with the page numbers and nothing else.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prepareScript } from "./deck-pptx-export";

/** What signal, grove, studio, broadside and monochrome do, reduced. */
const TEMPLATE_CSS = `
  [data-anim] { opacity: 0; }
  .slide.is-active [data-anim] { opacity: 1; }
`;

/** Runs the page script as the renderer would: it is a string evaluated there. */
const prepare = (): Promise<unknown> =>
  Function(`return ${prepareScript(1920, 1080)}`)() as Promise<unknown>;

const opacityOf = (selector: string): string =>
  getComputedStyle(document.querySelector(selector)!).opacity;

describe("measuring a deck whose text waits for its slide to be shown", () => {
  beforeEach(() => {
    document.head.innerHTML = `<style>${TEMPLATE_CSS}</style>`;
    document.body.innerHTML = `
      <section class="slide"><h1 data-anim="fade-up" id="first">Title</h1></section>
      <section class="slide"><p data-anim id="second">Body</p></section>`;
    // jsdom paints nothing; the frames PREPARE waits for only need to pass.
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0) as unknown as number;
  });

  it("is visible on every slide once the page is prepared", async () => {
    await prepare();

    expect(opacityOf("#first")).toBe("1");
    expect(opacityOf("#second")).toBe("1");
  });
});
