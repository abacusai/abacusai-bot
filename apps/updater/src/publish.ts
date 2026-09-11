import { parseArgs } from "node:util";

import { publishExperience } from "./repository.ts";

/** Development-only publish: sign an experience archive into the dev repo. */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { target: { type: "string" } },
});
const [artifact] = positionals;
if (artifact === undefined) {
  console.error("Usage: publish <experience.zip> [--target <path>]");
  process.exit(2);
}
console.log(await publishExperience(artifact, values.target));
