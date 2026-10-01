// User-login credentials and file manifests remain in private scratch storage.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function homeManifest(home) {
  const files = {};
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(home, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files[name] = createHash("sha256")
          .update(fs.readFileSync(path.join(home, name)))
          .digest("hex");
      else if (!entry.isSymbolicLink())
        throw new Error(`Unsupported fixture entry: ${name}`);
    }
  };
  visit("");
  return files;
}

export function copyPerfHome(sourceHome, manifest, provenance = "user-login") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-perf-"));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  try {
    for (const [relative, expected] of Object.entries(manifest)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
        throw new Error("Unsafe fixture path");
      const source = path.join(sourceHome, relative);
      if (
        !fs.lstatSync(source).isFile() ||
        createHash("sha256").update(fs.readFileSync(source)).digest("hex") !==
          expected
      )
        throw new Error(`Fixture hash mismatch: ${relative}`);
      const target = path.join(home, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.writeFileSync(
      path.join(
        home,
        provenance === "user-login"
          ? ".user-login-cutover-copy"
          : ".synthetic-cutover-home"
      ),
      "Private performance scratch copy\n"
    );
    return {
      root,
      home,
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function validatePerfProducer(producer) {
  if (
    producer?.kind !== "perf" ||
    producer.status !== "complete" ||
    !producer.fixture ||
    !producer.files ||
    producer.gaps?.length
  )
    return false;
  if (producer.provenance === "user-login")
    return (
      producer.sourceVersion === "v1.0.85" &&
      producer.sourceGenerated === false &&
      producer.shellObserved === true &&
      producer.workload?.longSessionMessages === 1000
    );
  return (
    producer.provenance === undefined ||
    producer.provenance === "source-generated"
  );
}

export function publicProducer(producer) {
  if (producer?.provenance !== "user-login") return producer;
  return {
    kind: producer.kind,
    provenance: producer.provenance,
    sourceVersion: producer.sourceVersion,
    sourceGenerated: producer.sourceGenerated,
    description: producer.description,
    status: producer.status,
    shellObserved: producer.shellObserved,
    workload: producer.workload,
  };
}
