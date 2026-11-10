// @vitest-environment jsdom
/**
 * The page check's own scripts, run in a document: a shader failure a page
 * only logs counts once the page draws, and any other page reads as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PAGE_ERROR_COLLECTOR, PAGE_READ } from "./page-errors";

const SHADER_LOG = [
  "THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false",
  "",
  "Program Info Log: Vertex shader is not compiled.",
  "",
  "VERTEX",
  "",
  "ERROR: 0:102: 'patch' : Illegal use of reserved word",
  "",
  "  101: uniform float time;",
  "> 102: float patch = 1.0;",
  "  103: void main() {",
].join("\n");

const run = <T>(script: string): T => Function(`return ${script}`)() as T;
const read = () => run<{ origin: string; caught: string[] | null }>(PAGE_READ);

describe("the page check's scripts", () => {
  const original = { error: console.error, warn: console.warn };
  const quiet = (): void => undefined;

  beforeAll(() => {
    // The page's own console stays quiet; the collector wraps whatever is there.
    console.error = quiet;
    console.warn = quiet;
    run(PAGE_ERROR_COLLECTOR);
  });
  afterAll(() => {
    console.error = original.error;
    console.warn = original.warn;
  });
  beforeEach(() => {
    const store = window as unknown as Record<string, unknown[]>;
    store["__abacusPageErrors"]!.length = 0;
    store["__abacusPageGraphics"]!.length = 0;
  });

  it("leaves a page that does not draw as it was, whatever it logs", () => {
    console.error("compile error: unexpected token in the user's snippet");

    expect(read().caught).toEqual([]);
  });

  it("reports a shader that failed on a page that draws, cut to its error line", () => {
    document.createElement("canvas").getContext("webgl2");
    console.error(SHADER_LOG);
    console.warn("THREE.WebGLRenderer: something harmless");

    expect(read().caught).toEqual([
      "console.error: THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false | ERROR: 0:102: 'patch' : Illegal use of reserved word | > 102: float patch = 1.0;",
    ]);
  });
});
