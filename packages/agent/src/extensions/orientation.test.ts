import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The failure this repairs was observed, not imagined: a run that narrated
 * "let me list the contents of both directories", called `read` on a directory
 * three times, then guessed three filenames that did not exist and gave up.
 *
 * So the assertions are about what the model is told next: that a directory
 * needs `ls`, and that a missing file needs a listing rather than another
 * guess, and about the two things that must not change: the call still failed,
 * and results that were fine are left alone.
 */
import { describe, expect, it } from "vitest";

import orientation from "./orientation.js";

async function readResult(
  input: Record<string, unknown>,
  text: string,
  isError = true
): Promise<
  { content?: Array<{ text: string }>; isError?: boolean } | undefined
> {
  const pi = fakePi();
  orientation(pi.api as never);

  return (await pi.fire("tool_result", {
    type: "tool_result",
    toolName: "read",
    input,
    isError,
    content: [{ type: "text", text }],
  })) as { content?: Array<{ text: string }>; isError?: boolean } | undefined;
}

/** The advice, which is appended after the original error. */
const advice = (
  result: { content?: Array<{ text: string }> } | undefined
): string => (result?.content ?? []).map((block) => block.text).join("\n");

describe("reading a directory", () => {
  it("names the tool that does what the model was trying to do", async () => {
    const result = await readResult(
      { path: "/work/abacusai-bot" },
      "EISDIR: illegal operation on a directory, read"
    );

    expect(advice(result)).toContain("/work/abacusai-bot is a directory");
    expect(advice(result)).toContain("`ls`");
    // The raw error survives, so a human reading the transcript still sees it.
    expect(advice(result)).toContain("EISDIR");
  });

  it("leaves the call reported as failed", async () => {
    // Never flipped to success: the loop would carry on as though the read
    // had returned contents. Not setting isError leaves the original true.
    const result = await readResult(
      { path: "/work/x" },
      "EISDIR: illegal operation on a directory, read"
    );
    expect(result?.isError).toBeUndefined();
  });
});

describe("reading a file that is not there", () => {
  it("points at the directory to list instead of the name to guess", async () => {
    const result = await readResult(
      { path: "/work/abacusai-bot/ABOUT.md" },
      "ENOENT: no such file or directory, open '/work/abacusai-bot/ABOUT.md'"
    );

    expect(advice(result)).toContain("/work/abacusai-bot");
    expect(advice(result)).toMatch(/do not try another name/i);
  });

  it('does not say "list ." when the path had no directory in it', async () => {
    const result = await readResult(
      { path: "ABOUT.md" },
      "ENOENT: no such file or directory, open 'ABOUT.md'"
    );
    expect(advice(result)).toContain("the directory");
    expect(advice(result)).not.toContain("ls .");
  });

  it("leaves the result alone when there is no path to talk about", async () => {
    expect(
      await readResult({}, "ENOENT: no such file or directory")
    ).toBeUndefined();
  });
});

describe("what it must not touch", () => {
  it("leaves a successful read alone", async () => {
    expect(
      await readResult({ path: "/work/f.ts" }, "file contents", false)
    ).toBeUndefined();
  });

  it("leaves a failure it has no advice for alone", async () => {
    expect(
      await readResult({ path: "/work/f.ts" }, "EACCES: permission denied")
    ).toBeUndefined();
  });

  it("leaves other tools alone", async () => {
    const pi = fakePi();
    orientation(pi.api as never);
    const result = await pi.fire("tool_result", {
      type: "tool_result",
      toolName: "bash",
      input: { command: "cat dir" },
      isError: true,
      content: [
        {
          type: "text",
          text: "EISDIR: illegal operation on a directory, read",
        },
      ],
    });

    expect(result).toBeUndefined();
  });
});
