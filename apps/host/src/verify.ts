import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agentEntry, agentVendorDir } from "#main/resources";

/** `--verify`: every shipped package, native addon and agent tool loads here. */
export const verifyRuntime = async () => {
  const inventory = await readFile(
    join(import.meta.dirname, "runtime-packages.json"),
    "utf8"
  );
  for (const name of JSON.parse(inventory) as string[]) await import(name);
  await access(agentEntry());
  execFileSync(
    process.execPath,
    [join(dirname(agentEntry()), "verify-packages.mjs")],
    { stdio: "inherit" }
  );
  await access(join(agentVendorDir(), "rg"));
  await access(join(agentVendorDir(), "fd"));
  console.log("Host runtime verified");
};
