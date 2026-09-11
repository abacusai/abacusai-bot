import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildExperience } from "@abacus-ai/updater/experience";
import { describe, expect, it } from "vitest";

import { verifyExperience } from "./integrity";

/**
 * Builder and verifier are two views of one canon: what
 * `apps/updater/src/manifest.ts` produces, this module must accept — and
 * must reject the moment a byte differs.
 */
const FOUNDATION = "1.2.3";

const buildFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "experience-"));
  const renderer = path.join(root, "renderer-src");
  const agent = path.join(root, "agent-src");

  await fs.mkdir(path.join(renderer, "assets"), { recursive: true });
  await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(renderer, "index.html"), "<html></html>");
  await fs.writeFile(path.join(renderer, "assets", "app.js"), "render();");
  await fs.writeFile(path.join(agent, "main.js"), "process.exit(0);");
  const output = path.join(root, "experience");

  await buildExperience({ agent, foundation: FOUNDATION, output, renderer });

  return { current: path.join(output, "current"), root };
};

describe("experience integrity", () => {
  it("accepts a built experience and its identities", async () => {
    const { current, root } = await buildFixture();

    try {
      const manifest = await verifyExperience(current, FOUNDATION);

      expect(manifest.experienceVersion).toMatch(/^[\da-f]{64}$/u);
      expect(manifest.protocol).toBe("abacus.desktop/1");
      expect(manifest.files["agent/main.js"]).toBeDefined();
      expect(manifest.files["renderer/index.html"]).toBeDefined();
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a tampered file byte for byte", async () => {
    const { current, root } = await buildFixture();

    try {
      // Same size, different bytes — the digest is what must catch it.
      await fs.writeFile(
        path.join(current, "agent", "main.js"),
        "process.exit(1);"
      );
      await expect(verifyExperience(current, FOUNDATION)).rejects.toThrow(
        /Experience file differs/u
      );
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an extra file", async () => {
    const { current, root } = await buildFixture();

    try {
      await fs.writeFile(path.join(current, "agent", "extra.js"), "");
      await expect(verifyExperience(current, FOUNDATION)).rejects.toThrow(
        /do not match the manifest/u
      );
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("ignores the foundation's node_modules link at the root", async () => {
    const { current, root } = await buildFixture();

    try {
      const modules = path.join(root, "runtime-modules");

      await fs.mkdir(modules, { recursive: true });
      await fs.symlink(modules, path.join(current, "node_modules"), "dir");
      await expect(
        verifyExperience(current, FOUNDATION)
      ).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a bundle built for an older foundation", async () => {
    const { current, root } = await buildFixture();

    try {
      await expect(verifyExperience(current, "1.2.4")).rejects.toThrow(
        /built for foundation 1\.2\.3, not 1\.2\.4/u
      );
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a bundle built for a newer foundation", async () => {
    const { current, root } = await buildFixture();

    try {
      await expect(verifyExperience(current, "1.2.2")).rejects.toThrow(
        /built for foundation 1\.2\.3, not 1\.2\.2/u
      );
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a manifest that does not match its recorded digest", async () => {
    const { current, root } = await buildFixture();

    try {
      await expect(
        verifyExperience(current, FOUNDATION, "0".repeat(64))
      ).rejects.toThrow(/recorded digest/u);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});
