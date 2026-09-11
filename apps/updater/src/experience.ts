import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { ZipFile } from "yazl";

import { buildManifest, listFiles } from "./manifest.ts";

/** Fixed timestamp so identical trees produce identical archives. */
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

const copyTree = async (source: string, destination: string): Promise<void> => {
  for (const relative of await listFiles(source)) {
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, relative), target);
  }
};

const archive = async (root: string, output: string): Promise<void> => {
  const zip = new ZipFile();
  const done = new Promise<void>((resolve, reject) => {
    const stream = zip.outputStream.pipe(createWriteStream(output));
    stream.once("close", () => {
      resolve();
    });
    stream.once("error", reject);
  });
  for (const relative of await listFiles(root)) {
    zip.addFile(path.join(root, relative), relative, {
      compress: true,
      mode: 0o10_0644,
      mtime: ZIP_EPOCH,
    });
  }
  zip.end();
  await done;
};

/**
 * Build a deterministic experience: `<output>/current/{renderer,agent,
 * manifest.json}` plus `<output>/experience.zip` with the same tree at the
 * archive root. The desktop verifier recomputes every digest on install.
 */
export const buildExperience = async (options: {
  agent: string;
  foundation: string;
  output: string;
  renderer: string;
}): Promise<void> => {
  const staging = `${options.output}.staging`;
  await fs.rm(staging, { force: true, recursive: true });
  const current = path.join(staging, "current");
  await copyTree(options.renderer, path.join(current, "renderer"));
  await copyTree(options.agent, path.join(current, "agent"));
  await fs.writeFile(
    path.join(current, "manifest.json"),
    await buildManifest(current, options.foundation)
  );
  await archive(current, path.join(staging, "experience.zip"));
  await fs.rm(options.output, { force: true, recursive: true });
  await fs.rename(staging, options.output);
};

if (/experience\.(?:m?ts|m?js)$/u.test(process.argv[1] ?? "")) {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      foundation: { type: "string" },
      output: { type: "string" },
      renderer: { type: "string" },
    },
  });
  if (
    values.agent === undefined ||
    values.foundation === undefined ||
    values.output === undefined ||
    values.renderer === undefined
  ) {
    console.error(
      "Usage: experience --renderer <dir> --agent <dir> --output <dir> --foundation <version>"
    );
    process.exit(2);
  }
  await buildExperience({
    agent: values.agent,
    foundation: values.foundation,
    output: values.output,
    renderer: values.renderer,
  });
}
