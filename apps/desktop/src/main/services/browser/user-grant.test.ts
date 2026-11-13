import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isLocalTarget,
  readUserGrant,
  siteAsked,
  userNamedFile,
  userOpensLocal,
} from "./user-grant";

describe("readUserGrant", () => {
  it("reads only a grant that carries the agent runtime's token", () => {
    const raw = { token: "t0k", said: ["hi"], start_url: "https://a.test/" };
    expect(readUserGrant(raw, "t0k")).toEqual({
      said: ["hi"],
      startUrl: "https://a.test/",
    });
    // A model that writes a grant does not know the token.
    expect(readUserGrant({ ...raw, token: "guess" }, "t0k")).toBeNull();
    expect(readUserGrant({ said: ["hi"] }, "t0k")).toBeNull();
    expect(readUserGrant(raw, undefined)).toBeNull();
  });
});

describe("userNamedFile", () => {
  let workspace: string;
  const file = (name: string, body = "x"): string => {
    const full = path.join(workspace, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return fs.realpathSync(full);
  };
  beforeEach(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "grant-ws-"))
    );
  });
  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it("grants the file the user attached, by its @ line or chat-app line", () => {
    const cv = file(".abacusai-bot/temp/cv.pdf");
    expect(userNamedFile([`apply with my cv\n\n@${cv}`], cv, workspace)).toBe(
      true
    );
    expect(
      userNamedFile(
        [`[attachment: cv.pdf saved to ${cv}]\nplease apply`],
        cv,
        workspace
      )
    ).toBe(true);
  });

  it("grants a file the user named, by name or path, quoted with spaces too", () => {
    const notes = file("docs/notes.txt");
    const spaced = file("my resume.pdf");
    expect(userNamedFile(["upload notes.txt there"], notes, workspace)).toBe(
      true
    );
    expect(userNamedFile(["upload docs/notes.txt."], notes, workspace)).toBe(
      true
    );
    expect(
      userNamedFile(['send "my resume.pdf" to them'], spaced, workspace)
    ).toBe(true);
  });

  it("never grants a workspace file the user did not name: the decoy secret, memory, a look-alike", () => {
    const env = file(".env", "API_KEY=secret");
    const memory = file("MEMORY.md");
    const notes = file("notes.txt");
    const said = ["upload my cv to the jobs page", "@/elsewhere/cv.pdf"];
    expect(userNamedFile(said, env, workspace)).toBe(false);
    expect(userNamedFile(said, memory, workspace)).toBe(false);
    // "notes.txt" with a Cyrillic "о" is another name.
    expect(userNamedFile(["upload nоtes.txt"], notes, workspace)).toBe(false);
    // A longer name that contains it is not it.
    expect(userNamedFile(["upload old-notes.txt"], notes, workspace)).toBe(
      false
    );
  });

  it("grants an exact copy of an attachment the bot made in the workspace, never an edited one or one from outside", () => {
    // A bot copied the user's attached CV next to it and uploaded the copy: refused,
    // the application went in without the CV.
    const cv = file(".abacusai-bot/temp/my-cv.txt", "Jane Doe CV");
    const copy = file("my-cv.txt", "Jane Doe CV");
    const edited = file("cv-edited.txt", "Jane Doe CV, edited");
    const said = [`apply with my cv\n\n@${cv}`];
    expect(userNamedFile(said, copy, workspace)).toBe(true);
    expect(userNamedFile(said, edited, workspace)).toBe(false);
    // The same bytes as a file the user named outside the workspace do not count.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grant-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "Jane Doe CV");
    expect(
      userNamedFile(
        [`upload ${path.join(outside, "secret.txt")}`],
        copy,
        workspace
      )
    ).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("does not let a path trick stand in for a named file", () => {
    const env = file(".env", "API_KEY=decoy");
    file("cv.pdf");
    // A link the user named that points at the secret is the secret's real path only if they named that path.
    fs.symlinkSync(env, path.join(workspace, "cv-link.pdf"));
    expect(userNamedFile(["upload cv.pdf"], env, workspace)).toBe(false);
    expect(userNamedFile(["upload ../.env"], env, workspace)).toBe(false);
    expect(userNamedFile(["upload ~/.env"], env, workspace)).toBe(false);
  });
});

describe("siteAsked", () => {
  it("is the site the user named, or the run's start page", () => {
    const grant = { said: ["apply on jobs.acme.com please"], startUrl: null };
    expect(siteAsked(grant, "https://careers.acme.com/apply")).toBe(true);
    expect(siteAsked(grant, "https://acme.com.evil.test/apply")).toBe(false);
    expect(siteAsked(grant, "https://evil.test/acme.com")).toBe(false);
    const started = { said: ["upload cv.pdf"], startUrl: "https://hr.test/x" };
    expect(siteAsked(started, "https://www.hr.test/form")).toBe(true);
    expect(siteAsked(started, "https://other.test/form")).toBe(false);
    expect(
      siteAsked({ said: ["upload cv.pdf"], startUrl: null }, "https://hr.test/")
    ).toBe(false);
  });
});

describe("isLocalTarget / userOpensLocal", () => {
  it("knows files, loopback, private, link-local and local names", () => {
    for (const url of [
      "file:///etc/passwd",
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://[::1]:8080/",
      "http://10.1.2.3/",
      "http://192.168.0.1/admin",
      "http://172.20.0.1/",
      "http://169.254.169.254/latest/user-data",
      "http://printer.local/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0:9222/json",
    ])
      expect(isLocalTarget(url), url).toBe(true);
    for (const url of [
      "https://example.com/",
      "https://8.8.8.8/",
      "https://172.32.0.1/",
    ])
      expect(isLocalTarget(url), url).toBe(false);
  });

  it("opens a local address only when the user wrote it", () => {
    const grant = {
      said: [
        "check my app at localhost:3000 please",
        "open file:///home/me/a.html",
      ],
      startUrl: null,
    };
    expect(userOpensLocal(grant, "http://localhost:3000/login")).toBe(true);
    expect(userOpensLocal(grant, "http://localhost:9222/json")).toBe(false);
    expect(userOpensLocal(grant, "file:///home/me/a.html")).toBe(true);
    expect(userOpensLocal(grant, "file:///home/me/.ssh/id_rsa")).toBe(false);
    expect(
      userOpensLocal(grant, "http://169.254.169.254/latest/user-data")
    ).toBe(false);
    expect(userOpensLocal(null, "http://localhost:3000/")).toBe(false);
  });
});
