import { refreshMetadata } from "./repository.ts";

/**
 * Scheduled re-sign: fresh snapshot and timestamp expiries, targets
 * untouched. Run this between releases so clients never verify against an
 * expired timestamp.
 */
if (/refresh\.(?:m?ts|m?js)$/u.test(process.argv[1] ?? "")) {
  await refreshMetadata();
  console.log("Refreshed snapshot and timestamp metadata");
}
