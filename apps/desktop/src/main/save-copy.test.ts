import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./rpc/testing";
import { saveCopies, type SaveCopyDialogs } from "./save-copy";

let root: string;
let work: string;
let out: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "save-copy-")));
  work = path.join(root, "work");
  out = path.join(root, "out");
  fs.mkdirSync(work);
  fs.mkdirSync(out);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (file: string, content: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const dialogs = (picked: {
  file?: string | null;
  folder?: string | null;
}): SaveCopyDialogs & {
  saveFile: ReturnType<typeof vi.fn>;
  pickFolder: ReturnType<typeof vi.fn>;
} => ({
  defaultDir: out,
  home: root,
  saveFile: vi.fn(async () => picked.file ?? null),
  pickFolder: vi.fn(async () => picked.folder ?? null),
});
const item = (filePath: string) => ({ filePath, hostRoot: work });

it("one file: the save dialog opens on Downloads with its name, and the copy goes where picked", async () => {
  write(path.join(work, "report.pdf"), "pdf");
  const target = path.join(out, "renamed.pdf");
  const picker = dialogs({ file: target });
  // Relative to the root, as the agent names it.
  const result = await saveCopies([item("report.pdf")], picker);
  expect(picker.saveFile).toHaveBeenCalledWith(path.join(out, "report.pdf"));
  expect(picker.pickFolder).not.toHaveBeenCalled();
  expect(result).toEqual({ destination: target, saved: 1, skipped: 0 });
  expect(fs.readFileSync(target, "utf8")).toBe("pdf");
});

it("one file: replaces only what the dialog confirmed, and a file saved onto itself survives", async () => {
  const source = write(path.join(work, "a.txt"), "new");
  const target = write(path.join(out, "a.txt"), "old");
  await saveCopies([item(source)], dialogs({ file: target }));
  expect(fs.readFileSync(target, "utf8")).toBe("new");
  await saveCopies([item(source)], dialogs({ file: source }));
  expect(fs.readFileSync(source, "utf8")).toBe("new");
});

it("cancel copies nothing; a file no longer there opens no dialog", async () => {
  write(path.join(work, "a.txt"), "a");
  const picker = dialogs({ file: null });
  expect(await saveCopies([item("a.txt")], picker)).toEqual({
    destination: null,
    saved: 0,
    skipped: 0,
  });
  expect(fs.readdirSync(out)).toEqual([]);
  const gone = dialogs({ file: path.join(out, "x") });
  expect(await saveCopies([item("gone.txt")], gone)).toEqual({
    destination: null,
    saved: 0,
    skipped: 1,
  });
  expect(gone.saveFile).not.toHaveBeenCalled();
});

it("save all: every item into the picked folder, clashing names numbered, nothing overwritten", async () => {
  write(path.join(out, "report.pdf"), "already there");
  const a = write(path.join(work, "report.pdf"), "first");
  const b = write(path.join(work, "other", "report.pdf"), "second");
  const c = write(path.join(work, "notes"), "no extension");
  write(path.join(out, "notes"), "taken");
  const picker = dialogs({ folder: out });
  const result = await saveCopies(
    [item(a), item(b), item(c), item("missing.txt"), item(a)],
    picker
  );
  expect(picker.saveFile).not.toHaveBeenCalled();
  expect(result).toEqual({ destination: out, saved: 3, skipped: 2 });
  const read = (name: string) => fs.readFileSync(path.join(out, name), "utf8");
  expect(read("report.pdf")).toBe("already there");
  expect(read("report (2).pdf")).toBe("first");
  expect(read("report (3).pdf")).toBe("second");
  expect(read("notes")).toBe("taken");
  expect(read("notes (2)")).toBe("no extension");
});

it("a folder is copied as a folder, without node_modules or .git, and its links stay links", async () => {
  const site = path.join(work, "site");
  write(path.join(site, "index.html"), "<h1>hi</h1>");
  write(path.join(site, "assets", "app.js"), "js");
  write(path.join(site, "node_modules", "dep", "index.js"), "dep");
  write(path.join(site, ".git", "HEAD"), "ref");
  const secret = write(path.join(root, "secret.txt"), "secret");
  fs.symlinkSync(secret, path.join(site, "link.txt"));
  fs.mkdirSync(path.join(out, "site"));
  const picker = dialogs({ folder: out });
  const result = await saveCopies([item(site)], picker);
  expect(picker.saveFile).not.toHaveBeenCalled();
  expect(result).toEqual({ destination: out, saved: 1, skipped: 0 });
  const copy = path.join(out, "site (2)");
  expect(fs.readFileSync(path.join(copy, "index.html"), "utf8")).toBe(
    "<h1>hi</h1>"
  );
  expect(fs.readFileSync(path.join(copy, "assets", "app.js"), "utf8")).toBe(
    "js"
  );
  expect(fs.existsSync(path.join(copy, "node_modules"))).toBe(false);
  expect(fs.existsSync(path.join(copy, ".git"))).toBe(false);
  expect(fs.lstatSync(path.join(copy, "link.txt")).isSymbolicLink()).toBe(true);
  expect(fs.readdirSync(path.join(out, "site"))).toEqual([]);
});

it("a folder is never copied into itself", async () => {
  const site = path.join(work, "site");
  write(path.join(site, "index.html"), "x");
  const result = await saveCopies([item(site)], dialogs({ folder: site }));
  expect(result).toEqual({ destination: site, saved: 0, skipped: 1 });
  expect(fs.readdirSync(site)).toEqual(["index.html"]);
});

it("resolves ~ and the guest /workspace prefix as the file readers do", async () => {
  write(path.join(root, "home-file.txt"), "home");
  write(path.join(work, "guest.txt"), "guest");
  const result = await saveCopies(
    [item("~/home-file.txt"), item("/workspace/guest.txt")],
    dialogs({ folder: out })
  );
  expect(result.saved).toBe(2);
  expect(fs.readdirSync(out).toSorted()).toEqual([
    "guest.txt",
    "home-file.txt",
  ]);
});

it("the procedure answers only the local main window", async () => {
  const saveCopy = vi.fn(async () => ({
    destination: "/x",
    saved: 1,
    skipped: 0,
  }));
  const connect = (context: Parameters<typeof connectInProcess>[1]) =>
    connectInProcess(
      fakeDeps({
        app: { saveCopy },
        windows: { mainRendererId: () => 42 },
      }),
      { windowKind: "main", webContentsId: 42, ...context }
    );
  const items = [{ filePath: "/w/a.txt", hostRoot: "/w" }];
  const local = connect({ transport: "message-port" });
  await expect(local.client.system.saveCopy({ items })).resolves.toEqual({
    destination: "/x",
    saved: 1,
    skipped: 0,
  });
  for (const context of [
    { transport: "websocket" as const },
    { transport: "message-port" as const, windowKind: "notch" as const },
  ]) {
    const remote = connect(context);
    await expect(
      remote.client.system.saveCopy({ items })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    remote.closeClient();
    remote.closeServer();
  }
  await expect(
    local.client.system.saveCopy({ items: [] })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(saveCopy).toHaveBeenCalledOnce();
  local.closeClient();
  local.closeServer();
});
