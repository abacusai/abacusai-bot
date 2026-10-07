/**
 * The people the user books for: name, date of birth and contact details,
 * and a passport only when the user said yes to keeping that too. One file,
 * `memories/travelers.json` under the bot directory, so the desktop's bots,
 * the phone and the browser (which types a passport number without the model
 * seeing it) read the same travelers. Owner-only on disk.
 *
 * A leaf: the desktop's main process reads it (`@abacus-ai/agent/traveler-store`)
 * with its own idea of the bot directory, so nothing here reaches the agent.
 * Never part of a standing prompt.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "../atomic-file.js";

export interface Passport {
  number: string;
  /** YYYY-MM-DD */
  expiry: string | null;
  /** Issuing country, as the user gave it. */
  country: string | null;
}

export interface Consent {
  /** The user's message that said yes, whole. */
  quote: string;
  at: string;
}

export interface Traveler {
  id: string;
  /** Full name as on the ID. */
  name: string;
  /** YYYY-MM-DD */
  dateOfBirth: string | null;
  gender: string | null;
  nationality: string | null;
  email: string | null;
  phone: string | null;
  passport: Passport | null;
  consent: Consent;
  /** The separate yes for the passport, from another message. */
  passportConsent: Consent | null;
}

interface TravelerFile {
  version: 1;
  travelers: Traveler[];
}

export const MAX_TRAVELERS = 12;

/** `memories/travelers.json` under the bot directory `home`. */
export const travelersPath = (home: string): string =>
  path.join(home, "memories", "travelers.json");

export function readTravelers(home: string): Traveler[] {
  let raw: string;
  try {
    raw = fs.readFileSync(travelersPath(home), "utf8");
  } catch {
    // None saved yet.
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TravelerFile>;
    return Array.isArray(parsed.travelers) ? parsed.travelers : [];
  } catch {
    return [];
  }
}

export function writeTravelers(home: string, travelers: Traveler[]): void {
  const file: TravelerFile = { version: 1, travelers };
  writeFileAtomicSync(
    travelersPath(home),
    `${JSON.stringify(file, null, 2)}\n`,
    { restrict: true }
  );
}

/** The next free id: t1, t2, … */
export function nextTravelerId(travelers: readonly Traveler[]): string {
  const used = new Set(travelers.map((traveler) => traveler.id));
  let n = travelers.length + 1;
  while (used.has(`t${n}`)) n += 1;
  return `t${n}`;
}
