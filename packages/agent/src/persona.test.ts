import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  identityPrompt,
  MAX_PERSONA,
  personaPrompt,
  readPersona,
} from "./persona.js";

let dir: string;
const previousEnv = process.env.ABACUSAI_BOT_PERSONA;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-persona-"));
});

afterEach(() => {
  if (previousEnv == null) delete process.env.ABACUSAI_BOT_PERSONA;
  else process.env.ABACUSAI_BOT_PERSONA = previousEnv;

  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a session that is not a bot's chat", () => {
  it("has no persona", () => {
    delete process.env.ABACUSAI_BOT_PERSONA;

    expect(readPersona()).toBe("");
    expect(personaPrompt()).toBeNull();
  });

  it("survives a persona path that does not exist", () => {
    process.env.ABACUSAI_BOT_PERSONA = path.join(dir, "missing.md");

    expect(personaPrompt()).toBeNull();
  });
});

describe("a bot's chat", () => {
  it("frames the persona rather than pasting it raw", () => {
    const file = path.join(dir, "persona.md");
    fs.writeFileSync(file, "# Scout\nWatch the news.\n");
    process.env.ABACUSAI_BOT_PERSONA = file;

    const prompt = personaPrompt();

    expect(prompt).toContain("# Scout");
    expect(prompt).toContain("named bot's own chat");
    // Identity must not read as permission.
    expect(prompt).toContain("permission mode still");
  });

  it("bounds a runaway persona file", () => {
    const file = path.join(dir, "persona.md");
    fs.writeFileSync(file, "x".repeat(MAX_PERSONA * 2));
    process.env.ABACUSAI_BOT_PERSONA = file;

    expect(readPersona().length).toBe(MAX_PERSONA);
  });
});

describe("who the agent says it is", () => {
  it("is AbacusAI Bot, whatever model the turn ran on", () => {
    // The reported case: asked "which model are you?", a distilled model
    // under the router introduced itself as another vendor's assistant.
    const identity = identityPrompt();

    expect(identity).toMatch(/^You are AbacusAI Bot, here to help the user/);
    expect(identity).toMatch(/never introduce yourself as another assistant/);
  });
});
