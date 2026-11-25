import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLocalPreviewFile } from "./local-preview-file";

let base: string;
let checkout: string;
let desktop: string;

const write = (file: string, text = "<p>hi</p>"): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preview-")));
  checkout = path.join(base, "checkout");
  desktop = path.join(base, "Desktop");
  fs.mkdirSync(checkout);
  fs.mkdirSync(desktop);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("which local files the preview shows, and under which root", () => {
  it("shows a file in the checkout under the caller's root", async () => {
    const file = write(path.join(checkout, "site", "index.html"));

    expect(await checkLocalPreviewFile(file, checkout, [checkout])).toEqual({
      ok: true,
      file,
      root: checkout,
    });
  });

  it("shows a page the bot saved outside the checkout when the chat passes the checkout as its root", async () => {
    const file = write(path.join(desktop, "site", "index.html"));
    const made = path.dirname(file);

    expect(
      await checkLocalPreviewFile(file, checkout, [checkout, made])
    ).toEqual({ ok: true, file, root: made });
  });

  it("bounds the page by the narrowest folder the bot made, not a wider one", async () => {
    const file = write(path.join(desktop, "site", "index.html"));
    write(path.join(desktop, "notes.html"));

    const checked = await checkLocalPreviewFile(file, checkout, [
      checkout,
      desktop,
      path.dirname(file),
    ]);

    expect(checked).toEqual({ ok: true, file, root: path.dirname(file) });
  });

  it("refuses a file in no folder main allows, wherever the caller roots it", async () => {
    const file = write(path.join(desktop, "other.html"));

    expect(await checkLocalPreviewFile(file, checkout, [checkout])).toEqual({
      ok: false,
      error: "outside-root",
    });
    expect(await checkLocalPreviewFile(file, desktop, [checkout])).toEqual({
      ok: false,
      error: "root-not-allowed",
    });
  });

  it("refuses a link inside an allowed folder that points outside it", async () => {
    const outside = write(path.join(desktop, "secret.html"));
    const link = path.join(checkout, "link.html");
    fs.symlinkSync(outside, link);

    expect(await checkLocalPreviewFile(link, checkout, [checkout])).toEqual({
      ok: false,
      error: "outside-root",
    });
  });

  it("still refuses a type the view does not show, and says when a file is missing", async () => {
    const text = write(path.join(desktop, "notes.txt"), "x");

    expect(await checkLocalPreviewFile(text, checkout, [desktop])).toEqual({
      ok: false,
      error: "unsupported-type",
    });
    expect(
      await checkLocalPreviewFile(path.join(desktop, "gone.html"), desktop, [
        desktop,
      ])
    ).toEqual({ ok: false, error: "not-found" });
    expect(
      await checkLocalPreviewFile("gone.html", path.join(base, "other"), [
        desktop,
      ])
    ).toEqual({ ok: false, error: "root-not-allowed" });
  });

  it("resolves a relative path against the caller's root", async () => {
    const file = write(path.join(checkout, "out", "report.pdf"), "%PDF");

    expect(
      await checkLocalPreviewFile("out/report.pdf", checkout, [checkout])
    ).toEqual({ ok: true, file, root: checkout });
  });
});
