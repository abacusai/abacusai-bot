/**
 * A bot's identity, when this session is a bot's chat. The desktop writes the
 * persona to the file named by ABACUSAI_BOT_PERSONA; it is re-read per loader
 * load so an edit to the bot lands on the next turn. Framed rather than pasted
 * raw so identity cannot read as permission.
 */
import fs from "fs";

/** Bounded like custom instructions, and for the same reason. */
export const MAX_PERSONA = 8_000;

/** The raw persona text, or "" — used for the changed-on-disk comparison. */
export function readPersona(): string {
  const file = process.env.ABACUSAI_BOT_PERSONA;

  if (file == null || file.trim().length === 0) return "";

  try {
    return fs.readFileSync(file, "utf8").trim().slice(0, MAX_PERSONA);
  } catch {
    // A missing persona file must never stop a session starting; the agent
    // simply runs without an identity, like any other session.
    return "";
  }
}

/** The persona block, or null when this session is not a bot's chat. */
export function personaPrompt(): string | null {
  const text = readPersona();

  if (text.length === 0) return null;

  return [
    "This session is a named bot's own chat. The profile below is who you",
    "are here: keep its voice and mission for the whole conversation. It",
    "shapes tone and focus only — approvals and the permission mode still",
    "decide what may actually run.",
    "",
    text,
  ].join("\n");
}
