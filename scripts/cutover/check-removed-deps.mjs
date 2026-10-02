import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { specifiers } from "./parsed-source.mjs";
export const removed = [
  "zustand",
  "framer-motion",
  "react-tourlight",
  "@tsparticles/engine",
  "@tsparticles/react",
  "@tsparticles/slim",
  "uuid",
  "@dicebear/core",
  "@dicebear/styles",
  "@monaco-editor/react",
  "monaco-editor",
  "katex",
  "@lobehub/icons-static-svg",
  "sonner",
  "clsx",
  "tailwind-merge",
];
export const packageName = (specifier) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
export const cssSpecifiers = (source) =>
  [
    ...source.matchAll(
      /@(import|plugin|source)\s+(?:url\(\s*)?["']([^"']+)["']/g
    ),
  ].map((m) => m[2]);
export const checkSource = (file, source) => {
  const imports = file.endsWith(".css")
    ? cssSpecifiers(source)
    : specifiers(file, source);
  for (const name of imports.map(packageName))
    if (removed.includes(name))
      throw new Error(`Removed dependency ${name} in ${file}`);
};
export const checkRemovedDeps = (repo) => {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", "vendor", "release", ".build"].includes(
          entry.name
        )
      )
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(file))
        checkSource(file, fs.readFileSync(file, "utf8"));
      else if (entry.name === "package.json") {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const group of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ])
          for (const name of Object.keys(pkg[group] ?? {}))
            if (removed.includes(name))
              throw new Error(`Removed manifest dependency ${name} in ${file}`);
      }
    }
  };
  for (const dir of ["apps", "packages"]) visit(path.join(repo, dir));
  const workspace = fs.readFileSync(
    path.join(repo, "pnpm-workspace.yaml"),
    "utf8"
  );
  for (const name of removed)
    if (
      workspace
        .split("\n")
        .some(
          (line) =>
            line.includes(name) && !line.includes("framer-motion@13.4.6")
        )
    )
      throw new Error(`Removed workspace dependency ${name}`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkRemovedDeps(process.cwd());
  console.log("Removed dependency imports and manifests pass.");
}
