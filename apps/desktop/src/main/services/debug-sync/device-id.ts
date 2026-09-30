/**
 * A stable per-install identifier kept at `~/.abacusai-bot/device-id`. Logs
 * are synced per (user, device, stream, day), so this is what separates one
 * machine's logs from the same user's others.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";
import { profileBaseDir } from "../../profile-home";

/**
 * Install-wide, beside the profile registry: kept in the profile home, a
 * second account got a new id at its relaunch and every funnel broke at
 * sign-in. An id minted before profiles existed is adopted from there.
 */
const deviceIdFile = (): string => path.join(profileBaseDir(), "device-id");
const legacyDeviceIdFile = (): string =>
  path.join(abacusBotHome(), "device-id");

let cached: string | null = null;

export function deviceId(): string {
  if (cached != null) return cached;
  const file = deviceIdFile();
  for (const candidate of [file, legacyDeviceIdFile()]) {
    try {
      const existing = fs.readFileSync(candidate, "utf-8").trim();
      if (existing.length > 0) {
        if (candidate !== file) {
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, existing, "utf-8");
          } catch {
            // Adopted for this launch either way.
          }
        }
        return (cached = existing);
      }
    } catch {
      // Not there; try the next, then mint one.
    }
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, "utf-8");
  } catch {
    // An unwritable home means a fresh id next launch; usable now.
  }
  return (cached = id);
}
