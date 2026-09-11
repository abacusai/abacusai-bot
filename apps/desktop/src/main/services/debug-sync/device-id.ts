/**
 * A stable per-install identifier kept at `~/.abacusai-bot/device-id`. Logs
 * are synced per (user, device, stream, day), so this is what separates one
 * machine's logs from the same user's others.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";

const deviceIdFile = (): string => path.join(abacusBotHome(), "device-id");

let cached: string | null = null;

export function deviceId(): string {
  if (cached != null) return cached;
  const file = deviceIdFile();
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing.length > 0) return (cached = existing);
  } catch {
    // Not created yet; mint one.
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
